/**
 * สร้าง Timecode Map จากความยาวไฟล์เสียงจริงของแต่ละ segment
 * — ไม่ใช้ ASR จึงไม่มีทางคลาดเคลื่อน (ต่างจากขั้นที่ 3 ใน Blueprint V3)
 */

const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0')

export function hhmmss(sec) {
  return `${pad(sec / 3600)}:${pad((sec % 3600) / 60)}:${pad(sec % 60)}`
}

/** `[M:SS]` ตาม format ที่ Blueprint OUTPUT 3 รับ */
export function mss(sec) {
  return `${Math.floor(sec / 60)}:${pad(sec % 60)}`
}

/** `00_00_02_5.png` — ทศนิยมเป็นหลักสิบวินาที ตามตัวอย่าง SHOT 02 ใน Blueprint 5.3 */
export function timecodeFilename(sec, ext = 'png') {
  const whole = Math.floor(sec)
  const tenth = Math.round((sec - whole) * 10)
  const base = `${pad(whole / 3600)}_${pad((whole % 3600) / 60)}_${pad(whole % 60)}`
  return `${tenth ? `${base}_${tenth}` : base}.${ext}`
}

function srtStamp(sec) {
  const ms = Math.round((sec - Math.floor(sec)) * 1000)
  return `${hhmmss(sec)},${String(ms).padStart(3, '0')}`
}

/**
 * รวม segment + ความยาวจริง → timeline พร้อมช่องว่างระหว่างประโยค
 * @param {{index:number,text:string,paragraph:number,isParagraphEnd:boolean}[]} segments
 * @param {number[]} durations  ความยาวจริงของแต่ละ segment (วินาที) จาก ffprobe
 */
export function buildTimeline(segments, durations, { segmentGapMs = 180, paragraphGapMs = 500 } = {}) {
  let cursor = 0
  const entries = segments.map((seg, i) => {
    const start = cursor
    const duration = durations[i]
    if (!Number.isFinite(duration)) throw new Error(`segment ${i} ไม่มีความยาวเสียง`)
    const end = start + duration
    const gap = (seg.isParagraphEnd ? paragraphGapMs : segmentGapMs) / 1000
    cursor = end + gap
    return { ...seg, start, end, duration, gapAfter: gap }
  })
  return { entries, totalDuration: Math.max(0, cursor - (entries.at(-1)?.gapAfter ?? 0)) }
}

/** format เดียวกับ `Ex sample audio to scritp.txt` — ไว้ตรวจด้วยตาและป้อนกลับให้ LLM */
export function toSegmentText(timeline) {
  return timeline.entries
    .map((e) => `(${srtStamp(e.start)} --> ${srtStamp(e.end)})\n${e.text}`)
    .join('\n')
}

/** format `[M:SS] ข้อความ` ตาม Blueprint OUTPUT 3 */
export function toBlueprintText(timeline) {
  return timeline.entries.map((e) => `[${mss(e.start)}] ${e.text}`).join('\n')
}

export function toSrt(timeline) {
  return timeline.entries
    .map((e, i) => `${i + 1}\n${srtStamp(e.start)} --> ${srtStamp(e.end)}\n${e.text}\n`)
    .join('\n')
}

/**
 * แปลง timeline → ช่อง shot ตามกฎจังหวะของ Blueprint (กฎ 5: 1 ภาพ = 1 จังหวะ)
 * - segment ยาวเกิน max → ซอยเท่าๆ กัน
 * - segment สั้นกว่า min → ยุบรวมกับอันถัดไป
 * ผลลัพธ์คือ "ช่อง" ที่รอ LLM เติม prompt ภาพ (ขั้นที่ 4) — ยังไม่มีเนื้อหาภาพ
 */
export function buildShotSlots(timeline, { targetShotSeconds = 2.5, minShotSeconds = 2.0, maxShotSeconds = 3.0 } = {}) {
  // 1) รวม segment ไปข้างหน้าจนกลุ่มยาวถึง min แล้วค่อยปิดกลุ่ม
  //    (กลุ่มที่ยาวเกิน max จะถูกซอยในขั้นถัดไป จึงไม่ต้องกลัวรวมเกิน)
  const merged = []
  for (const e of timeline.entries) {
    const cur = merged.at(-1)
    if (cur && cur.end - cur.start < minShotSeconds) {
      cur.end = e.end
      cur.texts.push(e.text)
    } else {
      merged.push({ start: e.start, end: e.end, texts: [e.text], paragraph: e.paragraph })
    }
  }
  // กลุ่มสุดท้ายอาจยังสั้นอยู่ เพราะไม่มีอะไรให้รวมต่อ → ยุบกลับเข้ากลุ่มก่อนหน้า
  if (merged.length > 1) {
    const last = merged.at(-1)
    if (last.end - last.start < minShotSeconds) {
      const prev = merged[merged.length - 2]
      prev.end = last.end
      prev.texts.push(...last.texts)
      merged.pop()
    }
  }

  // 2) ซอยช่วงที่ยังยาวเกิน max ออกเป็นชิ้นเท่าๆ กันรอบ target
  const slots = []
  for (const m of merged) {
    const span = m.end - m.start
    const pieces = span > maxShotSeconds ? Math.ceil(span / targetShotSeconds) : 1
    const piece = span / pieces
    for (let i = 0; i < pieces; i++) {
      const start = m.start + piece * i
      slots.push({
        shot: slots.length + 1,
        start: Number(start.toFixed(2)),
        end: Number((start + piece).toFixed(2)),
        duration: Number(piece.toFixed(2)),
        filename: timecodeFilename(start),
        narration: m.texts.join(' '),
        continuation: i > 0, // ภาพต่อเนื่องในประโยคเดิม → ควรเป็น mini-sequence ไม่ใช่ฉากใหม่
        paragraph: m.paragraph,
      })
    }
  }

  // กันชื่อไฟล์ชนกันเมื่อสอง shot ตกวินาทีเดียวกันหลังปัดเศษ
  // ต้องขยับเป็นหลักสิบวินาทีจริง ไม่ใช่เติม suffix — เพราะขั้น render อ่านเวลาจากชื่อไฟล์กลับ
  const seen = new Set()
  for (const s of slots) {
    let t = s.start
    while (seen.has(timecodeFilename(t))) t += 0.1
    s.filename = timecodeFilename(t)
    seen.add(s.filename)
  }
  return slots
}
