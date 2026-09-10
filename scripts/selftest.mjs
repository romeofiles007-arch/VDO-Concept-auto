#!/usr/bin/env node
/**
 * ทดสอบ pipeline ขั้นที่ 3 (timecode) + ขั้นที่ 6 (render) แบบครบวงจร โดยไม่ต้องมี API key
 * ใช้เสียงสังเคราะห์จาก ffmpeg แทน TTS และภาพสีทึบแทนภาพจาก Gemini
 *
 *   node scripts/selftest.mjs
 */
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, projectDir, ROOT } from '../pipeline/lib/config.mjs'
import { segmentScript, estimateMinutes } from '../pipeline/lib/segment.mjs'
import { hhmmss } from '../pipeline/lib/timecode.mjs'
import { run, probeDuration, concatAudio } from '../pipeline/lib/ffmpeg.mjs'
import { collectImages } from '../pipeline/lib/shotfile.mjs'

const SLUG = '_selftest'
const config = loadConfig()

const SCRIPT = `คุณเคยเดินเข้าห้องแล้วลืมว่ามาทำอะไรใช่ไหม

วางกุญแจไว้ที่ไหนไม่รู้
จำชื่อคนที่เพิ่งแนะนำตัวไปไม่ได้
ลืมว่าตั้งใจจะโทรหาใคร

คุณอาจจะโทษตัวเองมาตลอด... ว่าความจำแย่ สมองไม่ดี ขี้ลืมเป็นนิสัย
แต่ความจริงแปลกกว่านั้นเยอะ

สมองคุณไม่ได้บกพร่อง มันแค่กำลังทำงานตามแบบที่วิวัฒนาการออกแบบมาตั้งแต่หลายแสนปีก่อน
และงานนั้นคือการลืม`

if (existsSync(projectDir(SLUG))) rmSync(projectDir(SLUG), { recursive: true, force: true })

// ── ขั้นที่ 1 (จำลอง) ────────────────────────────────────────────
const segments = segmentScript(SCRIPT)
console.log(`\n[1] script → ${segments.length} segments · ประมาณ ${estimateMinutes(SCRIPT).toFixed(2)} นาที`)

// ── ขั้นที่ 2 (จำลอง TTS ด้วยเสียงสังเคราะห์ ความยาวตามจำนวนตัวอักษร) ──
const audioDir = projectDir(SLUG, 'audio')
const partsDir = join(audioDir, 'segments')
mkdirSync(partsDir, { recursive: true })
const parts = []
for (const seg of segments) {
  const dur = Math.max(0.8, [...seg.text].length / 14) // ~14 ตัวอักษร/วินาที
  const file = join(partsDir, `${String(seg.index).padStart(4, '0')}.wav`)
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=${220 + seg.index * 20}:r=24000`, '-t', dur.toFixed(3), '-ac', '1', '-c:a', 'pcm_s16le', file])
  parts.push({ file, gapAfter: (seg.isParagraphEnd ? config.tts.paragraphGapMs : config.tts.segmentGapMs) / 1000 })
}
const voiceover = join(audioDir, 'voiceover.wav')
await concatAudio(parts, voiceover, { sampleRate: config.tts.sampleRate })
const durations = []
for (const p of parts) durations.push(await probeDuration(p.file))
console.log(`[2] TTS จำลอง → ${parts.length} ไฟล์ → voiceover.wav`)

// ── ขั้นที่ 3 + 4 — เรียก step จริง ไม่จำลอง ────────────────────
writeFileSync(join(audioDir, 'segments.json'), JSON.stringify(segments, null, 2))
writeFileSync(join(audioDir, 'durations.json'), JSON.stringify(durations, null, 2))

const { spawnSync } = await import('node:child_process')
const step = (file) => {
  const r = spawnSync(process.execPath, [join(ROOT, file), SLUG], { stdio: 'inherit', cwd: ROOT })
  if (r.status !== 0) throw new Error(`${file} ล้มเหลว`)
}
console.log('[3] timecode')
step('pipeline/3_timecode.mjs')

const timeline = JSON.parse(readFileSync(join(projectDir(SLUG, 'timecode'), 'timecode.json'), 'utf8'))
const slots = JSON.parse(readFileSync(join(projectDir(SLUG, 'shotlist'), 'slots.json'), 'utf8'))
const realDuration = await probeDuration(voiceover)
if (Math.abs(realDuration - timeline.totalDuration) > 0.15) throw new Error('timecode คลาดเคลื่อนเกินรับได้')
const tooLong = slots.filter((s) => s.duration > config.timecode.maxShotSeconds + 0.01)
const tooShort = slots.filter((s) => s.duration < config.timecode.minShotSeconds - 0.01)
console.log(`[4] shot slots → ${slots.length} ช่อง · ยาวเกิน ${tooLong.length} · สั้นเกิน ${tooShort.length}`)
if (tooLong.length) throw new Error('มี shot ยาวเกิน maxShotSeconds')
if (tooShort.length) throw new Error(`มี shot สั้นกว่า minShotSeconds: ${tooShort.map((s) => `${s.filename} ${s.duration}s`).join(', ')}`)

// ── ขั้นที่ 5 (จำลอง) — ภาพสีทึบตั้งชื่อตาม timecode ─────────────
const imagesDir = projectDir(SLUG, 'images')
const palette = ['#F5820D', '#2D5FBF', '#3A9E3A', '#F5C518', '#D94040', '#8B5E3C', '#6EB5E8', '#C4965A']
const font = 'C\\:/Windows/Fonts/arial.ttf'
for (const s of slots) {
  await run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `color=c=${palette[(s.shot - 1) % palette.length]}:s=1920x1080`,
    '-vf', `drawtext=fontfile='${font}':text='SHOT ${String(s.shot).padStart(2, '0')}':fontcolor=white:fontsize=140:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-frames:v', '1', join(imagesDir, s.filename),
  ])
}
const { images, ignored } = collectImages(imagesDir)
console.log(`[5] ภาพจำลอง → ${images.length} ใบ · ชื่อผิดรูป ${ignored.length}`)
if (images.length !== slots.length) throw new Error('อ่านชื่อไฟล์ภาพกลับเป็น timecode ไม่ครบ')

// ── ขั้นที่ 6 — render ───────────────────────────────────────────
step('pipeline/6_render.mjs')

const mp4 = join(projectDir(SLUG, 'render'), `${SLUG}.mp4`)
const videoDuration = await probeDuration(mp4)
console.log(`\nวิดีโอยาว ${hhmmss(videoDuration)} · เสียงยาว ${hhmmss(realDuration)} · คลาด ${((videoDuration - realDuration) * 1000).toFixed(0)} ms`)
if (Math.abs(videoDuration - realDuration) > 0.5) throw new Error('ความยาววิดีโอไม่ตรงกับเสียง')

console.log(`\nผ่านครบทุกขั้น → ${mp4}\n`)
