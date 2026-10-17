/**
 * รันขั้นของ pipeline จากหน้า UI — เรียกสคริปต์ตัวเดียวกับที่รันจาก terminal
 * แล้วเก็บ log ไว้ให้หน้าเว็บ poll ไปแสดง ผลลัพธ์จึงเหมือนรันเองทุกอย่าง
 *
 * รันได้ทีละงาน: ขั้น 4-5 ต้องใช้แท็บเบราว์เซอร์ตัวเดียวกัน และขั้น 2 กิน GPU เต็ม
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ROOT } from '../pipeline/lib/config.mjs'

// process.execPath แทน 'node' — แพ็กเกจลูกค้าใช้ node ที่แถมไว้ใน runtime/ ซึ่งอาจไม่อยู่ใน PATH ของเครื่อง
const MAX_LINES = 400

export const STEPS = {
  tts: { label: 'ทำเสียงพากย์', cmd: (slug) => [process.execPath, ['pipeline/2_tts.mjs', slug]] },
  timecode: { label: 'ทำ Timecode', cmd: (slug) => [process.execPath, ['pipeline/3_timecode.mjs', slug]] },
  shotlist: { label: 'เขียน Shot List', cmd: (slug) => [process.execPath, ['pipeline/4_shotlist.mjs', slug]] },
  images: { label: 'สร้างภาพ', cmd: (slug) => [process.execPath, ['pipeline/5_images.mjs', slug]] },
  clips: { label: 'ทำแอนิเมชัน Kie', cmd: (slug) => [process.execPath, ['pipeline/5b_clips.mjs', slug]] },
  render: {
    label: 'ตัดต่อวิดีโอ',
    cmd: (slug, { bgm } = {}) => [process.execPath, ['pipeline/6_render.mjs', slug, ...(bgm ? ['--bgm', bgm] : [])]],
  },
  importAudio: {
    label: 'นำเข้าและถอดเสียงพากย์',
    cmd: (slug, { file, language } = {}) => [process.execPath, ['pipeline/import_audio.mjs', slug, file, '--language', language ?? 'th']],
  },
  trainVoice: {
    label: 'เทรนเสียง',
    cmd: (_slug, { voice, epochs } = {}) => [process.execPath, ['pipeline/train_voice.mjs', voice, '--epochs', String(epochs)]],
  },
  cover: { label: 'สร้างภาพปกคลิป', cmd: (slug) => [process.execPath, ['pipeline/5_images.mjs', slug, '--cover-only']] },
  retime: { label: 'ปรับช่วงเงียบ', cmd: (slug) => [process.execPath, ['pipeline/retime_audio.mjs', slug]] },
  autopilot: {
    label: 'ทำคลิปอัตโนมัติ',
    cmd: (_slug, { title, autoTopic, genre, language, titleLanguage, minutes, restartFrom } = {}) => [
      process.execPath,
      ['pipeline/autopilot.mjs', ...(autoTopic ? ['--auto-topic', ...(genre ? ['--genre', genre] : [])] : [title]), '--lang', language, '--title-lang', titleLanguage, '--minutes', String(minutes), ...(restartFrom ? ['--restart', restartFrom] : [])],
    ],
  },
  setupTts: {
    label: 'ติดตั้งระบบเสียง',
    cmd: () => ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join('scripts', 'setup-tts.ps1')]],
  },
}

const CR = '\r'
const LINE_BREAK = /[\r\n]/

export function createRunner({ log }) {
  let current = null // { step, slug, status, lines, exitCode, startedAt, endedAt, proc }

  /**
   * สคริปต์เขียน progress ด้วย CR ทับบรรทัดเดิม — ข้อความที่ตามหลัง CR จึงแทนที่บรรทัด progress ก่อนหน้า
   * แทนการต่อบรรทัดใหม่ทุกครั้ง ไม่งั้น log ขั้น TTS จะมีหลายร้อยบรรทัดของตัวเลขนับ
   */
  function reader(run) {
    let pending = ''
    let overwrite = false
    return (chunk) => {
      pending += chunk.toString('utf8')
      let m
      while ((m = LINE_BREAK.exec(pending))) {
        const text = pending.slice(0, m.index)
        pending = pending.slice(m.index + 1)
        // autopilot เลือกหัวข้อเองแล้วแจ้ง slug กลับมา — ไม่ต้องแสดงบรรทัดนี้
        if (text.startsWith('@@autopilot ')) {
          try {
            Object.assign(run, { slug: JSON.parse(text.slice(12)).slug, title: JSON.parse(text.slice(12)).title })
          } catch {}
          overwrite = false
          continue
        }
        if (text.trim()) {
          const lines = run.lines
          const line = { text, progress: m[0] === CR, at: Date.now() }
          if (overwrite && lines.at(-1)?.progress) lines[lines.length - 1] = line
          else lines.push(line)
          if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
        }
        overwrite = m[0] === CR
      }
    }
  }

  function start(step, slug, opts) {
    if (current?.status === 'running') throw new Error(`กำลัง${STEPS[current.step].label}อยู่ — รอให้เสร็จก่อน`)
    const def = STEPS[step]
    if (!def) throw new Error(`ไม่รู้จักขั้น ${step}`)
    const [bin, args] = def.cmd(slug, opts)

    const proc = spawn(bin, args, { cwd: ROOT, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' } })
    current = { step, slug, status: 'running', lines: [], exitCode: null, startedAt: Date.now(), endedAt: null, proc }
    const run = current
    log(`เริ่ม ${def.label} (${slug ?? '-'})`)

    const onData = reader(run)
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('error', (err) => {
      run.lines.push({ text: `เริ่มไม่ได้: ${err.message}`, at: Date.now() })
      run.status = 'error'
      run.endedAt = Date.now()
    })
    proc.on('close', (code) => {
      if (run.status !== 'running') return
      run.exitCode = code
      run.status = code === 0 ? 'done' : 'error'
      run.endedAt = Date.now()
      log(`${def.label} ${code === 0 ? 'เสร็จ' : `ล้มเหลว (exit ${code})`}`)
    })
    return snapshot()
  }

  /** ปิดทั้งต้นไม้ของ process — ขั้น 2 มี python ลูก autopilot มีขั้นย่อยเป็น node ลูก ที่ kill() ธรรมดาไม่โดน */
  function killTree(proc) {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
    else proc.kill('SIGKILL')
  }

  function stop() {
    if (current?.status !== 'running') return snapshot()
    const run = current
    run.status = 'stopped'
    run.endedAt = Date.now()
    killTree(run.proc)
    run.lines.push({ text: 'หยุดแล้ว', at: Date.now() })
    // ตรวจว่าตายจริง — ถ้าสั่งแล้วไม่ตาย process จะทำต่อจนจบเงียบๆ ทั้งที่หน้าจอบอกว่าหยุดแล้ว
    const check = (tries) => setTimeout(() => {
      if (run.proc.exitCode !== null || run.proc.signalCode !== null) return
      log(`${STEPS[run.step].label} ยังไม่หยุดหลังสั่ง — สั่งปิดซ้ำ (${tries})`)
      killTree(run.proc)
      try { process.kill(run.proc.pid, 'SIGKILL') } catch {}
      if (tries < 5) check(tries + 1)
      else run.lines.push({ text: `⚠️ ปิดโปรแกรมขั้นนี้ไม่ได้ (PID ${run.proc.pid}) — เปิด Task Manager แล้วปิด node.exe ตัวนี้เอง`, at: Date.now() })
    }, 3000)
    check(1)
    return snapshot()
  }

  function snapshot() {
    if (!current) return null
    const { proc, ...rest } = current
    // entries: บรรทัดพร้อมเวลา สำหรับหน้าต่าง log แบบ terminal ในแผงข้าง (lines คงไว้ให้โค้ดเดิม)
    return { ...rest, label: STEPS[rest.step].label, lines: rest.lines.map((l) => l.text), entries: rest.lines.map((l) => ({ at: l.at, text: l.text, progress: !!l.progress })) }
  }

  return { start, stop, snapshot }
}
