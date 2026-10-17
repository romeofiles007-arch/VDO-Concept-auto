import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * แพ็กเกจสำหรับลูกค้าแถม node / ffmpeg / python ไว้ใน runtime/ (สร้างด้วย scripts/build-package.mjs)
 * ใส่ไว้หน้า PATH ตั้งแต่ตอนโหลดโมดูลนี้ — ทุกขั้นที่เรียก 'ffmpeg' / 'ffprobe' และ process ลูกทั้งหมด
 * จึงหาเจอโดยลูกค้าไม่ต้องติดตั้งอะไร · เครื่องที่ไม่มี runtime/ (เครื่องพัฒนา) ใช้ของในเครื่องตามเดิม
 */
export const RUNTIME = join(ROOT, 'runtime')
for (const dir of ['ffmpeg', 'node']) {
  const p = join(RUNTIME, dir)
  if (existsSync(p) && !(process.env.PATH ?? '').split(';').includes(p)) process.env.PATH = `${p};${process.env.PATH ?? ''}`
}

/**
 * การตั้งค่ามี 2 ไฟล์ในแพ็กเกจลูกค้า:
 *   config/default.config.json   ค่าเริ่มต้นที่มากับแพ็กเกจ — ถูกทับได้ทุกครั้งที่ลูกค้าวางแพ็กเกจรุ่นใหม่
 *   config/project.config.json   ค่าที่ลูกค้าตั้งเอง — แพ็กเกจไม่มีไฟล์นี้ วางทับแล้วค่าของลูกค้าจึงไม่หาย
 * ค่าของลูกค้าชนะ · key ที่รุ่นใหม่เพิ่มมา (ลูกค้ายังไม่มี) ได้จากค่าเริ่มต้น
 * เครื่องพัฒนาไม่มี default.config.json → อ่าน project.config.json ไฟล์เดียวเหมือนเดิม
 */
export const CONFIG_FILE = join(ROOT, 'config', 'project.config.json')
export const DEFAULT_CONFIG_FILE = join(ROOT, 'config', 'default.config.json')

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v)
function withDefaults(defaults, user) {
  const out = { ...defaults }
  for (const [k, v] of Object.entries(user)) out[k] = isObject(v) && isObject(defaults[k]) ? withDefaults(defaults[k], v) : v
  return out
}

export function loadConfig() {
  const hasDefaults = existsSync(DEFAULT_CONFIG_FILE)
  if (!hasDefaults) return readJson(CONFIG_FILE)
  const defaults = readJson(DEFAULT_CONFIG_FILE)
  return existsSync(CONFIG_FILE) ? withDefaults(defaults, readJson(CONFIG_FILE)) : defaults
}

/** แก้การตั้งค่าแล้วบันทึกลงไฟล์ของผู้ใช้ — ทุกที่ที่เขียน config ต้องผ่านตรงนี้ */
export function updateConfig(mutate) {
  const config = loadConfig()
  mutate(config)
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
  return config
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
