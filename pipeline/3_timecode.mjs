#!/usr/bin/env node
/**
 * ขั้นที่ 3 — Timecode Map + ช่อง shot
 *
 * อ่านความยาวจริงของแต่ละ segment ที่ขั้นที่ 2 วัดไว้ → ได้ timeline ที่ตรงกับไฟล์เสียง 100%
 * (Blueprint V3 ให้ผู้ใช้ฟังแล้วพิมพ์เอง หรือรัน Whisper — เราข้ามทั้งสองอย่าง)
 *
 *   node pipeline/3_timecode.mjs <slug>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, projectDir } from './lib/config.mjs'
import { buildTimeline, buildShotSlots, toBlueprintText, toSegmentText, toSrt, hhmmss } from './lib/timecode.mjs'
import { probeDuration } from './lib/ffmpeg.mjs'
import { readAsrTimeline } from './lib/asr.mjs'

const slug = process.argv[2]
if (!slug) {
  console.error('ใช้: node pipeline/3_timecode.mjs <slug>')
  process.exit(1)
}

const config = loadConfig()
const audioDir = projectDir(slug, 'audio')
// เสียงที่นำเข้าจากที่อื่น → ใช้เวลาจากการถอดเสียง (import_audio.mjs) แทนความยาวไฟล์ TTS
const asr = readAsrTimeline(slug)
if (!asr) {
  for (const f of ['segments.json', 'durations.json']) {
    if (!existsSync(join(audioDir, f))) {
      console.error(`ไม่พบ ${f} — รันขั้นที่ 2 (TTS) หรือนำเข้าไฟล์เสียงก่อน`)
      process.exit(1)
    }
  }
}
const timeline = asr ?? buildTimeline(
  JSON.parse(readFileSync(join(audioDir, 'segments.json'), 'utf8')),
  JSON.parse(readFileSync(join(audioDir, 'durations.json'), 'utf8')),
  config.tts,
)
if (asr) console.log('ใช้เวลาจากการถอดเสียงไฟล์ที่นำเข้า')

const tcDir = projectDir(slug, 'timecode')
writeFileSync(join(tcDir, 'timecode.json'), JSON.stringify(timeline, null, 2))
writeFileSync(join(tcDir, 'timecode.txt'), toBlueprintText(timeline)) // [M:SS] ตาม OUTPUT 3
writeFileSync(join(tcDir, 'segments.txt'), toSegmentText(timeline)) // format เดียวกับ saytowords
writeFileSync(join(tcDir, 'subtitle.srt'), toSrt(timeline))

const slots = buildShotSlots(timeline, config.timecode)
writeFileSync(join(projectDir(slug, 'shotlist'), 'slots.json'), JSON.stringify(slots, null, 2))

// ตรวจว่า timeline ตรงกับไฟล์เสียงจริง — ถ้าเพี้ยนแปลว่าขั้นที่ 2 กับ 3 หลุด sync กัน
const voiceover = join(audioDir, 'voiceover.wav')
if (existsSync(voiceover)) {
  const real = await probeDuration(voiceover)
  const drift = Math.abs(real - timeline.totalDuration)
  console.log(`ไฟล์เสียงจริง ${hhmmss(real)} · timeline ${hhmmss(timeline.totalDuration)} · คลาด ${(drift * 1000).toFixed(0)} ms`)
  if (drift > 0.25) console.warn('เตือน: คลาดเกิน 250ms — ลองรันขั้นที่ 2 ใหม่')
}

console.log(`${timeline.entries.length} segments → ${slots.length} shots · เฉลี่ย ${(timeline.totalDuration / slots.length).toFixed(1)} วิ/ภาพ`)
console.log(`เขียนแล้ว: timecode.json · timecode.txt · segments.txt · subtitle.srt · slots.json`)
console.log(`ขั้นต่อไป: node pipeline/4_shotlist.mjs ${slug}`)
