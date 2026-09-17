/**
 * เสียงคนอื่น (ออนไลน์) — อีกตัวเลือกนอกจากเสียงของเรา
 *
 *   edge    Microsoft Edge TTS ผ่าน edge-tts — ฟรี ไม่ต้องใช้ key (บริการไม่เป็นทางการ อาจเปลี่ยนได้)
 *   gemini  Gemini TTS — ต้องมี GEMINI_API_KEY (รุ่น flash มีโควตาฟรี แต่จำกัดจำนวนครั้งต่อวัน)
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

/** edge-tts ลงไว้ใน tts/.venv ตัวเดียวกับระบบเสียงหลัก — .venv-edge ใช้กับเครื่องที่ลงแค่ edge-tts */
export function edgePython() {
  const main = join(ROOT, 'tts', '.venv')
  if (existsSync(join(main, 'Lib', 'site-packages', 'edge_tts'))) return join(main, 'Scripts', 'python.exe')
  return join(ROOT, 'tts', '.venv-edge', 'Scripts', 'python.exe')
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
 * @param {'edge'|'gemini'} engine
 * @param {(msg: object) => void} onEvent  event รูปแบบเดียวกับ worker python (loading/loaded/segment/done/error)
 */
export async function synthCloud(engine, segments, { voice, model, emotion, speed, sampleRate = 24000 }, onEvent) {
  const started = Date.now()
  const total = segments.length
  onEvent({ event: 'loading', engine })

  if (engine === 'gemini') {
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
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    delete env.PYTHONHOME
    delete env.PYTHONPATH
    let error = null
    const code = await new Promise((resolve) => {
      const proc = spawn(edgePython(), [join(ROOT, 'tts/cloud/edge_synth.py'), jobFile], { cwd: ROOT, env, windowsHide: true })
      createInterface({ input: proc.stdout }).on('line', (line) => {
        try {
          const msg = JSON.parse(line)
          if (msg.event === 'error') error = msg.message
          else if (msg.event !== 'loading' && msg.event !== 'done') onEvent(msg)
        } catch {}
      })
      let stderr = ''
      proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)))
      proc.on('close', (c) => {
        if (c !== 0 && !error) error = stderr.trim() || `edge-tts จบด้วย exit ${c}`
        resolve(c)
      })
    })
    if (code !== 0) throw new Error(error)
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
