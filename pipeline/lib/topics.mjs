/** หัวข้อที่ทำไปแล้ว + หัวข้อที่เคยเสนอ — ใช้กันไม่ให้ระบบเสนอ/เลือกเรื่องซ้ำ */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './config.mjs'

export function listDoneTitles() {
  const root = join(ROOT, 'projects')
  if (!existsSync(root)) return []
  const titles = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    const file = join(root, entry.name, '01_script', 'title.txt')
    if (existsSync(file)) titles.push(readFileSync(file, 'utf8').trim())
  }
  return titles.filter(Boolean)
}

// ทุกครั้งที่ขอหัวข้อ ChatGPT เปิดแชตใหม่ จำไม่ได้ว่าเคยเสนออะไร → เก็บไว้เองแล้วส่งไปให้เลี่ยง
const SEEN_FILE = join(ROOT, 'projects', '_topic_history.json')
const SEEN_KEEP = 120

/** หัวข้อที่เคยเสนอ (ใหม่สุดก่อน) */
export function listSeenTitles() {
  try {
    return existsSync(SEEN_FILE) ? JSON.parse(readFileSync(SEEN_FILE, 'utf8')).map((x) => x.title).filter(Boolean) : []
  } catch {
    return []
  }
}

export function addSeenTitles(titles) {
  const now = Date.now()
  const old = existsSync(SEEN_FILE) ? (() => { try { return JSON.parse(readFileSync(SEEN_FILE, 'utf8')) } catch { return [] } })() : []
  const fresh = titles.map((title) => String(title ?? '').trim()).filter(Boolean)
  const merged = [...fresh.map((title) => ({ title, at: now })), ...old.filter((x) => !fresh.includes(x.title))].slice(0, SEEN_KEEP)
  mkdirSync(join(ROOT, 'projects'), { recursive: true })
  writeFileSync(SEEN_FILE, JSON.stringify(merged, null, 1))
  return merged.length
}
