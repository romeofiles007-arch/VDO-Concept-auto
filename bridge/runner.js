/**
 * รันขั้นของ pipeline จากหน้า UI — เรียกสคริปต์ตัวเดียวกับที่รันจาก terminal
 * แล้วเก็บ log ไว้ให้หน้าเว็บ poll ไปแสดง ผลลัพธ์จึงเหมือนรันเองทุกอย่าง
 *
 * รันได้ทีละงาน: ขั้น 4-5 ต้องใช้แท็บเบราว์เซอร์ตัวเดียวกัน และขั้น 2 กิน GPU เต็ม
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ROOT } from '../pipeline/lib/config.mjs'

const MAX_LINES = 400

export const STEPS = {
  tts: { label: 'ทำเสียงพากย์', cmd: (slug) => ['node', ['pipeline/2_tts.mjs', slug]] },
  timecode: { label: 'ทำ Timecode', cmd: (slug) => ['node', ['pipeline/3_timecode.mjs', slug]] },
  shotlist: { label: 'เขียน Shot List', cmd: (slug) => ['node', ['pipeline/4_shotlist.mjs', slug]] },
  images: { label: 'สร้างภาพ', cmd: (slug) => ['node', ['pipeline/5_images.mjs', slug]] },
  render: {
    label: 'ตัดต่อวิดีโอ',
    cmd: (slug, { bgm } = {}) => ['node', ['pipeline/6_render.mjs', slug, ...(bgm ? ['--bgm', bgm] : [])]],
  },
  importAudio: {
    label: 'นำเข้าและถอดเสียงพากย์',
    cmd: (slug, { file, language } = {}) => ['node', ['pipeline/import_audio.mjs', slug, file, '--language', language ?? 'th']],
  },
  trainVoice: {
    label: 'เทรนเสียง',
    cmd: (_slug, { voice, epochs } = {}) => ['node', ['pipeline/train_voice.mjs', voice, '--epochs', String(epochs)]],
  },
  cover: { label: 'สร้างภาพปกคลิป', cmd: (slug) => ['node', ['pipeline/5_images.mjs', slug, '--cover-only']] },
  retime: { label: 'ปรับช่วงเงียบ', cmd: (slug) => ['node', ['pipeline/retime_audio.mjs', slug]] },
  autopilot: {
    label: 'ทำคลิปอัตโนมัติ',
    cmd: (_slug, { title, autoTopic, genre, language, titleLanguage, minutes } = {}) => [
      'node',
      ['pipeline/autopilot.mjs', ...(autoTopic ? ['--auto-topic', ...(genre ? ['--genre', genre] : [])] : [title]), '--lang', language, '--title-lang', titleLanguage, '--minutes', String(minutes)],
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
          const line = { text, progress: m[0] === CR }
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
      run.lines.push({ text: `เริ่มไม่ได้: ${err.message}` })
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

  function stop() {
    if (current?.status !== 'running') return snapshot()
    current.status = 'stopped'
    current.endedAt = Date.now()
    // taskkill /T ปิดทั้งต้นไม้ — ขั้น 2 มี python ลูกที่ kill() ธรรมดาไม่โดน
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(current.proc.pid), '/T', '/F'], { windowsHide: true })
    else current.proc.kill()
    current.lines.push({ text: 'หยุดแล้ว' })
    return snapshot()
  }

  function snapshot() {
    if (!current) return null
    const { proc, ...rest } = current
    return { ...rest, label: STEPS[rest.step].label, lines: rest.lines.map((l) => l.text) }
  }

  return { start, stop, snapshot }
}
