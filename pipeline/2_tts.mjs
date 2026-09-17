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
import { loadConfig, projectDir, ROOT, ttsPython } from './lib/config.mjs'
import { segmentScript, estimateMinutes } from './lib/segment.mjs'
import { probeDuration, concatAudio, trimSilence, eachLimit } from './lib/ffmpeg.mjs'
import { hhmmss } from './lib/timecode.mjs'
import { selectedVoice } from './lib/voices.mjs'
import { synthCloud, edgeVoiceFits, defaultEdgeVoice } from './lib/cloud_tts.mjs'
import { clearAsrTimeline } from './lib/asr.mjs'

const slug = process.argv[2]
if (!slug) {
  console.error('ใช้: node pipeline/2_tts.mjs <slug>')
  process.exit(1)
}

const config = loadConfig()
// ทำเสียงใหม่ด้วย TTS → เวลาจากไฟล์เสียงที่เคยนำเข้าไม่ตรงแล้ว
clearAsrTimeline(slug)
const scriptDir = projectDir(slug, 'script')
const scriptFile = readdirSync(scriptDir).find((f) => f.endsWith('.txt'))
if (!scriptFile) {
  console.error(`ไม่พบไฟล์ script ใน ${scriptDir} — รันขั้นที่ 1 ก่อน`)
  process.exit(1)
}

const metaFile = join(scriptDir, 'meta.json')
const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {}
const language = meta.language ?? config.script.language

const cloud = ['edge', 'gemini'].includes(config.tts.engine) ? config.tts[config.tts.engine] : null
const myVoice = config.tts.engine === 'my-voice' ? config.tts.myVoice : null
const voice = myVoice && selectedVoice(config)
if (myVoice && !voice) {
  console.error(`เสียง "${myVoice.voice}" ยังไม่พร้อมใช้ (ยังไม่เทรน หรือไฟล์โมเดลหาย) — เลือกเสียงอื่นในแผงข้าง`)
  process.exit(1)
}

// engine ไทยกับอังกฤษคนละตัวกัน — เตือนก่อนเสียเวลา gen ทั้งคลิป
if (language === 'en' && ['f5-tts-thai', 'my-voice'].includes(config.tts.engine)) {
  console.warn('สคริปต์เป็นภาษาอังกฤษแต่ engine ตั้งไว้เป็น f5-tts-thai')
  console.warn('แนะนำสลับเป็น chatterbox ใน config ก่อน')
}

const script = readFileSync(join(scriptDir, scriptFile), 'utf8')
const segments = segmentScript(script)
console.log(`script: ${scriptFile} · ภาษา ${language}`)
console.log(`${segments.length} segments · ประมาณ ${estimateMinutes(script, config.script.wordsPerMinute).toFixed(1)} นาที`)

const audioDir = projectDir(slug, 'audio')
const partsDir = join(audioDir, 'segments')
mkdirSync(partsDir, { recursive: true })

const refAudio = join(ROOT, config.tts.referenceVoice)
if (!myVoice && !cloud && !existsSync(refAudio)) {
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
      language,
      sample_rate: config.tts.sampleRate,
      ...(myVoice && {
        ckpt: voice.ckpt,
        vocab: voice.vocab,
        references: voice.references,
        emotion: myVoice.emotion,
        speed: myVoice.speed,
        nfe_step: myVoice.nfeStep,
        cfg_strength: myVoice.cfgStrength,
        transliterate: myVoice.transliterate,
      }),
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

/** progress จาก worker ทุกตัว (python / เสียงออนไลน์) ใช้รูปแบบเดียวกัน */
function printEvent(msg) {
  if (msg.event === 'loading') console.log(`กำลังโหลดโมเดล ${msg.engine}...`)
  if (msg.event === 'loaded') console.log(`โหลดเสร็จใน ${msg.seconds} วิ`)
  if (msg.event === 'segment') process.stdout.write(`  ${msg.index + 1}/${msg.total} segments`)
  if (msg.event === 'error') console.error(`
TTS ล้มเหลว: ${msg.message}`)
  if (msg.event === 'done') console.log(`
สังเคราะห์ ${msg.total} segments ใน ${msg.seconds} วิ`)
}

// ── เสียงคนอื่น (ออนไลน์): Edge / Gemini ──
if (cloud && config.tts.engine === 'edge' && !edgeVoiceFits(cloud.voice, language)) {
  const fallback = defaultEdgeVoice(language)
  console.warn(`เสียง ${cloud.voice} อ่านภาษาไทยไม่ได้ (Microsoft จะไม่ส่งเสียงกลับมา) — ใช้ ${fallback} แทนสำหรับคลิปนี้`)
  console.warn('ถ้าอยากได้เสียงอื่น เลือกเสียงไทยหรือเสียง "หลายภาษา" ในแผงข้าง')
  cloud.voice = fallback
}
if (cloud) {
  const shared = config.tts.myVoice ?? {}
  console.log(`เสียง ${config.tts.engine} · ${cloud.voice}${cloud.model ? ` (${cloud.model})` : ''} · อารมณ์ ${shared.emotion ?? 'calm'} · ความเร็ว ${shared.speed ?? 1}`)
  try {
    await synthCloud(
      config.tts.engine,
      segments.map((s) => ({ index: s.index, text: s.text, out: join(partsDir, `${String(s.index).padStart(4, '0')}.wav`) })),
      { voice: cloud.voice, model: cloud.model, emotion: shared.emotion, speed: shared.speed, sampleRate: config.tts.sampleRate },
      printEvent,
    )
  } catch (err) {
    console.error(`
TTS ล้มเหลว: ${err.message}`)
    process.exit(3)
  }
}

// ระบบเสียงในเครื่อง (tts/.venv) — ติดตั้งครั้งเดียวด้วย scripts/setup-tts.ps1
const python = cloud ? null : ttsPython(config)
if (!cloud && !existsSync(python)) {
  console.error(`ยังไม่ได้ติดตั้งระบบเสียง (${python})\nรัน: powershell -ExecutionPolicy Bypass -File scripts\\setup-tts.ps1`)
  process.exit(1)
}
if (myVoice) console.log(`เสียง ${voice.label} · อารมณ์ ${myVoice.emotion} · ความเร็ว ${myVoice.speed}`)

const worker = join(ROOT, myVoice ? 'tts/myvoice/synth_myvoice.py' : 'tts/synth.py')
// PYTHONHOME/PYTHONPATH ของ Python ตัวอื่นในเครื่อง (เช่น DaVinci Resolve) ทำให้ venv เปิดไม่ขึ้น
const env = { ...process.env, KMP_DUPLICATE_LIB_OK: 'TRUE', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
delete env.PYTHONHOME
delete env.PYTHONPATH

const code = cloud ? 0 : await new Promise((resolve) => {
  const proc = spawn(python, [worker, jobFile], { cwd: ROOT, env, windowsHide: true })
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
  // f5_tts_th พ่น warning/progress bar ลง stderr ตลอด — เก็บไว้แสดงเฉพาะตอนพัง
  let stderrTail = ''
  proc.stderr.on('data', (d) => {
    if (!myVoice) return process.stderr.write(d)
    stderrTail = (stderrTail + d.toString('utf8')).slice(-4000)
  })
  proc.on('close', (exitCode) => {
    if (exitCode !== 0 && stderrTail) process.stderr.write(`\n${stderrTail}\n`)
    resolve(exitCode)
  })
})
if (code !== 0) process.exit(code)

const parts = segments.map((s) => ({
  file: join(partsDir, `${String(s.index).padStart(4, '0')}.wav`),
  gapAfter: (s.isParagraphEnd ? config.tts.paragraphGapMs : config.tts.segmentGapMs) / 1000,
}))

// TTS แถมความเงียบหัวท้ายทุกไฟล์ (Edge ท้ายไฟล์ ~0.9 วิ) → รวมกับช่วงเว้นแล้วเงียบนานเกิน ตัดทิ้งก่อนต่อ
if (config.tts.trimSilence !== false) {
  console.log('ตัดช่วงเงียบหัวท้ายของแต่ละประโยค…')
  await eachLimit(parts, 6, (p) => trimSilence(p.file))
}

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

