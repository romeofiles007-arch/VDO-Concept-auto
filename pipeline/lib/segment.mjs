/**
 * ซอย VO script → segment สำหรับยิง TTS ทีละชิ้น
 *
 * ตาม OUTPUT 2 ของ Blueprint: 1 บรรทัด = 1 ช่วงลมหายใจ, บรรทัดว่าง = พักยาว/ขึ้นบทใหม่
 * การซอยแบบนี้ทำให้เรารู้ความยาวของทุกประโยคตอนสังเคราะห์เสียง → ได้ timecode ฟรี
 * โดยไม่ต้องถอดเสียงกลับด้วย Whisper (ซึ่งพังกับภาษาไทยบ่อย)
 */

const MAX_CHARS = 180 // ยาวกว่านี้ F5-TTS เริ่มเพี้ยน ต้องซอยย่อย

/** ซอยประโยคยาวเกินไปตรงจุดพักธรรมชาติ โดยไม่ทำลายความหมาย */
function splitLong(text) {
  if ([...text].length <= MAX_CHARS) return [text]

  // ลำดับความชอบในการหาจุดตัด: ... > เครื่องหมายวรรคตอน > ช่องว่าง
  for (const re of [/\.\.\.|…/g, /[.!?。！？]/g, /[,、;:]/g, /\s+/g]) {
    const cuts = [...text.matchAll(re)].map((m) => m.index + m[0].length)
    if (!cuts.length) continue
    const mid = [...text].length / 2
    const best = cuts.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a))
    if (best <= 0 || best >= text.length) continue
    return [...splitLong(text.slice(0, best).trim()), ...splitLong(text.slice(best).trim())]
  }
  return [text]
}

/**
 * @param {string} script  narration ล้วน (ไม่มี markdown / stage direction)
 * @returns {{index:number, text:string, paragraph:number, isParagraphEnd:boolean}[]}
 */
export function segmentScript(script) {
  const paragraphs = script
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)

  const segments = []
  paragraphs.forEach((para, pIdx) => {
    const lines = para
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap(splitLong)

    lines.forEach((text, lIdx) => {
      segments.push({
        index: segments.length,
        text,
        paragraph: pIdx,
        isParagraphEnd: lIdx === lines.length - 1,
      })
    })
  })
  return segments
}

/** ประมาณความยาวคลิปก่อนยิง TTS จริง — ใช้เช็คว่าสคริปต์ยาวพอสำหรับ n นาทีไหม */
export function estimateMinutes(script, wordsPerMinute = 150) {
  // ไทยไม่เว้นวรรคระหว่างคำ → นับตัวอักษรไทยแล้วหารด้วยความยาวคำเฉลี่ย (~4.5 ตัว/คำ)
  const thaiChars = (script.match(/[฀-๿]/g) || []).length
  const otherWords = (script.replace(/[฀-๿]/g, ' ').match(/\S+/g) || []).length
  return (thaiChars / 4.5 + otherWords) / wordsPerMinute
}
