import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * แปลงชื่อไฟล์ภาพกลับเป็นวินาที — `00_01_23.png` → 83, `00_00_02_5.png` → 2.5
 * (กฎ 4 ของ Blueprint: ชื่อไฟล์ = timecode ทำให้ขั้นตัดต่อไม่ต้องพึ่งไฟล์ metadata ใดๆ)
 */
export function parseTimecodeFilename(name) {
  const m = name.match(/^(\d{2})_(\d{2})_(\d{2})(?:_(\d))?\.(png|jpg|jpeg|webp)$/i)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4]) / 10 : 0)
}

/** อ่านโฟลเดอร์ภาพ → รายการเรียงตามเวลา พร้อมรายงานไฟล์ที่ตั้งชื่อผิดรูป */
export function collectImages(dir) {
  const all = readdirSync(dir)
  const images = []
  const ignored = []
  for (const name of all) {
    const start = parseTimecodeFilename(name)
    if (start == null) {
      if (/\.(png|jpg|jpeg|webp)$/i.test(name) && !/^cover\./i.test(name)) ignored.push(name) // cover.png = ภาพปก ไม่อยู่ในไทม์ไลน์
      continue
    }
    images.push({ file: join(dir, name), name, start })
  }
  images.sort((a, b) => a.start - b.start)
  return { images, ignored }
}
