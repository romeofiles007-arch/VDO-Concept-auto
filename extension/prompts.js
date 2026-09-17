/**
 * prompt ของขั้นหัวข้อ + บทพากย์ — ใช้ร่วมกันทั้งแผงข้างของ extension และ pipeline/ (Node)
 * จึงต้องเป็นฟังก์ชันล้วน ไม่แตะไฟล์หรือ API ของ Chrome — ผู้เรียกเป็นคนอ่าน Blueprint มาส่งให้
 *
 * Blueprint คือแหล่งความจริงเดียวของกติกาทั้งหมด — ส่งไปทั้งฉบับทุกครั้ง ไม่สรุปย่อ
 */
export const BLUEPRINT_FILE = 'VDO Concept.txt' // Blueprint (V4 หลากหลายแนว)

const LANG = {
  th: {
    name: 'ภาษาไทย',
    // ไทยไม่เว้นวรรคระหว่างคำ → นับเป็น "คำ" แบบไทย ไม่ใช่ token อังกฤษ
    unit: 'คำ',
    person: 'บุรุษที่ 2 ตลอด ใช้ "คุณ" ห้ามใช้ "เรา" หรือ "ผม/ฉัน"',
  },
  en: {
    name: 'English',
    unit: 'words',
    person: 'second person throughout ("you", "your"), never "we" or "I"',
  },
}

/** แนวคลิป — ตรงกับ GENRE CATALOG ใน Blueprint · 'mix' = สุ่มคนละแนวทุกหัวข้อ */
export const GENRES = [
  'ประวัติศาสตร์โลก',
  'ประวัติศาสตร์ไทย/เอเชีย',
  'วิวัฒนาการ & มนุษย์ยุคแรก',
  'อวกาศ & จักรวาล',
  'สัตว์ประหลาด & ธรรมชาติ',
  'ไดโนเสาร์ & โลกดึกดำบรรพ์',
  'ร่างกายมนุษย์ & สุขภาพ',
  'จิตวิทยา & พฤติกรรม',
  'วิทยาศาสตร์ & ฟิสิกส์ง่ายๆ',
  'เทคโนโลยี & สิ่งประดิษฐ์',
  'เศรษฐกิจ & เงิน',
  'ธุรกิจ & แบรนด์ดัง',
  'ความลึกลับ & ปริศนา',
  'คดีดัง & อาชญากรรม (เล่าแบบไม่โหด)',
  'ตำนาน & เทพปกรณัม',
  'ภูมิศาสตร์ & ประเทศแปลกๆ',
  'อาหาร & ที่มาของสิ่งรอบตัว',
  'ภัยพิบัติ & เอาชีวิตรอด',
  'What If สมมติสุดโต่ง',
  'บุคคลในประวัติศาสตร์',
  'สงคราม & กลยุทธ์',
  'ศาสนา ความเชื่อ & วัฒนธรรม',
  'ภาษา & การสื่อสาร',
  'กีฬา & การแข่งขัน',
  'ศิลปะ ดนตรี & ภาพยนตร์',
  'ชีวิตประจำวันที่ไม่เคยสังเกต',
  'ปรัชญา & คำถามใหญ่',
  'อนาคต & ปี 2100',
  'ชีวิตพัฒนาตัวเอง',
  'สิ่งแวดล้อม & โลกของเรา',
  'ตลก & ขำขัน',
  'ความผิดพลาดสุดฮาในประวัติศาสตร์',
  'เรื่องจริงสุดบ้าที่ไม่น่าเกิดขึ้นได้',
]

/** แนวของแต่ละหัวข้อ: ระบุแนวเดียว → ทุกหัวข้อแนวนั้น · 'mix'/ว่าง → สุ่มคนละแนว */
export function pickGenres(genre = 'mix', count = 5) {
  if (genre && genre !== 'mix') return Array(count).fill(genre)
  const pool = [...GENRES]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, count)
}

function genreRule(genre) {
  const genres = pickGenres(genre)
  if (genre && genre !== 'mix') {
    return `**แนวของคลิปชุดนี้: ${genre}** — ทั้ง 5 หัวข้อต้องอยู่ในแนวนี้ แต่ใช้ angle ต่างกันทุกข้อ (ดู PROVEN VIRAL TOPIC ANGLES)`
  }
  return `**หัวข้อต้องหลากหลาย — ห้ามวนอยู่แนวเดียว** ใช้แนวเหล่านี้ ข้อละแนว:
${genres.map((g, i) => `${i + 1}. ${g}`).join('\n')}
ใช้ angle ต่างกันให้มากที่สุด ห้ามขึ้นต้นด้วย "ทำไม"/"Why" เกิน 1 ข้อ ห้ามใช้คำว่า "สมอง"/"brain" เว้นแต่แนวนั้นเป็นจิตวิทยาหรือร่างกาย`
}

function lang(code) {
  const l = LANG[code]
  if (!l) throw new Error(`ไม่รองรับภาษา "${code}" — ใช้ได้แค่ th หรือ en`)
  return l
}

export function topicsPrompt(blueprint, { titleLanguage = 'en', genre = 'mix' } = {}) {
  const title = lang(titleLanguage)
  return `${blueprint}

═══════════════════════════════════════
ทำ STAGE 1 ตามเอกสารข้างบนเท่านั้น

แสดง 5 หัวข้อ viral ในตาราง markdown ตาม format ที่กำหนด (คอลัมน์ # | Video Title | Genre)
**ชื่อหัวข้อทั้ง 5 ต้องเป็น${title.name}เท่านั้น**
${genreRule(genre)}
ห้ามมีคำนำ ห้ามมีคำอธิบาย ห้ามมีอะไรปิดท้ายนอกจากตาราง
ตอบเป็นข้อความในแชตเท่านั้น อย่าสร้างไฟล์`
}

/**
 * STAGE 1 แบบมีคะแนน — ให้ ChatGPT ให้คะแนนแต่ละหัวข้อ เพื่อเลือกเองหรือให้ระบบเลือกอันที่ดีที่สุด
 * avoid = ชื่อเรื่องที่ทำไปแล้ว ห้ามเสนอซ้ำ
 */
export function scoredTopicsPrompt(blueprint, { titleLanguage = 'th', minutes = 5, avoid = [], genre = 'mix' } = {}) {
  const title = lang(titleLanguage)
  return `${blueprint}

═══════════════════════════════════════
ทำ STAGE 1 ตามเอกสารข้างบน แต่ใช้ตารางด้านล่างแทนตารางเดิม เพื่อให้คะแนนแต่ละหัวข้อ

เสนอ 5 หัวข้อ viral ที่เล่าเป็นคลิปการ์ตูน stick-figure ยาวประมาณ ${minutes} นาทีได้ดี
**ชื่อหัวข้อทั้ง 5 ต้องเป็น${title.name}เท่านั้น**
${genreRule(genre)}
${avoid.length ? `ห้ามซ้ำหรือคล้ายกับหัวข้อที่ทำไปแล้ว:\n${avoid.map((t) => `- ${t}`).join('\n')}\n` : ''}
ให้คะแนนแต่ละหัวข้อ 1–10 อย่างตรงไปตรงมา (ห้ามให้ทุกข้อเท่ากัน):
- Hook = เห็นชื่อแล้วอยากกดดูทันทีแค่ไหน (ความสงสัย อารมณ์ ความขัดแย้งกับความเชื่อเดิม)
- Search = คนค้นหา/สนใจเรื่องนี้ได้ต่อเนื่องแค่ไหน (evergreen หรือกระแสที่ยังแรง)
- Visual = เล่าด้วยภาพการ์ตูนเปลี่ยนทุก 2–3 วินาทีได้สนุกแค่ไหน
- Score = คะแนนรวม 0–100 (ไม่ใช่แค่บวกกัน ให้ชั่งน้ำหนักว่าจะทำยอดวิวได้จริงแค่ไหน)
- Genre = แนวของหัวข้อ (ชื่อแนวจาก GENRE CATALOG)
- Why = เหตุผลสั้นๆ 1 ประโยคเป็นภาษาไทย

ตอบเป็นตาราง markdown ตารางเดียว คอลัมน์ตามนี้เป๊ะๆ เรียงจากคะแนนรวมมากไปน้อย:
| # | Video Title | Genre | Hook | Search | Visual | Score | Why |
|---|---|---|---|---|---|---|---|

ห้ามมีคำนำหรือคำอธิบายนอกตาราง ตอบเป็นข้อความในแชตเท่านั้น อย่าสร้างไฟล์`
}

/** ตารางหัวข้อที่มีคะแนน → [{ n, title, genre, hook, search, visual, score, why }] เรียงคะแนนมากไปน้อย */
export function parseScoredTopics(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    // ChatGPT แสดงตารางเป็น <table> → innerText คั่นด้วย tab · ข้อความดิบคั่นด้วย |
    const cells = line.includes('|') ? line.split('|').map((c) => c.trim()).filter((c, i, a) => !(c === '' && (i === 0 || i === a.length - 1))) : line.split('\t').map((c) => c.trim())
    if (cells.length < 6 || !/^\d+$/.test(cells[0])) continue
    const num = (v) => {
      const n = Number(String(v).match(/\d+(?:\.\d+)?/)?.[0])
      return Number.isFinite(n) ? n : null
    }
    // คอลัมน์ Genre อยู่หลังชื่อ — คำตอบรุ่นเก่าไม่มี (คอลัมน์ที่ 3 เป็นตัวเลข)
    const genre = cells.length >= 7 && num(cells[2]) == null ? cells.splice(2, 1)[0] : ''
    const [n, title, hook, search, visual, score, ...why] = cells
    if (!title || /^video title$/i.test(title)) continue
    const h = num(hook)
    const s = num(search)
    const v = num(visual)
    let total = num(score)
    if (total == null && h != null && s != null && v != null) total = Math.round(((h + s + v) / 30) * 100)
    rows.push({ n: Number(n), title: title.replace(/^\*\*|\*\*$/g, '').trim(), genre, hook: h, search: s, visual: v, score: total ?? 0, why: why.join(' ').trim() })
  }
  return rows.sort((a, b) => b.score - a.score)
}

export function scriptPrompt(blueprint, title, { language = 'th', targetMinutes = 10, wordsPerMinute = 150 } = {}) {
  const words = Math.round(targetMinutes * wordsPerMinute)
  const vo = lang(language)
  return `${blueprint}

═══════════════════════════════════════
ทำ STAGE 2 ตามเอกสารข้างบน สำหรับหัวข้อนี้:

"${title}"

**ภาษาของ narration: ${vo.name}** — เขียนทั้งเรื่องเป็นภาษานี้ภาษาเดียว
(ชื่อเรื่องเป็นคนละภาษากับ narration ได้ ไม่ต้องแปลชื่อเรื่อง)

ความยาวเป้าหมาย ${targetMinutes} นาที ≈ ${words} ${vo.unit}

ข้อกำหนดของ output — สำคัญมาก อ่านให้ครบ:
- ตอบเป็น narration ล้วนในแชตโดยตรง อย่าสร้างไฟล์ให้ดาวน์โหลด
- ห้ามใส่ code block, markdown, หัวข้อ, bullet, visual cue, stage direction, วงเล็บกำกับ
- ห้ามมีคำนำหรือคำปิดท้ายใดๆ นอกจากตัว narration
- 1 บรรทัด = 1 ช่วงลมหายใจ (ประโยคสั้น 6-14 คำ)
- ใช้ ... แทนช่วงพักสั้น, เว้นบรรทัดว่างแทนการขึ้นบทใหม่
- ห้ามใส่ [pause] marker ใดๆ
- ${vo.person}`
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
  // ChatGPT แสดง markdown table เป็น <table> → innerText ได้คอลัมน์คั่นด้วย tab ไม่ใช่ |
  return [...text.matchAll(/^\|?[ \t]*(\d+)[ \t]*[|\t][ \t]*([^|\t\n]+?)[ \t]*(?:[|\t]|$)/gm)]
    .map((m) => ({ n: Number(m[1]), title: m[2].trim() }))
    .filter((t) => t.title && !/^-+$/.test(t.title) && t.title.toLowerCase() !== 'video title')
}

/** ประมาณความยาวคลิปก่อนยิง TTS จริง — ใช้เช็คว่าสคริปต์ยาวพอสำหรับ n นาทีไหม */
export function estimateMinutes(script, wordsPerMinute = 150) {
  // ไทยไม่เว้นวรรคระหว่างคำ → นับตัวอักษรไทยแล้วหารด้วยความยาวคำเฉลี่ย (~4.5 ตัว/คำ)
  const thaiChars = (script.match(/[฀-๿]/g) || []).length
  const otherWords = (script.replace(/[฀-๿]/g, ' ').match(/\S+/g) || []).length
  return (thaiChars / 4.5 + otherWords) / wordsPerMinute
}

/** `my topic!` → `my_topic` ใช้เป็นชื่อโฟลเดอร์และชื่อไฟล์ script */
export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
}
