#!/usr/bin/env node
/**
 * ปรับช่วงเงียบของคลิปที่ทำเสียงไปแล้ว — ไม่ต้องสร้างเสียงใหม่ ไม่ต้องสร้างภาพใหม่
 *
 *   node pipeline/retime_audio.mjs <slug> [--pause tight|normal|wide]
 *
 * 1. ตัดความเงียบหัวท้ายของไฟล์เสียงแต่ละประโยค แล้วต่อใหม่ด้วยช่วงเว้นที่เลือก
 * 2. ย้ายเวลาของทุกช็อตตามประโยคที่มันอยู่ (ช็อตเดิม prompt เดิม ภาพเดิม แค่ขึ้นเร็วขึ้น)
 * 3. เปลี่ยนชื่อไฟล์ภาพ + shot list ให้ตรง timecode ใหม่ แล้วตัดต่อใหม่ได้เลย
 *
 * ใช้ได้เฉพาะเสียงที่ระบบสร้างเอง (มีไฟล์แยกประโยคใน 02_audio/segments) — เสียงที่นำเข้าจากที่อื่นไม่มีไฟล์แยก
 * ของเดิมสำรองไว้ที่ 02_audio/_before_retime_<เวลา>/
 */
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { loadConfig, projectDir, ROOT } from './lib/config.mjs'
import { probeDuration, concatAudio, trimSilence, eachLimit, PAUSE_PRESETS } from './lib/ffmpeg.mjs'
import { buildTimeline, timecodeFilename, hhmmss } from './lib/timecode.mjs'
import { readAsrTimeline } from './lib/asr.mjs'
import { shotlistFiles, readRounds, mergeRounds } from './lib/shotlist.mjs'

const [slug, ...rest] = process.argv.slice(2)
if (!slug) {
  console.error('ใช้: node pipeline/retime_audio.mjs <slug> [--pause tight|normal|wide]')
  process.exit(1)
}
const config = loadConfig()
const pauseArg = rest.includes('--pause') ? rest[rest.indexOf('--pause') + 1] : config.tts.pause
const pause = PAUSE_PRESETS[pauseArg] ?? { segmentGapMs: config.tts.segmentGapMs, paragraphGapMs: config.tts.paragraphGapMs, label: 'ตาม config' }

const audioDir = projectDir(slug, 'audio')
const tcFile = join(projectDir(slug, 'timecode'), 'timecode.json')
if (readAsrTimeline(slug)) {
  console.error('คลิปนี้ใช้เสียงที่นำเข้าจากที่อื่น — ไม่มีไฟล์แยกประโยค ปรับช่วงเงียบอัตโนมัติไม่ได้')
  process.exit(1)
}
for (const f of [join(audioDir, 'segments.json'), tcFile]) {
  if (!existsSync(f)) {
    console.error(`ไม่พบ ${f} — ทำเสียงพากย์ก่อน`)
    process.exit(1)
  }
}

const segments = JSON.parse(readFileSync(join(audioDir, 'segments.json'), 'utf8'))
const oldTimeline = JSON.parse(readFileSync(tcFile, 'utf8'))
const files = segments.map((s) => join(audioDir, 'segments', `${String(s.index).padStart(4, '0')}.wav`))
if (files.some((f) => !existsSync(f)) || oldTimeline.entries.length !== segments.length) {
  console.error('ไฟล์เสียงแยกประโยคไม่ครบหรือไม่ตรงกับ timecode — สร้างเสียงพากย์ใหม่แทน')
  process.exit(1)
}

// ── สำรองของเดิมไว้ก่อน (เสียง, timecode, ช่อง shot) — ย้อนกลับได้ ──
const sf = shotlistFiles(slug)
const backup = join(audioDir, `_before_retime_${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(backup, { recursive: true })
for (const f of ['voiceover.wav', 'durations.json']) if (existsSync(join(audioDir, f))) copyFileSync(join(audioDir, f), join(backup, f))
copyFileSync(tcFile, join(backup, 'timecode.json'))
const oldSlots = existsSync(sf.slots) ? JSON.parse(readFileSync(sf.slots, 'utf8')) : null
if (oldSlots) copyFileSync(sf.slots, join(backup, 'slots.json'))

// ── เสียง: ตัดเงียบหัวท้าย → ต่อใหม่ด้วยช่วงเว้นที่เลือก ──
console.log(`ช่วงเงียบแบบ "${pause.label}" (ระหว่างประโยค ${pause.segmentGapMs}ms · ขึ้นย่อหน้า ${pause.paragraphGapMs}ms)`)
console.log('ตัดความเงียบหัวท้ายของแต่ละประโยค…')
await eachLimit(files, 6, (f) => trimSilence(f))
const durations = []
for (const f of files) durations.push(await probeDuration(f))
const newTimeline = buildTimeline(segments, durations, pause)

await concatAudio(
  newTimeline.entries.map((e, i) => ({ file: files[i], gapAfter: e.gapAfter })),
  join(audioDir, 'voiceover.wav'),
  { sampleRate: config.tts.sampleRate },
)
writeFileSync(join(audioDir, 'durations.json'), JSON.stringify(durations, null, 2))
const total = await probeDuration(join(audioDir, 'voiceover.wav'))
console.log(`เสียงพากย์ ${hhmmss(oldTimeline.totalDuration)} → ${hhmmss(total)}`)

// config ใหม่ต้องตรงกับเสียงที่เพิ่งต่อ — 3_timecode อ่านช่วงเว้นจาก config
{
  const cfgFile = join(ROOT, 'config', 'project.config.json')
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
  Object.assign(cfg.tts, { segmentGapMs: pause.segmentGapMs, paragraphGapMs: pause.paragraphGapMs, ...(PAUSE_PRESETS[pauseArg] && { pause: pauseArg }) })
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n')
}
execFileSync(process.execPath, [join(ROOT, 'pipeline', '3_timecode.mjs'), slug], { cwd: ROOT, stdio: 'ignore' })

if (!oldSlots) {
  console.log('ยังไม่มี shot list — เสร็จแล้ว')
  process.exit(0)
}

// ── ช็อต: ใช้ช็อตเดิมทั้งหมด แค่ย้ายเวลาตามประโยคที่มันอยู่ ──
const oldE = oldTimeline.entries
const newE = newTimeline.entries
function mapTime(t) {
  let i = oldE.findLastIndex((e) => e.start <= t + 1e-6)
  if (i < 0) i = 0
  const rel = t - oldE[i].start
  const ratio = oldE[i].duration > 0 ? newE[i].duration / oldE[i].duration : 1
  const span = newE[i].duration + (newE[i].gapAfter ?? 0)
  return Math.max(0, newE[i].start + Math.min(rel * ratio, Math.max(0, span - 0.1)))
}

const rename = new Map() // ชื่อเดิม → ชื่อใหม่
const used = new Set()
const newSlots = oldSlots.map((s) => {
  let start = Math.round(mapTime(s.start) * 10) / 10
  let filename = timecodeFilename(start)
  while (used.has(filename)) {
    start = Math.round((start + 0.1) * 10) / 10 // ชื่อชนกันเพราะช็อตถูกบีบ → เลื่อน 0.1 วิ
    filename = timecodeFilename(start)
  }
  used.add(filename)
  rename.set(s.filename, filename)
  return { ...s, start, filename }
})
newSlots.forEach((s, i) => {
  s.end = newSlots[i + 1]?.start ?? total
  s.duration = Math.round((s.end - s.start) * 100) / 100
})
writeFileSync(sf.slots, JSON.stringify(newSlots, null, 2))

// ภาพ: เปลี่ยนชื่อสองจังหวะ (ชื่อใหม่อาจชนกับชื่อเก่าของช็อตอื่น)
const imagesDir = projectDir(slug, 'images')
const images = readdirSync(imagesDir).filter((f) => rename.has(f))
for (const f of images) renameSync(join(imagesDir, f), join(imagesDir, `__retime__${f}`))
for (const f of images) renameSync(join(imagesDir, `__retime__${f}`), join(imagesDir, rename.get(f)))
const filledFile = join(imagesDir, '_filled.json')
if (existsSync(filledFile)) {
  writeFileSync(filledFile, JSON.stringify(JSON.parse(readFileSync(filledFile, 'utf8')).map((f) => rename.get(f) ?? f), null, 2))
}

// shot list จาก ChatGPT: แทนชื่อไฟล์ในทุกรอบ แล้วรวมใหม่ (prompt เดิมทุกช็อต)
const roundsDir = sf.rounds
if (existsSync(roundsDir)) {
  const pattern = /\d{2}_\d{2}_\d{2}(?:_\d)?\.png/g
  for (const f of readdirSync(roundsDir).filter((x) => /^\d+\.txt$/.test(x))) {
    const file = join(roundsDir, f)
    writeFileSync(file, readFileSync(file, 'utf8').replace(pattern, (name) => rename.get(name) ?? name))
  }
  if (readRounds(slug).length) mergeRounds(slug)
}

const moved = [...rename].filter(([a, b]) => a !== b).length
console.log(`ย้ายเวลา ${moved}/${newSlots.length} ช็อต · เปลี่ยนชื่อภาพ ${images.length} ใบ`)
console.log(`สำรองของเดิมไว้ที่ ${backup}`)
console.log('ขั้นต่อไป: ตัดต่อวิดีโอใหม่')
