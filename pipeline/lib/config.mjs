import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function loadConfig() {
  return JSON.parse(readFileSync(join(ROOT, 'config/project.config.json'), 'utf8'))
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

/** `my topic!` → `my_topic` ใช้เป็นชื่อโฟลเดอร์และชื่อไฟล์ script */
export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
}
