/**
 * ตรวจอัปเดตจาก GitHub — เทียบโค้ดในเครื่องกับ origin ด้วย git ล้วน ไม่ใช้ GitHub API / key
 *
 *   check()  git fetch → นับว่าเครื่องนี้ตามหลัง (behind) / นำหน้า (ahead) กี่ commit + รายการที่จะได้
 *   apply()  git pull --ff-only --autostash — ทำเมื่อไม่มีงานค้างเท่านั้น
 *
 * หลังอัปเดต ไม่ต้องปิดเปิดอะไรเอง: selfupdate.js เห็นโค้ด bridge เปลี่ยนแล้วรีสตาร์ทเมื่อว่าง
 * และ extension reload ตัวเองเมื่อไฟล์ใน extension/ เปลี่ยน (background.js → checkExtensionUpdate)
 *
 * ปฏิเสธแทนที่จะเดา: มีงานค้าง / เครื่องนี้มี commit ที่ยังไม่ได้ push / ไม่ใช่ fast-forward
 * การตั้งค่าที่แก้ไว้ในเครื่อง (config, ประวัติหัวข้อ) ถูกพักไว้ด้วย --autostash แล้วใส่คืนหลังอัปเดต
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../pipeline/lib/config.mjs'

const CHECK_EVERY_MS = 30 * 60_000
const FIRST_CHECK_MS = 20_000
const MAX_COMMITS = 20

function git(cwd, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout,
      windowsHide: true,
      encoding: 'utf8',
      // ห้ามให้ git เปิดหน้าต่างถามรหัส — ค้างรอผู้ใช้ที่มองไม่เห็นหน้าต่าง
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    // trimEnd เท่านั้น — ช่องว่างหน้าบรรทัดของ git status เป็นส่วนของรูปแบบ (' M ไฟล์') ตัดทิ้งแล้วชื่อไฟล์แหว่ง
    }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout ?? '').trimEnd(), stderr: String(stderr ?? '').trim() }))
  })
}

/** ข้อความ git ภาษาอังกฤษ → สาเหตุที่ผู้ใช้แก้ได้ */
function explain(stderr) {
  if (/could not resolve host|unable to access|timed out|network/i.test(stderr)) return 'ต่อ GitHub ไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองใหม่'
  if (/authentication|could not read username|permission denied|403/i.test(stderr)) return 'GitHub ไม่ให้เข้าถึง repo (ต้องล็อกอิน หรือ repo ถูกปิดเป็น private)'
  if (/would be overwritten|conflict/i.test(stderr)) return 'ไฟล์ที่แก้ไว้ในเครื่องชนกับไฟล์ในอัปเดต — ระบบไม่ได้เปลี่ยนอะไร ให้คนที่ดูแลโค้ดช่วยรวมให้'
  if (/not possible to fast-forward|diverg/i.test(stderr)) return 'โค้ดในเครื่องแยกทางกับ GitHub — อัปเดตอัตโนมัติไม่ได้'
  return stderr.split(/\r?\n/).filter(Boolean).pop() ?? 'git ล้มเหลว'
}

/** ไฟล์ในอัปเดตที่ต้องทำอะไรเพิ่มหลังดึง — บอกล่วงหน้าบนปุ่มอัปเดต */
function followUps(files) {
  const notes = []
  if (files.some((f) => /^tts\/requirements\.txt$|^scripts\/setup-tts\.ps1$/.test(f))) notes.push('ระบบเสียงในเครื่องมีของใหม่ — หลังอัปเดตกด "ตรวจความพร้อม" แล้วติดตั้งเพิ่ม')
  if (files.some((f) => /^native\//.test(f))) notes.push('ตัวเชื่อม Chrome เปลี่ยน — หลังอัปเดตดับเบิลคลิก ติดตั้งครั้งแรก.bat อีกครั้ง')
  if (files.some((f) => /^extension\/manifest\.json$/.test(f))) notes.push('สิทธิ์ของ extension เปลี่ยน — Chrome อาจถามยืนยันสิทธิ์ใหม่')
  return notes
}

/** cwd / schedule มีไว้ให้เทสต์ชี้ไป repo จำลองโดยไม่ตั้งเวลาตรวจเอง */
export function createUpdater({ log, busy, cwd = ROOT, schedule = true }) {
  const run = (args, opts) => git(cwd, args, opts)
  const state = {
    supported: existsSync(join(cwd, '.git')),
    checking: false,
    applying: false,
    checkedAt: null,
    branch: null,
    upstream: null,
    behind: 0,
    ahead: 0,
    commits: [],
    files: [],
    notes: [],
    dirty: [],
    error: null,
    applied: null, // { at, from, to, count } อัปเดตครั้งล่าสุด
  }

  async function check() {
    if (!state.supported) {
      // แพ็กเกจลูกค้า (scripts/build-package.mjs) ไม่มี .git แต่มี VERSION.json บอกรุ่น
      let version = null
      try { version = JSON.parse(readFileSync(join(cwd, 'VERSION.json'), 'utf8')) } catch {}
      return snapshot(version
        ? `ติดตั้งจากแพ็กเกจ (รุ่น ${version.commit}) — อัปเดตโดยขอแพ็กเกจรุ่นใหม่ ดับเบิลคลิก ปิดโปรแกรม.bat แล้ววางทับโฟลเดอร์เดิม (การตั้งค่าไม่หาย)`
        : 'โฟลเดอร์นี้ไม่ได้ติดตั้งด้วย git (คัดลอกมาเป็นไฟล์) — อัปเดตอัตโนมัติไม่ได้ ดาวน์โหลดใหม่จาก GitHub แทน')
    }
    if (state.checking || state.applying) return snapshot()
    state.checking = true
    try {
      const upstream = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      if (!upstream.ok) return snapshot('สาขานี้ไม่ได้ผูกกับ GitHub (ไม่มี upstream)')
      state.upstream = upstream.stdout
      state.branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout
      const [remote, ...rest] = state.upstream.split('/')
      const fetched = await run(['fetch', '--quiet', remote, rest.join('/')], { timeout: 45_000 })
      if (!fetched.ok) return snapshot(explain(fetched.stderr))

      const counts = (await run(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).stdout.split(/\s+/).map(Number)
      state.ahead = counts[0] || 0
      state.behind = counts[1] || 0
      const history = state.behind
        ? (await run(['log', 'HEAD..@{u}', `-n${MAX_COMMITS}`, '--format=%h%x09%cI%x09%an%x09%s'])).stdout
        : ''
      state.commits = history ? history.split(/\r?\n/).map((l) => {
        const [sha, date, author, ...subject] = l.split('\t')
        return { sha, date, author, subject: subject.join('\t') }
      }) : []
      state.files = state.behind ? (await run(['diff', '--name-only', 'HEAD', '@{u}'])).stdout.split(/\r?\n/).filter(Boolean) : []
      state.notes = followUps(state.files)
      // ไฟล์ที่ git ติดตามอยู่และถูกแก้ในเครื่อง — บอกผู้ใช้ว่าระบบพักไว้ให้ ไม่ได้ทิ้ง
      state.dirty = (await run(['status', '--porcelain', '--untracked-files=no'])).stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3))
      state.error = null
      state.checkedAt = Date.now()
      return snapshot()
    } finally {
      state.checking = false
    }
  }

  async function apply() {
    await check()
    if (state.error) throw new Error(state.error)
    if (!state.behind) return snapshot()
    if (state.ahead) throw new Error(`เครื่องนี้มีงาน ${state.ahead} commit ที่ยังไม่ได้ส่งขึ้น GitHub — อัปเดตอัตโนมัติจะทับกัน ให้ push ก่อน`)
    if (busy()) throw new Error('กำลังทำคลิปหรือมีงานค้างอยู่ — อัปเดตเมื่อทำเสร็จหรือกดหยุดก่อน (อัปเดตกลางงานโปรแกรมจะรีสตาร์ทระหว่างทำ)')

    state.applying = true
    const from = (await run(['rev-parse', '--short', 'HEAD'])).stdout
    const count = state.behind
    const stashes = async () => (await run(['stash', 'list'])).stdout.split(/\r?\n/).filter(Boolean).length
    const stashBefore = await stashes()
    try {
      log(`อัปเดตจาก GitHub ${count} commit (${from} → ${state.upstream})`)
      const pulled = await run(['pull', '--ff-only', '--autostash'], { timeout: 120_000 })
      if (!pulled.ok) {
        log(`อัปเดตไม่สำเร็จ: ${pulled.stderr}`)
        throw new Error(explain(pulled.stderr))
      }
      const to = (await run(['rev-parse', '--short', 'HEAD'])).stdout
      // ไฟล์ที่แก้ในเครื่องชนกับอัปเดต → git ใส่คืนไม่ได้แต่เก็บไว้ใน stash (ไม่หาย) — นับ stash ก่อน/หลังแทนการเดาข้อความของ git
      const leftStash = (await stashes()) > stashBefore
      state.applied = { at: Date.now(), from, to, count, stashKept: leftStash }
      log(`อัปเดตแล้ว ${from} → ${to}${leftStash ? ' · ไฟล์ที่แก้ในเครื่องบางไฟล์ชนกับอัปเดต — เก็บไว้ใน git stash' : ''}`)
    } finally {
      state.applying = false
    }
    return check()
  }

  function snapshot(error) {
    if (error !== undefined) {
      state.error = error
      state.checkedAt = Date.now()
    }
    return { ...state, available: state.supported && !state.error && state.behind > 0 }
  }

  // ตรวจครั้งแรกหลังเปิดโปรแกรมสักพัก (ไม่แย่งเวลาตอนบูต) แล้วทุก 30 นาที
  if (schedule) {
    setTimeout(() => check().catch(() => {}), FIRST_CHECK_MS).unref?.()
    setInterval(() => check().catch(() => {}), CHECK_EVERY_MS).unref?.()
  }

  return { check, apply, snapshot: () => snapshot() }
}
