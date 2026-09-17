/** หัวข้อที่ทำไปแล้ว — ใช้กันไม่ให้ระบบเสนอ/เลือกเรื่องซ้ำ */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
