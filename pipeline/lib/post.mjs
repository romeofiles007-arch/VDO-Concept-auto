/**
 * ข้อความสำหรับโพสต์คลิป (TikTok / YouTube Shorts / Reels) — ชื่อคลิป คำบรรยาย แฮชแท็ก
 * ให้ ChatGPT คิดจากบทจริงของคลิป แล้วเก็บที่ 01_script/post.json ให้แผงข้างกด copy ไปวางได้
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './config.mjs'

const scriptDir = (slug) => join(ROOT, 'projects', slug, '01_script')
const postFile = (slug) => join(scriptDir(slug), 'post.json')

/** ชื่อเรื่อง บท และภาษาของคลิป — ใช้เป็นวัตถุดิบให้ ChatGPT */
export function clipSource(slug) {
  const dir = scriptDir(slug)
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim() : '')
  const scriptName = existsSync(dir) ? readdirSync(dir).find((n) => /^script_.*\.txt$/.test(n) && !n.includes('_offtarget_')) : null
  const meta = read('meta.json') ? JSON.parse(read('meta.json')) : {}
  return { title: read('title.txt') || slug, script: scriptName ? read(scriptName) : '', language: meta.language ?? 'th' }
}

export function postPrompt({ title, script, language = 'th' }) {
  const th = language !== 'en'
  return `คุณคือคนดูแลโซเชียลของช่องการ์ตูนความรู้/เรื่องเล่าสั้น งานนี้คือเขียนข้อความสำหรับโพสต์คลิปนี้ลง TikTok, YouTube Shorts และ Reels ให้คนหยุดดูและกดเข้ามา

ชื่อเรื่องในระบบ: "${title}"

บทพากย์ของคลิป:
${script.slice(0, 6000) || '(ไม่มีบท — ใช้ชื่อเรื่อง)'}

═══════════════════════════════════════
เขียนเป็น${th ? 'ภาษาไทย' : 'ภาษาอังกฤษ'} ตามนี้:
- titles: ชื่อคลิป 3 แบบ ต่างสไตล์กัน (คำถามชวนสงสัย / ข้อเท็จจริงที่น่าตกใจ / เล่าแบบเรื่องจริง) ยาวไม่เกิน 60 ตัวอักษร ห้ามใช้ชื่อเรื่องในระบบตรงๆ ห้ามหลอกเกินเนื้อหาจริง
- description: คำบรรยายใต้คลิป 2–4 บรรทัด บรรทัดแรกเป็น hook ที่ทำให้อยากดูจนจบ ตามด้วยสาระสั้นๆ 1–2 บรรทัด ปิดด้วยคำชวนคอมเมนต์หรือติดตาม ใส่อีโมจิได้ 1–3 ตัว ห้ามเกิน 300 ตัวอักษร ห้ามใส่แฮชแท็กในส่วนนี้
- hashtags: แฮชแท็ก 6–8 อัน เรียงจากเจาะจงเรื่องนี้ไปกว้าง ผสม${th ? 'ไทยและอังกฤษ' : 'หัวข้อและแนวคลิป'} ขึ้นต้นด้วย # ไม่มีช่องว่างในแท็ก

ตอบเป็น JSON ก้อนเดียวเท่านั้น ไม่มีคำนำหรือคำอธิบาย รูปแบบนี้เป๊ะๆ:
{"titles": ["...", "...", "..."], "description": "...", "hashtags": ["#...", "#..."]}`
}

/** ChatGPT มักขึ้นบรรทัดใหม่จริงในคำบรรยายหลายบรรทัด (ไม่ใช่ \n) — JSON ไม่รับ จึงแปลงเฉพาะที่อยู่ในสตริง */
function escapeControlInStrings(json) {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of json) {
    if (inString && !escaped && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ''
      continue
    }
    if (ch === '"' && !escaped) inString = !inString
    escaped = inString && ch === '\\' && !escaped
    out += ch
  }
  return out
}

/** ดึง JSON จากคำตอบ — ChatGPT อาจครอบด้วย code block หรือมีข้อความแถม */
export function parsePost(text) {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('ไม่พบ JSON ในคำตอบของ ChatGPT')
  const data = JSON.parse(escapeControlInStrings(raw.slice(start, end + 1)))
  const titles = (Array.isArray(data.titles) ? data.titles : [data.title]).map((t) => String(t ?? '').trim()).filter(Boolean)
  const description = String(data.description ?? '').trim()
  const hashtags = (Array.isArray(data.hashtags) ? data.hashtags : String(data.hashtags ?? '').split(/\s+/))
    .map((h) => String(h).trim().replace(/\s+/g, ''))
    .filter(Boolean)
    .map((h) => (h.startsWith('#') ? h : `#${h}`))
  if (!titles.length || !description) throw new Error('คำตอบไม่มีชื่อคลิปหรือคำบรรยาย')
  return { titles: titles.slice(0, 5), description, hashtags: [...new Set(hashtags)].slice(0, 10) }
}

export function savePost(slug, post) {
  const data = { ...post, createdAt: Date.now() }
  writeFileSync(postFile(slug), JSON.stringify(data, null, 2), 'utf8')
  return data
}

export function readPost(slug) {
  try {
    return existsSync(postFile(slug)) ? JSON.parse(readFileSync(postFile(slug), 'utf8')) : null
  } catch {
    return null
  }
}
