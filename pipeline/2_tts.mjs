#!/usr/bin/env node
/**
 * ขั้นที่ 2 — script → เสียงพากย์ (local TTS)
 *
 * ยิงทีละ segment โดยตั้งใจ ไม่ยิงรวดเดียวทั้งไฟล์ เพราะความยาวของแต่ละ segment
 * คือที่มาของ timecode ในขั้นที่ 3 — ทำให้ไม่ต้องถอดเสียงกลับด้วย ASR
 *
 *   node pipeline/2_tts.mjs <slug>
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { loadConfig, projectDir, ROOT } from './lib/config.mjs'
import { segmentScript, estimateMinutes } from './lib/segment.mjs'
import { probeDuration, concatAudio } from './lib/ffmpeg.mjs'
import { hhmmss } from './lib/timecode.mjs'

const slug = process.argv[2]
if (!slug) {
  console.error('ใช้: node pipeline/2_tts.mjs <slug>')
  process.exit(1)
}

const config = loadConfig()
const scriptDir = projectDir(slug, 'script')
const scriptFile = readdirSync(scriptDir).find((f) => f.endsWith('.txt'))
if (!scriptFile) {
  console.error(`ไม่พบไฟล์ script ใน ${scriptDir} — รันขั้นที่ 1 ก่อน`)
  process.exit(1)
}

const script = readFileSync(join(scriptDir, scriptFile), 'utf8')
const segments = segmentScript(script)
console.log(`script: ${scriptFile}`)
console.log(`${segments.length} segments · ประมาณ ${estimateMinutes(script, config.script.wordsPerMinute).toFixed(1)} นาที`)

const audioDir = projectDir(slug, 'audio')
const partsDir = join(audioDir, 'segments')
mkdirSync(partsDir, { recursive: true })

const refAudio = join(ROOT, config.tts.referenceVoice)
if (!existsSync(refAudio)) {
  console.error(`ไม่พบเสียงต้นแบบ: ${refAudio}\nวางไฟล์ wav 10-15 วิ แล้วใส่ข้อความที่พูดลงใน config -> tts.referenceText`)
  process.exit(1)
}

// เขียน job ให้ Python ทำรวดเดียว — โหลดโมเดลครั้งเดียวประหยัดกว่าเรียกทีละครั้งมาก
const jobFile = join(audioDir, 'tts_job.json')
writeFileSync(
  jobFile,
  JSON.stringify(
    {
      engine: config.tts.engine,
      ref_audio: refAudio,
      ref_text: config.tts.referenceText,
      language: config.script.language,
      sample_rate: config.tts.sampleRate,
      segments: segments.map((s) => ({
        index: s.index,
        text: s.text,
        out: join(partsDir, `${String(s.index).padStart(4, '0')}.wav`),
      })),
    },
    null,
    2,
  ),
)
writeFileSync(join(audioDir, 'segments.json'), JSON.stringify(segments, null, 2))

const python = join(ROOT, config.tts.pythonVenv, 'Scripts/python.exe')
if (!existsSync(python)) {
  console.error(`ไม่พบ venv: ${python}\nรัน: powershell -ExecutionPolicy Bypass -File scripts\\setup-tts.ps1`)
  process.exit(1)
}

const code = await new Promise((resolve) => {
  const proc = spawn(python, [join(ROOT, 'tts/synth.py'), jobFile], { cwd: ROOT })
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return console.log(line)
    }
    if (msg.event === 'loading') console.log(`กำลังโหลดโมเดล ${msg.engine}...`)
    if (msg.event === 'loaded') console.log(`โหลดเสร็จใน ${msg.seconds} วิ`)
    if (msg.event === 'segment') process.stdout.write(`\r  ${msg.index + 1}/${msg.total} segments`)
    if (msg.event === 'error') console.error(`\nTTS ล้มเหลว: ${msg.message}`)
    if (msg.event === 'done') console.log(`\nสังเคราะห์ ${msg.total} segments ใน ${msg.seconds} วิ`)
  })
  proc.stderr.on('data', (d) => process.stderr.write(d))
  proc.on('close', resolve)
})
if (code !== 0) process.exit(code)

const parts = segments.map((s) => ({
  file: join(partsDir, `${String(s.index).padStart(4, '0')}.wav`),
  gapAfter: (s.isParagraphEnd ? config.tts.paragraphGapMs : config.tts.segmentGapMs) / 1000,
}))

const durations = []
for (const p of parts) durations.push(await probeDuration(p.file))
writeFileSync(join(audioDir, 'durations.json'), JSON.stringify(durations, null, 2))

const voiceover = join(audioDir, 'voiceover.wav')
await concatAudio(parts, voiceover, { sampleRate: config.tts.sampleRate })
const total = await probeDuration(voiceover)

console.log(`\nvoiceover.wav · ${hhmmss(total)}`)
const target = config.script.targetMinutes
if (Math.abs(total / 60 - target) > target * 0.2) {
  console.warn(`เตือน: ตั้งเป้า ${target} นาที แต่ได้ ${(total / 60).toFixed(1)} นาที — อาจต้องแก้ความยาว script`)
}
console.log(`ขั้นต่อไป: node pipeline/3_timecode.mjs ${slug}`)
