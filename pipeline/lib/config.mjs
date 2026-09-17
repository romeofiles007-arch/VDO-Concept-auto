import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function loadConfig() {
  return JSON.parse(readFileSync(join(ROOT, 'config/project.config.json'), 'utf8'))
}

/** path ใน config อ้างอิงจากโฟลเดอร์โปรเจกต์ — ย้ายทั้งโฟลเดอร์ไปเครื่องอื่นได้ */
export const fromRoot = (p) => (isAbsolute(p) ? p : join(ROOT, p))

/** python ของระบบเสียงในเครื่อง (F5-TTS-THAI, Whisper, Edge TTS) — ติดตั้งด้วย scripts/setup-tts.ps1 */
export function ttsPython(config = loadConfig()) {
  return fromRoot(config.tts.myVoice?.python || join(config.tts.pythonVenv ?? 'tts/.venv', 'Scripts', 'python.exe'))
}

export const STAGES = {
  script: '01_script',
  audio: '02_audio',
  timecode: '03_timecode',
  shotlist: '04_shotlist',
  images: '05_images',
  render: '06_render',
}

/** โฟลเดอร์ทำงานของคลิปหนึ่งคลิป — สร้างครบทุก stage ถ้ายังไม่มี */
export function projectDir(slug, stage) {
  const base = join(ROOT, 'projects', slug)
  if (!existsSync(base)) for (const s of Object.values(STAGES)) mkdirSync(join(base, s), { recursive: true })
  if (!stage) return base
  const dir = join(base, STAGES[stage] ?? stage)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ชื่อไฟล์ต้องตรงกันทั้ง pipeline และแผงข้างของ extension — ตัวจริงอยู่ที่ extension/prompts.js
export { slugify } from '../../extension/prompts.js'
