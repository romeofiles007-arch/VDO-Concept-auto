/**
 * ซับไตเติลฝังในวิดีโอ — พื้นทึบหลังตัวอักษร อ่านง่ายทุกภาพ
 *
 * ใช้ไฟล์ ASS (libass ของ ffmpeg) แทน SRT เพราะกำหนดกล่องพื้นทึบ ขนาด และตำแหน่งตามแนวภาพได้
 * BorderStyle 4 = กล่องเดียวครอบทั้งข้อความ (แบบ 3 วาดกล่องแยกทีละส่วน ทำให้มีเหลี่ยมดำโผล่เหนือสระบน/วรรณยุกต์)
 * ภาษาไทยไม่มีช่องว่างระหว่างคำ libass ตัดบรรทัดเองไม่ได้ → ตัดคำด้วย Intl.Segmenter แล้วขึ้นบรรทัดเอง
 */

export const SUBTITLE_STYLES = {
  off: { label: 'ไม่ใส่' },
  black: { label: 'พื้นดำ ตัวขาว', text: 'FFFFFF', box: '000000' },
  white: { label: 'พื้นขาว ตัวดำ', text: '111111', box: 'FFFFFF' },
  yellow: { label: 'พื้นเหลือง ตัวดำ', text: '111111', box: 'FFD400' },
}

// สระบน/ล่าง วรรณยุกต์ ไม่กินความกว้าง
const COMBINING = /[ัิ-ฺ็-๎]/g
const width = (s) => s.replace(COMBINING, '').length

const segmenter = new Intl.Segmenter('th', { granularity: 'word' })

/** ตัดข้อความเป็นบรรทัดยาวไม่เกิน maxChars โดยไม่ตัดกลางคำ */
export function wrapText(text, maxChars) {
  const clean = text.replace(/\s+/g, ' ').trim()
  // เฉลี่ยความยาวทุกบรรทัดให้ใกล้กัน — กันบรรทัดสุดท้ายเหลือคำเดียว
  const target = Math.ceil(width(clean) / Math.ceil(width(clean) / maxChars))
  const lines = []
  let cur = ''
  for (const { segment, isWordLike } of segmenter.segment(clean)) {
    // เครื่องหมาย (... , !) ติดท้ายบรรทัดเดิมเสมอ ไม่ขึ้นต้นบรรทัดใหม่
    const punctuation = !isWordLike && segment.trim()
    if (!punctuation && width(cur + segment) > target + 2 && cur.trim()) {
      lines.push(cur.trim())
      cur = segment.trimStart()
    } else {
      cur += segment
    }
  }
  if (cur.trim()) lines.push(cur.trim())
  // คำสุดท้ายเหลือบรรทัดเดียวสั้นๆ → รวมกับบรรทัดก่อนถ้ายังไม่ยาวเกินไป
  if (lines.length > 1 && width(lines.at(-1)) < target * 0.35 && width(lines.at(-2) + lines.at(-1)) <= maxChars + 4) {
    lines.splice(-2, 2, lines.at(-2) + lines.at(-1))
  }
  return lines
}

const assTime = (sec) => {
  const cs = Math.max(0, Math.round(sec * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor(cs / 6000) % 60
  const s = Math.floor(cs / 100) % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** สี ASS = &HAABBGGRR (alpha 00 = ทึบ) */
const assColor = (hex, alpha = '00') => `&H${alpha}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase()

const escapeAss = (s) => s.replace(/\\/g, '\\\\').replace(/[{}]/g, (c) => (c === '{' ? '(' : ')'))

/**
 * timeline (timecode.json) → เนื้อหาไฟล์ .ass
 * ประโยคยาวเกิน 2 บรรทัด → แบ่งเป็นหลายจอ เวลาแบ่งตามความยาวข้อความ
 */
export function buildAss(entries, { width: W, height: H, style = 'black' }) {
  const st = SUBTITLE_STYLES[style] ?? SUBTITLE_STYLES.black
  const portrait = H > W
  const fontSize = portrait ? 66 : 54
  const maxChars = portrait ? 18 : 40
  const marginV = portrait ? Math.round(H * 0.2) : Math.round(H * 0.06) // แนวตั้งยกสูงพ้นปุ่มของ Shorts/Reels
  const pad = Math.round(fontSize * 0.28)

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Leelawadee UI,${fontSize},${assColor(st.text)},${assColor(st.text)},${assColor(st.box)},${assColor(st.box)},-1,0,0,0,100,100,0,0,4,${pad},0,2,60,60,${marginV},222

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const events = []
  entries.forEach((e, i) => {
    const text = String(e.text ?? '').trim()
    if (!text) return
    // ค้างไว้ถึงประโยคถัดไปถ้าช่วงเงียบสั้น — ไม่กะพริบ
    const next = entries[i + 1]?.start
    const end = next != null && next - e.end < 0.6 ? next : e.end + 0.15
    const lines = wrapText(text, maxChars)
    const pages = []
    for (let p = 0; p < lines.length; p += 2) pages.push(lines.slice(p, p + 2))
    const total = pages.reduce((n, pg) => n + width(pg.join('')), 0) || 1
    let t = e.start
    pages.forEach((pg, p) => {
      const pageEnd = p === pages.length - 1 ? end : t + (end - e.start) * (width(pg.join('')) / total)
      events.push(`Dialogue: 0,${assTime(t)},${assTime(pageEnd)},Default,,0,0,0,,${pg.map(escapeAss).join('\\N')}`)
      t = pageEnd
    })
  })
  return header + events.join('\n') + '\n'
}
