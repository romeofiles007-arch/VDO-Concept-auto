/**
 * Timeline จากการถอดเสียง (เสียงพากย์ที่นำเข้าจากที่อื่น)
 *
 * เสียงที่ระบบสร้างเอง: timeline = ความยาวไฟล์ของแต่ละประโยค + ช่องว่างที่เราแทรก (แม่น 100%)
 * เสียงที่นำเข้า:      timeline = เวลาเริ่ม/จบของแต่ละประโยคจาก Whisper (ต้องให้คนตรวจข้อความ)
 *
 * รูปแบบ entries เหมือน buildTimeline() ทุกอย่าง ขั้นถัดไปจึงใช้ต่อได้ทันที
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { projectDir } from './config.mjs'

const PARAGRAPH_GAP = 2.0 // เงียบนานกว่านี้ถือว่าขึ้นย่อหน้าใหม่ (ช่วงหายใจระหว่างประโยคปกติ ~1.5 วิ)

/** Whisper มักคืนสระอำเป็นนิคหิต + สระอา ("ํา") — หน้าตาเหมือนกันแต่เทียบข้อความกับบทไม่ตรง */
const normalizeThai = (s) => s.normalize('NFC').replace(/ํา/g, 'ำ').replace(/\s+/g, ' ').trim()

export const asrTimelineFile = (slug) => join(projectDir(slug, 'audio'), 'asr_timeline.json')

export function readAsrTimeline(slug) {
  const file = asrTimelineFile(slug)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

/** ทำเสียงใหม่ด้วย TTS → timeline จากการถอดเสียงเดิมใช้ไม่ได้แล้ว */
export function clearAsrTimeline(slug) {
  rmSync(asrTimelineFile(slug), { force: true })
}

/**
 * @param {{start:number,end:number,text:string}[]} segments  เรียงตามเวลา
 */
export function writeAsrTimeline(slug, segments, { duration, language }) {
  const clean = segments
    .map((s) => ({ start: Number(s.start), end: Number(s.end), text: normalizeThai(String(s.text)) }))
    .filter((s) => s.text && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start)

  let paragraph = 0
  const entries = clean.map((s, i) => {
    const next = clean[i + 1]
    const gapAfter = next ? Math.max(0, next.start - s.end) : 0
    const entry = {
      index: i,
      text: s.text,
      paragraph,
      isParagraphEnd: !next || gapAfter >= PARAGRAPH_GAP,
      start: s.start,
      end: s.end,
      duration: s.end - s.start,
      gapAfter,
    }
    if (entry.isParagraphEnd) paragraph++
    return entry
  })
  const timeline = { source: 'asr', language, entries, totalDuration: duration ?? entries.at(-1)?.end ?? 0 }
  writeFileSync(asrTimelineFile(slug), JSON.stringify(timeline, null, 2))
  return timeline
}

/** "(00:00:04,340 --> 00:00:08,660)\nข้อความ" แบบ SayToWords → segments (ใช้ตอนผู้ใช้แก้ข้อความ) */
export function parseSegmentText(text) {
  const stamp = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000
  const out = []
  const re = /\(?\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*\)?\s*\n([\s\S]*?)(?=\n\s*\(?\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->|\s*$)/g
  for (const m of text.replace(/\r\n/g, '\n').matchAll(re)) {
    out.push({
      start: stamp(m[1], m[2], m[3], m[4].padEnd(3, '0')),
      end: stamp(m[5], m[6], m[7], m[8].padEnd(3, '0')),
      text: m[9].replace(/\s*\n\s*/g, ' ').trim(),
    })
  }
  return out
}
