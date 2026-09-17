#!/usr/bin/env node
/**
 * นำเข้าเสียงพากย์ที่ทำจากที่อื่น (ElevenLabs, อัดเอง ฯลฯ) — แทนขั้นที่ 2 (TTS)
 *
 *   node pipeline/import_audio.mjs <slug> <ไฟล์เสียง> [--language th]
 *
 * 1. แปลงเป็น 02_audio/voiceover.wav (24kHz mono) ให้ขั้นตัดต่อใช้ไฟล์เดียวกับเสียงที่ระบบสร้างเอง
 * 2. ถอดเสียงด้วย Whisper ในเครื่อง → ประโยคพร้อมเวลา (แบบ SayToWords)
 * 3. เขียน 02_audio/asr_timeline.json — ขั้นที่ 3 จะใช้เวลาจริงจากไฟล์นี้แทนการวัดความยาวไฟล์ TTS
 * 4. ยังไม่มีบทของ project นี้ → สร้างบทจากข้อความที่ถอดได้
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { loadConfig, projectDir, ROOT, ttsPython } from './lib/config.mjs'
import { run, probeDuration } from './lib/ffmpeg.mjs'
import { hhmmss } from './lib/timecode.mjs'
import { writeAsrTimeline } from './lib/asr.mjs'

const [slug, source, ...rest] = process.argv.slice(2)
if (!slug || !source) {
  console.error('ใช้: node pipeline/import_audio.mjs <slug> <ไฟล์เสียง> [--language th]')
  process.exit(1)
}
if (!existsSync(source)) {
  console.error(`ไม่พบไฟล์เสียง: ${source}`)
  process.exit(1)
}
const langArg = rest.indexOf('--language')
const language = langArg >= 0 ? rest[langArg + 1] : 'th'
const config = loadConfig()

const audioDir = projectDir(slug, 'audio')
const voiceover = join(audioDir, 'voiceover.wav')
console.log('แปลงไฟล์เสียงเป็น voiceover.wav (24kHz mono)…')
await run('ffmpeg', ['-y', '-v', 'error', '-i', source, '-ar', String(config.tts.sampleRate ?? 24000), '-ac', '1', voiceover])
const duration = await probeDuration(voiceover)
console.log(`ความยาว ${hhmmss(duration)}`)

const python = ttsPython(config)
if (!existsSync(python)) {
  console.error(`ยังไม่ได้ติดตั้งระบบเสียง (${python}) — ต้องใช้ faster-whisper ถอดเสียง\nรัน: powershell -ExecutionPolicy Bypass -File scripts\\setup-tts.ps1`)
  process.exit(1)
}
const env = { ...process.env, KMP_DUPLICATE_LIB_OK: 'TRUE', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
delete env.PYTHONHOME
delete env.PYTHONPATH

const transcript = join(audioDir, 'transcript.json')
const code = await new Promise((resolve) => {
  const proc = spawn(python, [join(ROOT, 'tts/asr/transcribe.py'), voiceover, transcript, '--language', language], { cwd: ROOT, env, windowsHide: true })
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.event === 'loading') console.log(`กำลังโหลด ${msg.engine}…`)
    if (msg.event === 'loaded') console.log(`โหลดเสร็จใน ${msg.seconds} วิ — เริ่มถอดเสียง`)
    if (msg.event === 'warning') console.log(msg.message)
    if (msg.event === 'progress') process.stdout.write(`\r  ถอดเสียงแล้ว ${hhmmss(msg.seconds)} / ${hhmmss(msg.total)}`)
    if (msg.event === 'error') console.error(`\nถอดเสียงไม่สำเร็จ: ${msg.message}`)
    if (msg.event === 'done') console.log(`\nได้ ${msg.segments} ประโยค ใน ${msg.seconds} วิ`)
  })
  let stderr = ''
  proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-3000)))
  proc.on('close', (c) => {
    if (c !== 0 && stderr) console.error(stderr)
    resolve(c)
  })
})
if (code !== 0) process.exit(code || 1)

const { segments } = JSON.parse(readFileSync(transcript, 'utf8'))
const timeline = writeAsrTimeline(slug, segments, { duration, language })

// project ที่ยังไม่มีบท (นำเข้าเสียงอย่างเดียว) → ใช้ข้อความที่ถอดได้เป็นบท
const scriptDir = projectDir(slug, 'script')
if (!readdirSync(scriptDir).some((f) => /^script_.*\.txt$/.test(f))) {
  const text = timeline.entries.map((e) => e.text + (e.isParagraphEnd ? '\n' : '')).join('\n').trim() + '\n'
  writeFileSync(join(scriptDir, `script_${slug}.txt`), text, 'utf8')
  const metaFile = join(scriptDir, 'meta.json')
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {}
  writeFileSync(metaFile, JSON.stringify({ ...meta, slug, language, source: 'imported-audio' }, null, 2))
  console.log('สร้างบทจากข้อความที่ถอดได้แล้ว')
}

console.log(`เขียนแล้ว: voiceover.wav · transcript.json · asr_timeline.json (${timeline.entries.length} ประโยค)`)

// ทำ Timecode ต่อทันที → ได้ subtitle.srt / segments.txt ให้ดาวน์โหลดตั้งแต่ขั้นนี้
{
  const { execFileSync } = await import('node:child_process')
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'pipeline', '3_timecode.mjs'), slug], { cwd: ROOT, encoding: 'utf8' })
    console.log(out.trim().split(/\r?\n/).slice(0, -1).join('\n')) // ตัดบรรทัด "ขั้นต่อไป: ..." ของสคริปต์ออก
  } catch (err) {
    console.warn(`ทำ Timecode ไม่สำเร็จ: ${String(err.stderr || err.message).trim()}`)
  }
}
console.log('ตรวจแก้ข้อความที่ถอดผิดได้ในแผงข้าง แล้วไปทำ prompt ภาพต่อ')
