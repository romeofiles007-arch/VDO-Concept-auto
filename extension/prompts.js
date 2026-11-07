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
  zh: {
    name: 'ภาษาจีนกลาง อักษรตัวย่อ (简体中文)',
    unit: '字',
    person: 'บุรุษที่ 2 ตลอด ใช้ "你" ห้ามใช้ "我们" หรือ "我"',
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
  'ผี & เรื่องเล่าสยอง',
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
  if (!l) throw new Error(`ไม่รองรับภาษา "${code}" — ใช้ได้แค่ th, en หรือ zh`)
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
/** มุมเรื่องจาก PROVEN VIRAL TOPIC ANGLES — สุ่มให้หัวข้อละแบบ กันออกมาเป็นสูตรเดิมซ้ำทุกครั้ง */
const ANGLES = [
  'What did ancient people actually ___?', 'Why do/can\'t you ___?', 'What if ___?', 'The ___ Effect / Experiment',
  'You never noticed that ___', 'The untold story of ___', 'How ___ almost destroyed ___', 'The most ___ in history',
  'Inside the mind of ___', 'What happens when ___', 'The mystery of ___', '___ explained in X minutes',
]
const pickAngles = (n) => [...ANGLES].sort(() => Math.random() - 0.5).slice(0, n)

export function scoredTopicsPrompt(blueprint, { titleLanguage = 'th', minutes = 5, avoid = [], seen = [], genre = 'mix' } = {}) {
  const title = lang(titleLanguage)
  return `${blueprint}

═══════════════════════════════════════
ทำ STAGE 1 ตามเอกสารข้างบน แต่ใช้ตารางด้านล่างแทนตารางเดิม เพื่อให้คะแนนแต่ละหัวข้อ

เสนอ 5 หัวข้อ viral ที่เล่าเป็นคลิปการ์ตูน 2D doodle ยาวประมาณ ${lengthLabel(minutes)}ได้ดี
**ชื่อหัวข้อทั้ง 5 ต้องเป็น${title.name}เท่านั้น**
${genreRule(genre)}
ใช้มุมเล่าข้อละแบบ (ห้ามซ้ำกัน): ${pickAngles(5).map((a, i) => `${i + 1}) ${a}`).join(' · ')}
${avoid.length ? `\nห้ามซ้ำหรือคล้ายกับหัวข้อที่ทำคลิปไปแล้ว:\n${avoid.map((t) => `- ${t}`).join('\n')}\n` : ''}${seen.length ? `\nหัวข้อเหล่านี้เคยเสนอไปแล้ว — ห้ามเสนอซ้ำ และห้ามเป็นสิ่งของ/เหตุการณ์/ปรากฏการณ์เดียวกันที่แค่เปลี่ยนถ้อยคำ ให้หาเรื่องใหม่ที่ยังไม่อยู่ในรายการ:\n${seen.slice(0, 80).map((t) => `- ${t}`).join('\n')}\n` : ''}
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
    // ห้ามใช้ num() ตัดสิน — ชื่อแนวที่มีตัวเลข (เช่น "หมวด 1 · ...") เคยถูกนับเป็นคะแนน Hook ทั้งคอลัมน์เลื่อน
    const genre = cells.length >= 7 && !/^\s*\d+(?:\.\d+)?\s*(?:\/\s*\d+)?\s*$/.test(cells[2]) ? cells.splice(2, 1)[0] : ''
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

/** ความยาวคลิปสำหรับคนอ่าน — 0.5 → "30 วินาที" · 1.5 → "1 นาที 30 วินาที" · 2 → "2 นาที" */
export function lengthLabel(minutes) {
  const sec = Math.round(Number(minutes) * 60)
  if (!(sec > 0)) return `${minutes} นาที`
  if (sec < 60) return `${sec} วินาที`
  const m = Math.floor(sec / 60)
  return sec % 60 ? `${m} นาที ${sec % 60} วินาที` : `${m} นาที`
}

export function scriptPrompt(blueprint, title, { language = 'th', targetMinutes = 10, wordsPerMinute = 150, engage = true } = {}) {
  const words = Math.round(targetMinutes * wordsPerMinute)
  const vo = lang(language)
  return `${blueprint}

═══════════════════════════════════════
ทำ STAGE 2 ตามเอกสารข้างบน สำหรับหัวข้อนี้:

"${title}"

**ภาษาของ narration: ${vo.name}** — เขียนทั้งเรื่องเป็นภาษานี้ภาษาเดียว
(ชื่อเรื่องเป็นคนละภาษากับ narration ได้ ไม่ต้องแปลชื่อเรื่อง)

ความยาวเป้าหมาย ${lengthLabel(targetMinutes)} ≈ ${language === 'zh' ? Math.round(words * HAN_CHARS_PER_WORD) : words} ${vo.unit}${language === 'zh' ? `\n\n${ZH_RULES}` : ''}

ข้อกำหนดของ output — สำคัญมาก อ่านให้ครบ:
- ตอบเป็น narration ล้วนในแชตโดยตรง อย่าสร้างไฟล์ให้ดาวน์โหลด
- ห้ามใส่ code block, markdown, หัวข้อ, bullet, visual cue, stage direction, วงเล็บกำกับ
- ห้ามมีคำนำหรือคำปิดท้ายใดๆ นอกจากตัว narration
- 1 บรรทัด = 1 ช่วงลมหายใจ (ประโยคสั้น 6-14 คำ)
- ใช้ ... แทนช่วงพักสั้น, เว้นบรรทัดว่างแทนการขึ้นบทใหม่
- ห้ามใส่ [pause] marker ใดๆ
- ${vo.person}${engage ? `\n${engageRule(language)}` : ''}`
}

/** พากย์จีน (zh) */
export const HAN_CHARS_PER_WORD = 1.3
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/g
const ZH_RULES = `**พากย์จีน**
- เขียน narration เป็นภาษาจีนกลางอักษรตัวย่อ (简体中文) ทั้งบท ให้เป็นจีนที่เป็นธรรมชาติ
- ห้ามมีพินอิน ห้ามมีคำแปลไทยหรือวงเล็บ · ตัวเลขเขียนเป็นอักษรจีน
- บรรทัดสั้น 6–14 字 หนึ่งบรรทัดหนึ่งความคิด ใช้เครื่องหมายวรรคตอนจีน (，。？！) ได้`

/** ตัดคำนำ/คำปิดท้าย/markdown ที่โมเดลชอบแถมมา ให้เหลือ narration ล้วนตาม OUTPUT 2 */
/**
 * ชวนคุยท้ายคลิป — ผู้ใช้ (8 พ.ย. 2026): "มีแต่คนดู ไม่มีใครตอบอะไรเลย" · ปิดได้ในกล่องตั้งค่าคลิป (script.engage = false)
 * คำถามต้องเกี่ยวกับเรื่องของคลิปนี้ ถามความเห็นหรือประสบการณ์ ให้คนดูอยากพิมพ์ตอบ
 */
export function engageRule(language = 'th') {
  const examples = {
    th: '"ถ้าเป็นคุณ จะทำอย่างไร?" · "ใครเคยเจอเหตุการณ์แบบนี้บ้าง? เล่าให้ฟังในคอมเมนต์หน่อย"',
    en: '"What would you do?" · "Has this ever happened to you? Tell us in the comments."',
    zh: '"如果是你，你会怎么做？" · "你遇到过这种事吗？在评论区说说吧。"',
  }
  return `- ปิดท้ายบทด้วยประโยคชวนคุย 1–2 บรรทัด ให้คนดูอยากพิมพ์ตอบในคอมเมนต์ — ถามความเห็นหรือประสบการณ์ที่เกี่ยวกับเรื่องนี้ตรงๆ เช่น ${examples[language] ?? examples.th}
  · ใช้ภาษาของ narration · เปลี่ยนคำถามให้เข้ากับเรื่อง ไม่ต้องใช้ตัวอย่างตรงตัว · น้ำเสียงเข้ากับคลิป (สุภาพ ไม่เร่งเร้า)
  · ข้อนี้มีผลเหนือข้อ "ไม่ถามคนดู" หรือ "ห้ามมีคำปิดท้าย" ด้านบน เฉพาะประโยคชวนคุยท้ายบทนี้ · ห้ามขอไลก์/กดติดตาม/แชร์`
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
  // ไทยไม่เว้นวรรคระหว่างคำ → นับตัวอักษรไทยแล้วหารด้วยความยาวคำเฉลี่ย
  // 5.4 ตัว/คำ ที่ 150 คำ/นาที = ~13.5 ตัว/วินาที — วัดจากเสียงพากย์จริง 8 คลิป (12.5–14.3 ตัว/วิ, ต.ค. 2026)
  // เดิมใช้ 4.5 ทำให้ประเมินยาวเกินจริง ~20% → บทที่ยาวพอดีถูกตีว่า "ยาวผิดเป้า" แล้วสั่งเขียนใหม่วนหลายรอบ
  // จีน: 1.3 字 = 1 คำ — วัดจาก Edge zh-CN-YunyangNeural ความเร็วปกติ 3.24 字/วิ รวมช่วงเว้น (ต.ค. 2026)
  const thaiChars = (script.match(/[฀-๿]/g) || []).length
  const hanChars = (script.match(HAN) || []).length
  const otherWords = (script.replace(/[฀-๿]/g, ' ').replace(HAN, ' ').match(/[\p{L}\p{N}]+/gu) || []).length
  return (thaiChars / 5.4 + hanChars / HAN_CHARS_PER_WORD + otherWords) / wordsPerMinute
}

/** `my topic!` → `my_topic` ใช้เป็นชื่อโฟลเดอร์และชื่อไฟล์ script */
export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
}

/**
 * ลายเส้นของภาพ (ตั้งค่าคลิป → "ลายเส้นของภาพ") — random = สุ่มต่อคลิป จำไว้ใน projects/<slug>/art_style.json
 *   doodle     — การ์ตูน 2D ตาม VISUAL STYLE DNA ของ Blueprint (เดิม)
 *   watercolor — ภาพวาดสีน้ำ
 *   chinese    — ภาพวาดหมึกจีน (shuimo + gongbi)
 *   body / bodyFlow = แบบตัวละครที่ใช้แทน FULL-BODY/STICK MODE
 */
export const ART_STYLES = {
  doodle: { label: 'การ์ตูน doodle' },
  watercolor: {
    label: 'ภาพวาดสีน้ำ',
    rule: `**ลายเส้นของคลิปนี้: ภาพวาดสีน้ำ — ใช้แทน ART STYLE และ CHARACTERS ใน VISUAL STYLE DNA ของ Blueprint ทั้งคลิป (ห้าม doodle ห้ามตัวก้าง ห้ามการ์ตูนหัวโต)**
- ART STYLE ใน Style Bible ให้เขียนว่า: Painterly watercolor illustration — soft ink linework with rich watercolor washes and gentle paper texture, warm golden light with soft atmospheric haze, detailed lush backgrounds, cinematic wide compositions, emotional storytelling mood, fully colored
- ตัวละครวาดแบบภาพวาดสัดส่วนสมจริง (ไม่ใช่การ์ตูน): ใบหน้ามีรายละเอียดและอารมณ์ชัด ผิวและผ้ามีแสงเงาแบบสีน้ำ
- ทุกช็อตเหมือนภาพวาดหนึ่งภาพ: ฉากหลังละเอียด แสงนุ่ม หมอกบาง สีอิ่มแบบสีน้ำ
- ตัวอักษรบนภาพใช้น้อยที่สุด (ซับไตเติลใส่ตอนตัดต่อ)`,
    flow: 'ลายเส้น: ภาพวาดสีน้ำ ลายเส้นหมึกนุ่ม ลงสีน้ำซึมเต็มภาพ แสงทองนุ่ม ฉากหลังละเอียด ตัวละครสัดส่วนสมจริงแบบภาพวาด — ไม่ใช่การ์ตูน doodle ไม่ใช่ตัวก้าง ใช้ลายเส้นนี้ทุกภาพ',
    body: '- แบบตัวละคร: ภาพวาดสีน้ำสัดส่วนสมจริง (ไม่ใช่การ์ตูน ไม่ใช่ตัวก้าง ไม่ใช่หัวโต) ตามลายเส้นภาพวาดสีน้ำด้านล่าง · เขียนแบบนี้ใน Character Bible ด้วย',
    bodyFlow: 'ตัวละครทุกตัววาดแบบภาพวาดสีน้ำสัดส่วนสมจริง ไม่ใช่การ์ตูน ไม่ใช่ตัวก้าง',
  },
  chinese: {
    label: 'ภาพวาดจีน',
    rule: `**ลายเส้นของคลิปนี้: ภาพวาดหมึกจีน — ใช้แทน ART STYLE และ CHARACTERS ใน VISUAL STYLE DNA ของ Blueprint ทั้งคลิป (ห้าม doodle ห้ามตัวก้าง ห้ามการ์ตูนหัวโต)**
- ART STYLE ใน Style Bible ให้เขียนว่า: Traditional Chinese ink-wash painting (shuimo) with fine gongbi detail on the figures — expressive black ink brushstrokes, fully colored with rich translucent watercolor washes (vermilion, ochre, jade green, indigo, touches of gold) — never monochrome, aged rice-paper / silk texture, generous empty space, misty layered mountains, pine and bamboo, lotus ponds, pavilions with curved roofs, drifting clouds, cinematic scroll-painting compositions
- ตัวละครวาดแบบภาพวาดพู่กันจีนสัดส่วนสมจริง (ไม่ใช่การ์ตูน): เส้นพู่กันเรียวคม ใบหน้ามีอารมณ์ ผ้าพลิ้วเป็นริ้ว
- ทุกช็อตเหมือนภาพม้วนจิตรกรรมจีนหนึ่งภาพ: เว้นพื้นที่ว่างกว้าง หมอกลอยเป็นชั้น ภูเขาไกลจางเป็นหมึกอ่อน (ฉากในเรื่องยังเป็นสถานที่ตามเนื้อเรื่อง แค่วาดด้วยลายเส้นนี้)
- ห้ามมีตัวอักษรจีน ตราประทับ หรือข้อความใดๆ บนภาพ (ซับไตเติลใส่ตอนตัดต่อ)`,
    flow: 'ลายเส้น: ภาพวาดหมึกจีน พู่กันหมึกดำลงสีน้ำเต็มภาพ (ชาด เหลืองดิน เขียวหยก คราม แต้มทอง — ไม่ใช่หมึกขาวดำ) พื้นกระดาษสาเก่า เว้นที่ว่างกว้าง หมอกเป็นชั้น ตัวละครสัดส่วนสมจริงแบบภาพพู่กัน — ไม่ใช่การ์ตูน doodle ไม่ใช่ตัวก้าง ห้ามมีตัวอักษรจีนหรือตราประทับ ใช้ลายเส้นนี้ทุกภาพ',
    body: '- แบบตัวละคร: ภาพวาดพู่กันจีนสัดส่วนสมจริง (ไม่ใช่การ์ตูน ไม่ใช่ตัวก้าง ไม่ใช่หัวโต) ตามลายเส้นภาพวาดหมึกจีนด้านล่าง · เขียนแบบนี้ใน Character Bible ด้วย',
    bodyFlow: 'ตัวละครทุกตัววาดแบบภาพพู่กันจีนสัดส่วนสมจริง ไม่ใช่การ์ตูน ไม่ใช่ตัวก้าง',
  },
  random: { label: '🎲 สุ่ม' },
}
