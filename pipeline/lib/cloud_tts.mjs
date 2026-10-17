/**
 * เสียงคนอื่น (ออนไลน์) — อีกตัวเลือกนอกจากเสียงของเรา
 *
 *   edge        Microsoft Edge TTS ผ่าน edge-tts — ฟรี ไม่ต้องใช้ key (บริการไม่เป็นทางการ อาจเปลี่ยนได้)
 *   gemini      Gemini TTS — ต้องมี GEMINI_API_KEY (รุ่น flash มีโควตาฟรี แต่จำกัดจำนวนครั้งต่อวัน)
 *   elevenlabs  ElevenLabs — เสียงที่โคลนไว้ในบัญชี อ้างด้วย Voice ID · ต้องมี ELEVENLABS_API_KEY · ใช้เครดิตตามจำนวนตัวอักษร
 *
 * ทำทีละ segment เหมือนเสียงของเรา → ความยาวแต่ละไฟล์ใช้ทำ timecode ต่อได้ทันที
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { ROOT } from './config.mjs'
import { run } from './ffmpeg.mjs'
import { loadEnv } from './env.mjs'

/**
 * edge-tts ลงไว้ใน tts/.venv ตัวเดียวกับระบบเสียงหลัก · runtime/python คือ Python ที่แถมมากับแพ็กเกจลูกค้า
 * (มี edge-tts ในตัว ใช้ได้ทันทีโดยไม่ต้องติดตั้ง) · .venv-edge ใช้กับเครื่องที่ลงแค่ edge-tts
 */
export function edgePython() {
  const main = join(ROOT, 'tts', '.venv')
  if (existsSync(join(main, 'Lib', 'site-packages', 'edge_tts'))) return join(main, 'Scripts', 'python.exe')
  const bundled = join(ROOT, 'runtime', 'python')
  if (existsSync(join(bundled, 'Lib', 'site-packages', 'edge_tts'))) return join(bundled, 'python.exe')
  return join(ROOT, 'tts', '.venv-edge', 'Scripts', 'python.exe')
}

function pythonEnv() {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
  delete env.PYTHONHOME
  delete env.PYTHONPATH
  return env
}

/** รัน worker ของ edge-tts หนึ่งรอบ → ข้อความ error หรือ null ถ้าสำเร็จ */
function edgeRun(jobFile, onEvent) {
  let error = null
  return new Promise((resolve) => {
    const proc = spawn(edgePython(), [join(ROOT, 'tts/cloud/edge_synth.py'), jobFile], { cwd: ROOT, env: pythonEnv(), windowsHide: true })
    createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (msg.event === 'error') error = msg.message
        else if (msg.event !== 'loading' && msg.event !== 'done') onEvent(msg)
      } catch {}
    })
    let stderr = ''
    proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)))
    proc.on('close', (c) => resolve(c === 0 ? null : error || stderr.trim() || `edge-tts จบด้วย exit ${c}`))
  })
}

/** pip install --upgrade edge-tts ใน venv ที่ใช้อยู่ → true ถ้าติดตั้งสำเร็จ */
function edgeUpgrade() {
  return new Promise((resolve) => {
    const proc = spawn(edgePython(), ['-m', 'pip', 'install', '-q', '--upgrade', 'edge-tts'], { cwd: ROOT, env: pythonEnv(), windowsHide: true })
    proc.on('error', () => resolve(false))
    proc.on('close', (c) => resolve(c === 0))
  })
}

// รายชื่อเสียงทั้งหมดที่พากย์ได้จริง — สร้างใหม่ด้วย node scripts/update-edge-voices.mjs
const EDGE_CATALOG = JSON.parse(readFileSync(join(ROOT, 'pipeline', 'lib', 'edge_voices.json'), 'utf8'))

const ACCENT = {
  'en-US': 'อเมริกัน', 'en-GB': 'บริติช', 'en-AU': 'ออสเตรเลีย', 'en-CA': 'แคนาดา', 'en-IN': 'อินเดีย', 'en-IE': 'ไอริช',
  'en-NZ': 'นิวซีแลนด์', 'en-ZA': 'แอฟริกาใต้', 'en-SG': 'สิงคโปร์', 'en-PH': 'ฟิลิปปินส์', 'en-HK': 'ฮ่องกง', 'en-KE': 'เคนยา',
  'en-NG': 'ไนจีเรีย', 'en-TZ': 'แทนซาเนีย', 'th-TH': 'ไทย', 'fr-FR': 'ฝรั่งเศส', 'de-DE': 'เยอรมัน', 'it-IT': 'อิตาลี',
  'ko-KR': 'เกาหลี', 'pt-BR': 'บราซิล',
}
const TONE = {
  Friendly: 'เป็นมิตร', Positive: 'สดใส', Expressive: 'มีอารมณ์', Caring: 'ใส่ใจ', Pleasant: 'น่าฟัง', Warm: 'อบอุ่น',
  Confident: 'มั่นใจ', Authentic: 'เป็นธรรมชาติ', Honest: 'จริงใจ', Cheerful: 'ร่าเริง', Clear: 'ชัดเจน', Conversational: 'เหมือนคุยกัน',
  Approachable: 'เป็นกันเอง', Casual: 'สบายๆ', Sincere: 'จริงใจ', Cute: 'น่ารัก', Reliable: 'น่าเชื่อถือ', Authority: 'หนักแน่น',
  Rational: 'มีเหตุผล', Passion: 'มีพลัง', Considerate: 'ใส่ใจ', Comfort: 'ฟังสบาย', Lively: 'มีชีวิตชีวา',
}

/** กลุ่มของเสียง: thai = เสียงไทย · multi = หลายภาษา (อ่านไทยได้) · english = อังกฤษล้วน (อ่านไทยไม่ได้) */
const groupOf = (v) => (/^th-/.test(v.locale) ? 'thai' : /Multilingual/.test(v.id) ? 'multi' : 'english')
const GROUP_ORDER = { thai: 0, multi: 1, english: 2 }

export const EDGE_VOICES = EDGE_CATALOG.map((v) => {
  const name = v.id.split('-').slice(2).join('-').replace(/(Multilingual)?Neural$/, '')
  const tones = [...new Set(v.personalities.map((p) => TONE[p] ?? p))].slice(0, 2).join(' ')
  const group = groupOf(v)
  return {
    id: v.id,
    group,
    readsThai: group !== 'english',
    label: `${name} — ${v.gender === 'Male' ? 'ชาย' : 'หญิง'} ${ACCENT[v.locale] ?? v.localeName}${tones ? ` · ${tones}` : ''}`,
  }
}).sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || (b.id.startsWith('en-US') - a.id.startsWith('en-US')) || a.label.localeCompare(b.label))

/**
 * เสียง Edge อ่านภาษาของบทได้ไหม — เสียงอังกฤษล้วนได้ข้อความไทยจะไม่มีเสียงกลับมาเลย ("No audio was received")
 * เสียงไทยอ่านอังกฤษได้ · เสียง Multilingual อ่านได้ทุกภาษา
 */
export function edgeVoiceFits(voice, language) {
  if (/Multilingual/i.test(voice) || language !== 'th') return true
  return /^th-/i.test(voice)
}
export const defaultEdgeVoice = (language) => (language === 'th' ? 'th-TH-NiwatNeural' : 'en-US-AndrewMultilingualNeural')

export const GEMINI_MODELS = ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts']

export const GEMINI_VOICES = [
  ['Charon', 'ให้ข้อมูล'], ['Rasalgethi', 'ให้ข้อมูล'], ['Sadaltager', 'รอบรู้'], ['Iapetus', 'ชัดเจน'], ['Erinome', 'ชัดเจน'],
  ['Kore', 'หนักแน่น'], ['Orus', 'หนักแน่น'], ['Alnilam', 'หนักแน่น'], ['Gacrux', 'ผู้ใหญ่'], ['Algenib', 'เสียงแหบ'],
  ['Sulafat', 'อบอุ่น'], ['Achird', 'เป็นมิตร'], ['Vindemiatrix', 'อ่อนโยน'], ['Achernar', 'นุ่ม'], ['Enceladus', 'มีลมหายใจ'],
  ['Algieba', 'นุ่มลื่น'], ['Despina', 'นุ่มลื่น'], ['Schedar', 'เรียบ'], ['Umbriel', 'สบายๆ'], ['Callirrhoe', 'สบายๆ'],
  ['Zubenelgenubi', 'เป็นกันเอง'], ['Aoede', 'โปร่ง'], ['Zephyr', 'สดใส'], ['Autonoe', 'สดใส'], ['Puck', 'ร่าเริง'],
  ['Laomedeia', 'ร่าเริง'], ['Sadachbia', 'มีชีวิตชีวา'], ['Fenrir', 'ตื่นเต้นง่าย'], ['Leda', 'วัยรุ่น'], ['Pulcherrima', 'ตรงไปตรงมา'],
].map(([id, tone]) => ({ id, label: `${id} — ${tone}` }))

/**
 * รุ่นของ ElevenLabs — ภาษาไทยมีเฉพาะ v4 / v3 (Multilingual v2 และ Flash v2.5 รองรับ 29–32 ภาษาที่ไม่มีไทย)
 * ใส่ไว้ใน label ให้เห็นตอนเลือก เพราะเลือกผิดรุ่นแล้วเสียงไทยจะอ่านเพี้ยนทั้งคลิปแต่ไม่มี error
 * อ้างอิงหน้า "What models do you offer" ของ ElevenLabs (ต.ค. 2026 — v4 ออก 28 ก.ย. 2026)
 */
export const ELEVEN_MODELS = [
  { id: 'eleven_v4', label: 'Eleven v4 — รองรับไทย ใหม่ล่าสุด (แนะนำ)', thai: true },
  { id: 'eleven_v3', label: 'Eleven v3 — รองรับไทย (รุ่นก่อน)', thai: true },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 — อังกฤษคุณภาพสูง (ไม่รองรับไทย)', thai: false },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 — เร็ว ใช้เครดิตครึ่งเดียว (ไม่รองรับไทย)', thai: false },
]
export const elevenModelFits = (model, language) => language !== 'th' || ELEVEN_MODELS.find((m) => m.id === model)?.thai !== false

/** Voice ID ของ ElevenLabs เป็นตัวอักษร/ตัวเลข ~20 ตัว — กันพิมพ์ชื่อเสียงมาแทน ID */
export const isElevenVoiceId = (id) => /^[A-Za-z0-9]{15,40}$/.test(String(id ?? ''))

/** อ่าน error ของ ElevenLabs ({detail:{status,message}}) เป็นข้อความที่บอกว่าต้องแก้อะไร */
function elevenError(status, data) {
  const code = data?.detail?.status ?? ''
  const message = data?.detail?.message ?? (typeof data?.detail === 'string' ? data.detail : '') ?? ''
  // ดูรหัสก่อนสถานะ HTTP — ElevenLabs ส่งเครดิตหมด/สิทธิ์ไม่พอมาเป็น 401 เหมือน key ผิด
  if (code === 'quota_exceeded') return 'เครดิต ElevenLabs ไม่พอสำหรับบทนี้ — เติมเครดิต หรือเปลี่ยนไปใช้เสียงอื่น'
  if (code === 'missing_permissions') return 'API key นี้ไม่มีสิทธิ์ Text to Speech — สร้าง key ใหม่ที่เปิดสิทธิ์ Text to Speech และ Voices (อ่าน)'
  if (code === 'invalid_api_key' || status === 401) return 'ElevenLabs API key ไม่ถูกต้อง — ใส่ใหม่ในขั้นที่ 3'
  if (code === 'voice_not_found' || status === 404) return 'ไม่พบ Voice ID นี้ในบัญชี ElevenLabs — คัดลอกจากหน้า Voices (ปุ่ม ID ของเสียง) แล้วใส่ใหม่'
  return `ElevenLabs ปฏิเสธ (${status}${code ? ` ${code}` : ''}): ${message || 'ไม่ทราบสาเหตุ'}`
}

function elevenKey() {
  loadEnv()
  const key = process.env.ELEVENLABS_API_KEY?.trim()
  if (!key) throw new Error('ยังไม่ได้ใส่ ElevenLabs API key — ใส่ในขั้นที่ 3 ของแผงข้าง หรือในไฟล์ .env (ELEVENLABS_API_KEY)')
  return key
}

/** ตรวจว่า key + Voice ID ใช้ได้จริง แล้วคืนชื่อเสียงไว้แสดงในแผงข้าง */
export async function elevenVoiceInfo(voiceId, key = elevenKey()) {
  if (!isElevenVoiceId(voiceId)) throw new Error('Voice ID ไม่ถูกต้อง — เป็นรหัสตัวอักษรอังกฤษ/ตัวเลข ~20 ตัว ไม่ใช่ชื่อเสียง')
  const res = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, { headers: { 'xi-api-key': key } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(elevenError(res.status, data))
  return { id: data.voice_id ?? voiceId, name: data.name ?? voiceId, category: data.category ?? null }
}

// รุ่นที่ ElevenLabs ปฏิเสธ voice_settings ที่ส่งไป — จำไว้ ประโยคถัดไปไม่ต้องลองซ้ำ
const elevenNoSettings = new Set(['eleven_v3'])

async function elevenOne(text, { voice, model, speed, key }) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_24000`
  const body = { text, model_id: model }
  // ส่งความเร็ว 0.7–1.2 ไปด้วย ยกเว้นรุ่นที่ใช้ค่าที่ตั้งไว้กับเสียงบน ElevenLabs (v3: stability รับแค่บางค่า)
  if (!elevenNoSettings.has(model)) body.voice_settings = { speed: Math.min(1.2, Math.max(0.7, Number(speed) || 1)) }
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': key },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const pcm = Buffer.from(await res.arrayBuffer())
      if (pcm.length > 0) return pcm
      if (attempt >= 3) throw new Error('ElevenLabs ไม่ส่งเสียงกลับมา')
      await sleep(2000)
      continue
    }
    const data = await res.json().catch(() => ({}))
    // รุ่นใหม่ (เช่น v4) อาจไม่รับค่าปรับเสียงบางตัว — ตัดทิ้งแล้วลองใหม่ ดีกว่าพังทั้งคลิปเพราะค่าความเร็ว
    if ((res.status === 400 || res.status === 422) && body.voice_settings) {
      elevenNoSettings.add(model)
      delete body.voice_settings
      continue
    }
    // 429 = ยิงพร้อมกันเกินแพ็กเกจ / ระบบยุ่ง · 5xx = ฝั่ง ElevenLabs ล่ม → รอแล้วลองใหม่ ที่เหลือแก้ด้วยการรอไม่ได้
    if ((res.status === 429 || res.status >= 500) && data?.detail?.status !== 'quota_exceeded' && attempt < 6) {
      await sleep(Math.min(30_000, 3000 * attempt))
      continue
    }
    throw new Error(elevenError(res.status, data))
  }
}

const EMOTION_STYLE = {
  calm: 'in a calm, warm storytelling voice',
  excited: 'in an excited, energetic voice',
  serious: 'in a serious, weighty documentary voice',
  soft: 'in a soft, gentle voice',
}

/** ความเร็ว 1.1 → "+10%" ตามรูปแบบของ edge-tts */
const edgeRate = (speed = 1) => {
  const pct = Math.round((Number(speed) - 1) * 100)
  return `${pct >= 0 ? '+' : ''}${pct}%`
}

function geminiPrompt(text, { emotion = 'calm', speed = 1 }) {
  const pace = speed >= 1.08 ? ' at a brisk pace' : speed <= 0.92 ? ' at a slow, unhurried pace' : ''
  return `Read aloud ${EMOTION_STYLE[emotion] ?? EMOTION_STYLE.calm}${pace}, exactly as written:\n${text}`
}

/** PCM 16-bit mono 24kHz ของ Gemini → ไฟล์ wav */
function writeWav(file, pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  writeFileSync(file, Buffer.concat([header, pcm]))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function geminiOne(text, { model, voice, emotion, speed, key }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: geminiPrompt(text, { emotion, speed }) }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
      if (part) return Buffer.from(part.inlineData.data, 'base64')
      // บางครั้งโมเดลตอบเป็นข้อความแทนเสียง — ลองใหม่
      if (attempt >= 4) throw new Error('Gemini ไม่ส่งเสียงกลับมา')
      await sleep(2000)
      continue
    }
    const message = data.error?.message ?? `HTTP ${res.status}`
    if (res.status === 400 || res.status === 403) throw new Error(`Gemini ปฏิเสธ: ${message}`)
    if (res.status === 429 && /per ?day|daily/i.test(message)) {
      throw new Error('โควตาฟรีของ Gemini วันนี้หมดแล้ว — รอพรุ่งนี้ หรือเปลี่ยนไปใช้เสียงอื่น')
    }
    if (attempt >= 8) throw new Error(`Gemini ล้มเหลว: ${message}`)
    // 429 ต่อนาที / 5xx → รอตามที่ Google บอก (RetryInfo) หรือถอยเวลาเพิ่มขึ้นเรื่อยๆ
    const retry = data.error?.details?.find((d) => d.retryDelay)?.retryDelay
    const waitMs = retry ? Number.parseFloat(retry) * 1000 + 500 : Math.min(60_000, 5000 * attempt)
    await sleep(waitMs)
  }
}

/**
 * สังเคราะห์ทุก segment ด้วยเสียงออนไลน์ แล้วได้ไฟล์ .wav 24kHz ตาม seg.out
 * @param {'edge'|'gemini'|'elevenlabs'} engine  elevenlabs: voice = Voice ID ของเสียงในบัญชี
 * @param {(msg: object) => void} onEvent  event รูปแบบเดียวกับ worker python (loading/loaded/segment/done/error)
 */
export async function synthCloud(engine, segments, { voice, model, emotion, speed, sampleRate = 24000 }, onEvent) {
  const started = Date.now()
  const total = segments.length
  onEvent({ event: 'loading', engine })

  if (engine === 'elevenlabs') {
    const key = elevenKey()
    if (!isElevenVoiceId(voice)) throw new Error('ยังไม่ได้ใส่ Voice ID ของ ElevenLabs — ใส่ในขั้นที่ 3 ของแผงข้าง')
    onEvent({ event: 'loaded', seconds: 0 })
    for (const [i, seg] of segments.entries()) {
      const t0 = Date.now()
      mkdirSync(dirname(seg.out), { recursive: true })
      // ขอ pcm_24000 ตรงๆ → ห่อเป็น wav ได้เลย ไม่ต้องผ่าน ffmpeg และได้ 24kHz ตรงกับ engine อื่น
      writeWav(seg.out, await elevenOne(seg.text, { voice, model: model || ELEVEN_MODELS[0].id, speed, key }), 24000)
      onEvent({ event: 'segment', index: i, total, seconds: (Date.now() - t0) / 1000 })
    }
  } else if (engine === 'gemini') {
    loadEnv()
    const key = process.env.GEMINI_API_KEY?.trim()
    if (!key) throw new Error('ยังไม่ได้ใส่ Gemini API key — ใส่ในแผงข้าง หรือในไฟล์ .env (GEMINI_API_KEY)')
    onEvent({ event: 'loaded', seconds: 0 })
    for (const [i, seg] of segments.entries()) {
      const t0 = Date.now()
      mkdirSync(dirname(seg.out), { recursive: true })
      writeWav(seg.out, await geminiOne(seg.text, { model, voice, emotion, speed, key }), sampleRate)
      onEvent({ event: 'segment', index: i, total, seconds: (Date.now() - t0) / 1000 })
    }
  } else if (engine === 'edge') {
    if (!existsSync(edgePython())) throw new Error('ยังไม่ได้ติดตั้ง edge-tts — รัน scripts/setup-tts.ps1')
    // edge-tts ให้ mp3 → worker เขียน mp3 ไว้ข้างๆ แล้วแปลงเป็น wav ให้ขั้นต่อไปใช้เหมือนกันทุก engine
    const jobs = segments.map((s) => ({ index: s.index, text: s.text, out: s.out.replace(/\.wav$/i, '.mp3') }))
    mkdirSync(dirname(segments[0].out), { recursive: true })
    const jobFile = join(dirname(segments[0].out), '.edge_job.json')
    writeFileSync(jobFile, JSON.stringify({ voice, rate: edgeRate(speed), segments: jobs }, null, 2))
    let error = await edgeRun(jobFile, onEvent)
    // 403 ทุกคำขอ = Microsoft เลิกรับ edge-tts รุ่นเก่า (เจอจริง ต.ค. 2026: 7.2.8 โดนปฏิเสธ 7.3.1 ผ่าน) → อัปเดตเองแล้วลองอีกรอบ
    if (error && /\b403\b/.test(error)) {
      onEvent({ event: 'loading', engine: 'edge-tts รุ่นใหม่ (Microsoft ปฏิเสธรุ่นเดิม 403)' })
      if (await edgeUpgrade()) error = await edgeRun(jobFile, onEvent)
      if (error && /\b403\b/.test(error)) {
        throw new Error('Edge TTS ปฏิเสธคำขอ (403) แม้อัปเดต edge-tts เป็นรุ่นล่าสุดแล้ว — Microsoft อาจปิดชั่วคราว ลองใหม่ภายหลังหรือเปลี่ยนไปใช้เสียงอื่น')
      }
    }
    if (error) throw new Error(error)
    for (const s of jobs) {
      const wav = s.out.replace(/\.mp3$/i, '.wav')
      await run('ffmpeg', ['-y', '-v', 'error', '-i', s.out, '-ar', String(sampleRate), '-ac', '1', wav])
      unlinkSync(s.out)
    }
  } else {
    throw new Error(`ไม่รู้จักเสียงออนไลน์: ${engine}`)
  }

  onEvent({ event: 'done', total, seconds: Math.round((Date.now() - started) / 100) / 10 })
}
