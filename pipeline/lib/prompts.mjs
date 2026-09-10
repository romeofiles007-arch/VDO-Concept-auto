import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './config.mjs'

/** Blueprint คือแหล่งความจริงเดียวของกติกาทั้งหมด — ส่งไปทั้งฉบับทุกครั้ง ไม่สรุปย่อ */
export function blueprint(config) {
  return readFileSync(join(ROOT, config.blueprint), 'utf8')
}

export function topicsPrompt(config) {
  return `${blueprint(config)}

═══════════════════════════════════════
ทำ STAGE 1 ตามเอกสารข้างบนเท่านั้น

แสดง 5 หัวข้อ viral ในตาราง markdown ตาม format ที่กำหนด
ห้ามมีคำนำ ห้ามมีคำอธิบาย ห้ามมีอะไรปิดท้ายนอกจากบรรทัดให้เลือก
ตอบเป็นข้อความในแชตเท่านั้น อย่าสร้างไฟล์`
}

export function scriptPrompt(config, title) {
  const words = Math.round(config.script.targetMinutes * config.script.wordsPerMinute)
  return `${blueprint(config)}

═══════════════════════════════════════
ทำ STAGE 2 ตามเอกสารข้างบน สำหรับหัวข้อนี้:

"${title}"

ความยาวเป้าหมาย ${config.script.targetMinutes} นาที ≈ ${words} คำ

ข้อกำหนดของ output — สำคัญมาก อ่านให้ครบ:
- ตอบเป็น narration ล้วนในแชตโดยตรง อย่าสร้างไฟล์ให้ดาวน์โหลด
- ห้ามใส่ code block, markdown, หัวข้อ, bullet, visual cue, stage direction, วงเล็บกำกับ
- ห้ามมีคำนำหรือคำปิดท้ายใดๆ นอกจากตัว narration
- 1 บรรทัด = 1 ช่วงลมหายใจ (ประโยคสั้น 6-14 คำ)
- ใช้ ... แทนช่วงพักสั้น, เว้นบรรทัดว่างแทนการขึ้นบทใหม่
- ห้ามใส่ [pause] marker ใดๆ
- บุรุษที่ 2 ตลอด ("คุณ") ห้ามใช้ "เรา" หรือ "ผม/ฉัน"`
}

/** ขั้นที่ 4 — ให้ AI เติม prompt ภาพลงในช่อง shot ที่เราคำนวณจังหวะมาแล้ว */
export function shotlistPrompt(config, { title, slots, timecodeText }) {
  const table = slots
    .map((s) => `${s.filename} | SHOT ${String(s.shot).padStart(2, '0')} | ${s.duration}s | ${s.continuation ? '(ภาพต่อเนื่องจากช็อตก่อน)' : ''} ${s.narration}`)
    .join('\n')

  return `${blueprint(config)}

═══════════════════════════════════════
สร้าง OUTPUT 5 ให้ครบทั้ง 3 ส่วน สำหรับคลิปนี้:

หัวข้อ: "${title}"

Timecode Map:
${timecodeText}

ช่อง shot ที่คำนวณจังหวะมาแล้ว (${slots.length} ช็อต) — ห้ามเพิ่ม ห้ามลด ห้ามแก้ชื่อไฟล์:
${table}

ข้อกำหนดของ output:
- ตอบเป็นข้อความล้วนในแชต ห้ามใส่ code block ครอบทั้งคำตอบ อย่าสร้างไฟล์
- เรียงตามนี้: 5.1 Style Bible → 5.2 Character Bible → 5.3 Shot List
- ส่วน 5.3 ต้องขึ้นต้นด้วยบรรทัด "=== SHOT LIST ===" แล้วตามด้วย shot ทีละบรรทัด
- ทุก shot ขึ้นต้นด้วยชื่อไฟล์ที่ให้มาเป๊ะๆ ตามด้วย | คั่นแต่ละ field
- เว้น 1 บรรทัดว่างระหว่าง shot
- ช็อตที่กำกับว่า "ภาพต่อเนื่อง" ให้เป็น mini-sequence ของช็อตก่อนหน้า ไม่ใช่ฉากใหม่
- ใส่ pattern interrupt ทุก 15-30 วิ ตามกฎ 6
- ตัวละครทุกตัวต้องมี @TAG และห้ามเปลี่ยนรูปร่าง/สี/อุปกรณ์ข้ามช็อต`
}

/** ข้อความที่วางลง Flow — คำกำกับข้างบนตามที่ผู้ใช้ระบุในข้อ 5 ของสเปก */
export function flowPrompt(agentBrief) {
  return `สร้างรูป ตามนี้ อย่าลืม lock ตัวละครต่างๆ ด้วยนะ

${agentBrief}`
}

/** ตัดคำนำ/คำปิดท้าย/markdown ที่โมเดลชอบแถมมา ให้เหลือ narration ล้วนตาม OUTPUT 2 */
export function cleanScript(text) {
  return text
    .replace(/^```[\w]*\n?|```$/gm, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      if (/^#{1,6}\s/.test(t)) return false // หัวข้อ
      if (/^[-*+]\s/.test(t)) return false // bullet
      if (/^\[.*\]$/.test(t)) return false // [visual cue]
      if (/^\(.*\)$/.test(t)) return false // (stage direction)
      return true
    })
    .join('\n')
    .replace(/\*\*|__/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** ดึงตารางหัวข้อจากคำตอบ STAGE 1 */
export function parseTopics(text) {
  return [...text.matchAll(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|/gm)]
    .map((m) => ({ n: Number(m[1]), title: m[2].trim() }))
    .filter((t) => t.title && !/^-+$/.test(t.title) && t.title.toLowerCase() !== 'video title')
}

/** แยก shot list ออกจาก OUTPUT 5 แล้วจับคู่กับช่อง shot ที่เราคำนวณไว้ */
export function parseShotList(text, slots) {
  const byFilename = new Map()
  for (const m of text.matchAll(/^(\d{2}_\d{2}_\d{2}(?:_\d)?\.png)\s*(.*)$/gm)) {
    byFilename.set(m[1], m[2].trim())
  }
  const matched = slots.map((s) => ({ ...s, prompt: byFilename.get(s.filename) ?? null }))
  return { shots: matched, missing: matched.filter((s) => !s.prompt).map((s) => s.filename) }
}
