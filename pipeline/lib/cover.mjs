/**
 * ภาพปกคลิป (Thumbnail) — Blueprint OUTPUT 4 "Thumbnail concept"
 *
 *   ChatGPT: เขียน prompt ปกมาพร้อม Shot List รอบแรก (บรรทัด cover.png | COVER | ...)
 *   Flow:    สร้างเป็นภาพสุดท้ายหลังครบทุกช็อต ตั้งชื่อ "cover.png COVER" แนวเดียวกับคลิป
 *   ไฟล์:    05_images/cover.png (ขั้นตัดต่อไม่ใช้ — ไม่ใช่ชื่อ timecode) · 04_shotlist/cover.txt เก็บ prompt
 *
 * project เก่าที่ไม่มี prompt ปก → ให้ agent ออกแบบปกเองจากชื่อเรื่อง + Style/Character Bible
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectDir, loadConfig } from './config.mjs'
import { stripSafeArea, clipLanguage } from './prompts.mjs'

/**
 * สูตรปก YouTube ที่คนกดดู — ใช้ทั้งตอนขอ prompt จาก ChatGPT และตอนสั่ง Flow วาด
 * (ปกเก่าที่ prompt เขียนว่า "ไม่มีตัวอักษร" ก็ได้สูตรนี้ตอนสร้างปกใหม่)
 */
function thumbnailRules(language) {
  const th = language !== 'en'
  return [
    `หัวข้อบนปกตัวใหญ่มาก 2–4 คำ${th ? ' ภาษาไทย สะกดถูกต้องทุกตัว' : ' ภาษาอังกฤษ ALL CAPS'} — เป็นคำ hook สั้นๆ ไม่ใช่ชื่อเรื่องเต็ม (เช่น ${th ? '"ไม่มีใครรู้!", "ลูกศรนี้คืออะไร?"' : '"NOBODY KNOWS!", "WHAT IS THIS?"'}) ใส่ข้อความในเครื่องหมายคำพูด`,
    'ตัวอักษรหนามาก ขอบดำหนา สีเหลืองหรือขาว เน้นคำสำคัญ 1 คำด้วยสีแดง กินพื้นที่ราว 30% ของภาพ อยู่ด้านบนหรือด้านข้าง ห้ามทับหน้าตัวละคร',
    'ตัวละครหลักหน้าใหญ่ใกล้กล้อง (ราว 40% ของภาพ) อารมณ์เกินจริงชัดเจน เช่น ตาโต ตกใจ อ้าปาก สงสัย',
    'สิ่งของหรือภาพที่เป็นหัวใจของเรื่อง 1 อย่าง ชี้ด้วยลูกศรแดงหนา หรือวงกลมแดงรอบจุดที่ต้องการให้สงสัย',
    'ฉากหลังบอกบรรยากาศของเรื่อง (สถานที่/ของประกอบ 2–3 ชิ้น) สีสด แต่เบลอหรือเรียบกว่าตัวละคร ไม่รก มีแสงเรืองรอบตัวละครได้ · องค์ประกอบน้อย อ่านรู้เรื่องแม้เห็นภาพเล็กบนมือถือ',
    'สไตล์ลายเส้นและหน้าตาตัวละครเดียวกับ Style Bible และ Character Bible · ชวนสงสัยแต่ตรงกับเนื้อหาจริง',
  ]
}

export const COVER_NAME = 'cover.png'
export const coverPath = (slug) => join(projectDir(slug, 'images'), COVER_NAME)
const promptFile = (slug) => join(projectDir(slug, 'shotlist'), 'cover.txt')

/** กฎสำหรับ ChatGPT รอบแรก — ขอ prompt ปกต่อท้าย Shot List */
export function coverRequest(portrait, language = 'th') {
  return `- ท้ายคำตอบ เพิ่มบรรทัดว่าง แล้วบรรทัด "=== COVER ===" ตามด้วย prompt ภาพปกคลิป 1 บรรทัด ขึ้นต้นด้วย "cover.png | COVER |" (Thumbnail ตาม OUTPUT 4 — เลือกคอนเซปต์ที่ดีที่สุดแบบเดียว)
- ภาพปก = YouTube thumbnail ${portrait ? 'แนวตั้ง 9:16' : 'แนวนอน 16:9'} ที่คนอยากกดดูทันที:
${thumbnailRules(language).map((r) => `  · ${r}`).join('\n')}
- รูปแบบ field ของปก: Chars: @TAG | Env: ... | Action: ... | Frame: ... (คำอธิบายเป็น${language === 'en' ? 'ภาษาอังกฤษ' : 'ภาษาไทย'} คงชื่อ field และ @TAG ตามเดิม)`
}

/** ดึง prompt ปกจากคำตอบของ ChatGPT */
export function parseCover(text) {
  const m = /^(?:[ \t>*•-]+)?\**cover\.png\**[ \t:|]*(.+)$/im.exec(text)
  return m?.[1]?.trim() || null
}

export function saveCoverPrompt(slug, prompt) {
  if (prompt) writeFileSync(promptFile(slug), prompt, 'utf8')
}

export function readCoverPrompt(slug) {
  return existsSync(promptFile(slug)) ? readFileSync(promptFile(slug), 'utf8').trim() || null : null
}

export const hasCover = (slug) => existsSync(coverPath(slug))

/** "ช็อต" ปกสำหรับส่งให้ Flow — ไม่มี prompt จาก ChatGPT ก็ให้ agent ออกแบบเอง */
export function coverShot(slug, title) {
  const saved = readCoverPrompt(slug)
  const prompt =
    (saved && stripSafeArea(saved).trim()) ||
    `COVER | ภาพปกคลิป (YouTube thumbnail) ของเรื่อง "${title}" — ออกแบบเองจากเนื้อเรื่องและ Character Bible`
  // prompt ปกรุ่นก่อนห้ามตัวอักษร — ตัดออก ให้ใช้สูตรปก YouTube ที่มีหัวข้อตัวใหญ่แทน
  const cleaned = prompt.replace(/[,;·]?\s*(?:ไม่มีตัวอักษรในภาพ|no (?:text|letters|words)(?: in (?:the )?image)?)/gi, '').trim()
  return { filename: COVER_NAME, shot: 'COVER', prompt: cleaned, language: clipLanguage(loadConfig(), slug), title }
}

/** ส่วนท้ายของ brief ที่ส่งให้ Flow */
export function coverBriefLines(shot, portrait) {
  return [
    `=== COVER (สร้างเป็นภาพสุดท้าย หลังครบทุกช็อต) ===`,
    `${shot.filename} ${shot.prompt} | ภาพปกคลิป YouTube thumbnail ${portrait ? 'แนวตั้ง 9:16' : 'แนวนอน 16:9'} ของเรื่อง "${shot.title ?? ''}" · ${thumbnailRules(shot.language).join(' · ')} · ตั้งชื่อภาพ "cover.png COVER" (ชื่อไฟล์ไม่ต้องเขียนลงในภาพ)`,
  ]
}
