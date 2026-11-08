/**
 * อัปเดตเครื่องลูกค้าที่ติดตั้งจากแพ็กเกจ zip (ไม่มี git) — ดึงรุ่นใหม่จาก GitHub เอง ไม่ต้องส่งแพ็กเกจให้ทุกครั้ง
 *
 *   check()  ถามสาขาบน GitHub ว่า commit ล่าสุดคืออะไร (หน้า info/refs แบบเดียวกับ git ls-remote)
 *            + รายการที่เปลี่ยนจากฟีด commits.atom ของหน้าเว็บ — ไม่ใช้ GitHub API / key
 *   apply()  โหลด zip ของ commit นั้น (ปุ่ม Download ZIP ของ GitHub) → แตกในโฟลเดอร์ชั่วคราว → ตรวจว่าครบ
 *            → วางทับเฉพาะไฟล์โค้ดที่เปลี่ยน · ลบไฟล์ที่รุ่นใหม่ไม่มีแล้ว · ทำเมื่อไม่มีงานค้างเท่านั้น
 *
 * ไม่แตะของลูกค้า: config/project.config.json, .env, งานใน projects/, runtime/, เสียงที่ทำไว้ (กฎใน package-rules.js)
 * หลังวางทับ: selfupdate.js เห็นโค้ด bridge เปลี่ยนแล้วรีสตาร์ทเอง · extension reload ตัวเอง
 * snapshot() คืนรูปแบบเดียวกับตัวอัปเดตแบบ git (update.js) — แผงข้างใช้หน้าจอเดิมได้เลย
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { shipsToCustomer, isProtected, isCustomerData, USER_CONFIG, DEFAULT_CONFIG, customerDefaults, installerProblems } from './package-rules.js'

const CHECK_EVERY_MS = 30 * 60_000
const FIRST_CHECK_MS = 20_000
const MUST_HAVE = ['bridge/server.js', 'extension/manifest.json', 'pipeline/autopilot.mjs', 'package.json']

export function readVersion(cwd) {
  try {
    return JSON.parse(readFileSync(join(cwd, 'VERSION.json'), 'utf8'))
  } catch {
    return null
  }
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** commit ล่าสุดของสาขา — ถามแบบ git ls-remote ผ่าน https (repo public ไม่ต้องล็อกอิน) */
async function remoteHead(repo, branch, fetchFn) {
  const res = await fetchFn(`${repo}.git/info/refs?service=git-upload-pack`, { headers: { 'user-agent': 'git/2.45 cartoon-auto' }, signal: AbortSignal.timeout(30_000) })
  if (res.status === 401 || res.status === 404) throw new Error('GitHub ไม่ให้เข้าถึง repo (repo ถูกปิดเป็น private หรือเปลี่ยนชื่อ)')
  if (!res.ok) throw new Error(`GitHub ตอบ ${res.status}`)
  const text = await res.text()
  const ref = `refs/heads/${branch}`
  for (const line of text.split('\n')) {
    const m = /([0-9a-f]{40}) (\S+?)(?:\0|$)/.exec(line)
    if (m && m[2] === ref) return m[1]
  }
  throw new Error(`ไม่พบสาขา ${branch} บน GitHub`)
}

/** commit ล่าสุด 20 รายการจากฟีดของหน้าเว็บ (ใหม่ → เก่า) — ใช้แสดง "มีอะไรใหม่" เท่านั้น อ่านไม่ได้ก็อัปเดตได้ */
async function recentCommits(repo, branch, fetchFn) {
  try {
    const res = await fetchFn(`${repo}/commits/${branch}.atom`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return []
    const xml = await res.text()
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
      sha: /Commit\/([0-9a-f]{40})/.exec(e)?.[1] ?? '',
      subject: decode(/<title>\s*([\s\S]*?)\s*<\/title>/.exec(e)?.[1] ?? ''),
      date: /<updated>([^<]+)<\/updated>/.exec(e)?.[1] ?? null,
      author: decode(/<name>([^<]*)<\/name>/.exec(e)?.[1] ?? ''),
    })).filter((c) => c.sha)
  } catch {
    return []
  }
}

function untar(zip, dest) {
  // tar.exe ของ Windows 10+ แตก zip ได้ (tar ของ Git Bash แตกไม่ได้ — ระบุตัวของ Windows ตรงๆ)
  // Mac: tar ของระบบ (bsdtar) แตก zip ได้เหมือนกัน
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar'
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', dest], { windowsHide: true, timeout: 5 * 60_000 }, (err, _out, stderr) => (err ? reject(new Error(`แตกไฟล์อัปเดตไม่ได้: ${String(stderr || err.message).trim()}`)) : resolve()))
  })
}

function listFiles(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) listFiles(p, base, out)
    else out.push(p.slice(base.length + 1).replace(/\\/g, '/'))
  }
  return out
}

// แพ็กเกจสร้างจากเครื่องที่ git แปลงเป็น CRLF แต่ zip ของ GitHub เป็น LF — ต่างกันแค่การขึ้นบรรทัดถือว่าไฟล์เดิม
// ไม่งั้นอัปเดตครั้งแรกเขียนทับทุกไฟล์ และเตือนผิดๆ ว่าตัวเชื่อม Chrome เปลี่ยน ให้กด setup.exe ใหม่
// ไฟล์ข้อความ = ไม่มีไบต์ 0 ใน 8 KB แรก (วิธีเดียวกับ git) — ไม่ต้องไล่จำนามสกุล (.manifest เคยหลุด)
const isText = (buf) => !buf.subarray(0, 8000).includes(0)
const noCR = (buf) => Buffer.from(buf.filter((b) => b !== 0x0d))
const sameFile = (file, buf) => {
  try {
    const cur = readFileSync(file)
    return cur.equals(buf) || (isText(cur) && isText(buf) && noCR(cur).equals(noCR(buf)))
  } catch {
    return false
  }
}

/**
 * วางรุ่นใหม่ (โฟลเดอร์ที่แตกแล้ว) ทับโฟลเดอร์ติดตั้ง — ทำแบบ sync ทั้งก้อน
 * ตัวเฝ้าโค้ด (selfupdate.js) จึงไม่รีสตาร์ทกลางทางตอนไฟล์ยังวางไม่ครบ
 */
export function installTree(src, cwd, previousFiles = []) {
  const files = listFiles(src).filter(shipsToCustomer)
  const changed = []
  const failed = []
  const write = (rel, buf) => {
    const dest = join(cwd, rel)
    if (sameFile(dest, buf)) return
    try {
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, buf)
      // Mac: ไฟล์ที่ดับเบิลคลิก/Chrome เรียก (.command, .sh) ต้องรันได้ — writeFileSync สร้างไฟล์ใหม่แบบรันไม่ได้
      if (process.platform !== 'win32' && /\.(command|sh)$/.test(rel)) chmodSync(dest, 0o755)
      changed.push(rel)
    } catch (err) {
      failed.push(`${rel} (${err.code ?? err.message})`)
    }
  }
  for (const rel of files) {
    if (rel === USER_CONFIG || isProtected(rel)) continue
    if (isCustomerData(rel) && existsSync(join(cwd, rel))) continue // ข้อมูลของลูกค้า — ใส่เฉพาะไฟล์ที่ยังไม่มี
    write(rel, readFileSync(join(src, rel)))
  }
  // ค่าเริ่มต้นของลูกค้ามาจาก config ของเรา (ผ่านกฎเดียวกับตัวสร้างแพ็กเกจ) · ค่าที่ลูกค้าตั้งเองอยู่อีกไฟล์ ไม่ถูกแตะ
  if (existsSync(join(src, USER_CONFIG))) {
    const defaults = customerDefaults(JSON.parse(readFileSync(join(src, USER_CONFIG), 'utf8')))
    write(DEFAULT_CONFIG, Buffer.from(JSON.stringify(defaults, null, 2) + '\n'))
  }
  const shipped = files.filter((rel) => rel !== USER_CONFIG && !isCustomerData(rel)).sort()
  const keep = new Set(shipped)
  const removed = []
  for (const rel of previousFiles) {
    if (keep.has(rel) || isProtected(rel) || isCustomerData(rel) || rel === USER_CONFIG || rel === DEFAULT_CONFIG) continue
    const p = join(cwd, rel)
    if (!existsSync(p)) continue
    try {
      rmSync(p, { force: true })
      removed.push(rel)
    } catch (err) {
      failed.push(`ลบ ${rel} (${err.code ?? err.message})`)
    }
  }
  return { changed, removed, failed, shipped }
}

/**
 * อัปเดตไม่ได้เพราะมีงานค้าง — busy() คืนข้อความว่างานอะไร (เช่น "AI กำลังตรวจคลิปในคิวโพสต์") หรือแค่ true
 * บอกให้ชัด ผู้ใช้จะได้รู้ว่ารออะไร · ใช้ร่วมกับตัวอัปเดตแบบ git (update.js)
 */
export function busyMessage(why) {
  const what = typeof why === 'string' && why ? why : 'กำลังทำคลิปหรือมีงานค้างอยู่'
  return `${what} — อัปเดตเมื่องานนี้เสร็จ (ลองกดใหม่อีกสักครู่) หรือกดหยุดก่อน · อัปเดตกลางงานโปรแกรมจะรีสตาร์ทระหว่างทำ`
}

/** fetchFn ให้เทสต์แทนที่ได้ · followUps มาจาก update.js (คำเตือนตามไฟล์ที่เปลี่ยน) */
export function createPackageUpdater({ log = () => {}, busy = () => false, cwd, schedule = true, fetchFn = fetch, followUps = () => [] }) {
  const version = () => readVersion(cwd)
  const state = {
    mode: 'package',
    supported: !!version()?.repo,
    checking: false,
    applying: false,
    checkedAt: null,
    branch: version()?.branch ?? 'main',
    upstream: version()?.repo ?? null,
    latest: null,
    behind: 0,
    ahead: 0,
    commits: [],
    files: [],
    notes: [],
    dirty: [],
    error: null,
    applied: null,
  }

  function snapshot(error) {
    if (error !== undefined) {
      state.error = error
      state.checkedAt = Date.now()
    }
    return { ...state, available: state.supported && !state.error && state.behind > 0 }
  }

  async function check() {
    const v = version()
    if (!v?.repo) {
      state.supported = false
      return snapshot(`ติดตั้งจากแพ็กเกจรุ่นเก่า (${v?.commit ?? 'ไม่ทราบรุ่น'}) ที่ยังอัปเดตเองไม่ได้ — ขอแพ็กเกจรุ่นใหม่มาวางทับครั้งเดียว หลังจากนั้นอัปเดตเองได้`)
    }
    if (state.checking || state.applying) return snapshot()
    state.checking = true
    try {
      const current = v.sha ?? v.commit
      const head = await remoteHead(v.repo, v.branch ?? 'main', fetchFn)
      state.latest = head
      if (head.startsWith(current)) {
        Object.assign(state, { behind: 0, commits: [], notes: [], error: null, checkedAt: Date.now() })
        return snapshot()
      }
      const recent = await recentCommits(v.repo, v.branch ?? 'main', fetchFn)
      // ติดตั้งจาก ZIP ของ GitHub (setup สร้าง VERSION.json ให้ แต่ไม่รู้ว่าเป็น commit ไหน) → อัปเดตครั้งแรกให้รู้รุ่นแน่นอน
      const unknown = !v.sha && !/^[0-9a-f]{7,40}$/.test(String(v.commit ?? ''))
      const at = unknown ? -1 : recent.findIndex((c) => c.sha.startsWith(current))
      const commits = at >= 0 ? recent.slice(0, at) : unknown ? recent.slice(0, 5) : recent
      state.behind = Math.max(1, commits.length)
      state.commits = commits.map(({ sha, date, author, subject }) => ({ sha: sha.slice(0, 7), date, author, subject }))
      state.notes = unknown
        ? ['ติดตั้งจาก ZIP ของ GitHub — ยังไม่รู้รุ่นในเครื่อง กดอัปเดตครั้งเดียวให้เป็นรุ่นล่าสุด (ค่าที่ตั้งไว้ไม่หาย)']
        : at < 0 && recent.length ? [`รุ่นในเครื่องเก่ากว่า ${recent.length} รายการล่าสุด`] : []
      state.error = null
      state.checkedAt = Date.now()
      return snapshot()
    } catch (err) {
      const msg = String(err?.cause?.code ?? err?.message ?? err)
      return snapshot(/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|aborted|timeout/i.test(msg) ? 'ต่อ GitHub ไม่ได้ — ตรวจอินเทอร์เน็ตแล้วลองใหม่' : msg)
    } finally {
      state.checking = false
    }
  }

  async function apply() {
    await check()
    if (state.error) throw new Error(state.error)
    if (!state.behind) return snapshot()
    const why = busy()
    if (why) throw new Error(busyMessage(why))

    const v = version()
    const sha = state.latest
    const count = state.behind
    const tmp = join(cwd, '.update-tmp')
    state.applying = true
    try {
      log(`อัปเดตจาก GitHub ${count} รายการ (${(v.sha ?? v.commit).slice(0, 7)} → ${sha.slice(0, 7)})`)
      rmSync(tmp, { recursive: true, force: true })
      mkdirSync(join(tmp, 'x'), { recursive: true })
      const zipUrl = `${v.repo.replace('https://github.com/', 'https://codeload.github.com/')}/zip/${sha}`
      const res = await fetchFn(zipUrl, { signal: AbortSignal.timeout(10 * 60_000) })
      if (!res.ok) throw new Error(`โหลดรุ่นใหม่จาก GitHub ไม่ได้ (${res.status})`)
      const zip = join(tmp, 'update.zip')
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
      await untar(zip, join(tmp, 'x'))
      const top = readdirSync(join(tmp, 'x'), { withFileTypes: true }).find((e) => e.isDirectory())
      if (!top) throw new Error('ไฟล์อัปเดตว่างเปล่า')
      const src = join(tmp, 'x', top.name)

      // ตรวจก่อนแตะเครื่องลูกค้า — ไม่ครบ = ไม่เปลี่ยนอะไรเลย
      const missing = MUST_HAVE.filter((f) => !existsSync(join(src, f)))
      const bad = [...missing.map((f) => `ไม่มี ${f}`), ...installerProblems((f) => (existsSync(join(src, f)) ? readFileSync(join(src, f)) : null))]
      if (bad.length) throw new Error(`รุ่นใหม่บน GitHub ไม่ครบ ระบบไม่ได้เปลี่ยนอะไร: ${bad.join(' · ')}`)

      const { changed, removed, failed, shipped } = installTree(src, cwd, v.files ?? [])
      if (failed.length) {
        // บางไฟล์เขียนไม่ได้ (ถูกเปิดค้าง/ถูกล็อก) — ไม่บันทึกว่าเป็นรุ่นใหม่ ตรวจรอบหน้าจะเสนออัปเดตซ้ำ
        log(`อัปเดตไม่ครบ: ${failed.join(', ')}`)
        throw new Error(`อัปเดตได้ไม่ครบ ${failed.length} ไฟล์ (${failed.slice(0, 3).join(', ')}) — ปิดโปรแกรมที่เปิดไฟล์นั้นอยู่แล้วกดอัปเดตอีกครั้ง`)
      }
      writeFileSync(join(cwd, 'VERSION.json'), JSON.stringify({ ...v, commit: sha.slice(0, 7), sha, dirty: false, updatedAt: new Date().toISOString(), files: shipped }, null, 2) + '\n')
      const notes = followUps([...changed, ...removed])
      state.applied = { at: Date.now(), from: (v.sha ?? v.commit).slice(0, 7), to: sha.slice(0, 7), count, stashKept: false, notes }
      log(`อัปเดตแล้ว → ${sha.slice(0, 7)} · เปลี่ยน ${changed.length} ไฟล์${removed.length ? ` · ลบ ${removed.length} ไฟล์` : ''}${notes.length ? ` · ${notes.join(' · ')}` : ''}`)
    } catch (err) {
      if (!/อัปเดตได้ไม่ครบ/.test(err.message)) log(`อัปเดตไม่สำเร็จ: ${err.message}`)
      throw err
    } finally {
      rmSync(tmp, { recursive: true, force: true })
      state.applying = false
    }
    return check()
  }

  if (schedule && state.supported) {
    setTimeout(() => check().catch(() => {}), FIRST_CHECK_MS).unref?.()
    setInterval(() => check().catch(() => {}), CHECK_EVERY_MS).unref?.()
  }

  return { check, apply, snapshot: () => snapshot() }
}
