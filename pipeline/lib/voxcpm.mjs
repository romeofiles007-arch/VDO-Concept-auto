/**
 * VoxCPM2 — โคลนเสียงของเราจากคลิปต้นแบบ (ไม่ต้องเทรน) · อ่านไทยแม่นกว่า F5-TTS-THAI (ทดสอบใน tts/eval)
 *
 * เสียงอ้างอิงต่ออารมณ์: tts/voices/<id>/voxcpm/<emotion>.wav + .txt
 *   ไม่มี → ต่อคลิปต้นแบบใน selections.json ของอารมณ์นั้นให้ยาว ~9–15 วิ แล้วเก็บไว้ใช้ครั้งต่อไป
 *   แก้เองได้: แทนไฟล์ .wav ด้วยคลิปที่พูดชัด 10 วิ แล้วใส่ข้อความที่พูดจริงใน .txt ให้ตรงทุกคำ
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { ROOT } from './config.mjs'
import { run, trimSilence } from './ffmpeg.mjs'
import { voiceDir, readVoice, writeVoice, VOICES_DIR, AUDIO_EXT } from './voices.mjs'
import { ttsPython } from './config.mjs'

export const VOXCPM_PYTHON = join(ROOT, 'tts', '.venv-voxcpm', 'Scripts', 'python.exe')
export const voxcpmInstalled = () => existsSync(VOXCPM_PYTHON)

const selectionsFile = (id) => {
  const v = readVoice(id)
  const p = v?.references ? join(voiceDir(id), v.references) : join(voiceDir(id), 'selections.json')
  return existsSync(p) ? p : null
}

/** เสียงที่ใช้กับ VoxCPM2 ได้ = มีคลิปต้นแบบ (ไม่ต้องมีโมเดลที่เทรนแล้ว) */
export function voxcpmVoices() {
  if (!existsSync(VOICES_DIR)) return []
  return readdirSync(VOICES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(VOICES_DIR, d.name, 'voice.json')))
    .map((d) => {
      const calm = join(voiceDir(d.name), 'voxcpm', 'calm.txt')
      return {
        id: d.name,
        label: readVoice(d.name)?.label ?? d.name,
        ready: !!selectionsFile(d.name) || existsSync(join(voiceDir(d.name), 'voxcpm', 'calm.wav')),
        // ข้อความที่พูดในคลิปอ้างอิง — ให้ผู้ใช้ตรวจ/แก้ให้ตรงทุกคำ (ไม่ตรง = เสียงที่ได้เพี้ยน)
        refText: existsSync(calm) ? readFileSync(calm, 'utf8').trim() : null,
        refSource: readVoice(d.name)?.voxcpmSource ?? null, // ไฟล์ที่ใช้ทำเสียงอ้างอิง
      }
    })
    .filter((v) => v.ready)
}

/** เสียงอ้างอิงของอารมณ์ที่เลือก — สร้างจากคลิปต้นแบบถ้ายังไม่มี */
export async function voxcpmReference(id, emotion = 'calm') {
  const dir = join(voiceDir(id), 'voxcpm')
  const wav = join(dir, `${emotion}.wav`)
  const txt = join(dir, `${emotion}.txt`)
  if (existsSync(wav) && existsSync(txt)) return { wav, text: readFileSync(txt, 'utf8').trim() }
  const sel = selectionsFile(id)
  const all = sel ? JSON.parse(readFileSync(sel, 'utf8')) : {}
  // อารมณ์นี้ไม่มีคลิปต้นแบบ → ใช้เสียงอ้างอิงแบบ calm
  if (!all[emotion]?.length) {
    if (emotion !== 'calm') return voxcpmReference(id, 'calm')
    throw new Error(`เสียง "${id}" ไม่มีคลิปต้นแบบสำหรับ VoxCPM2`)
  }
  const clips = all[emotion]
  const picked = []
  let seconds = 0
  // คลิปที่ถอดความครบประโยค (ไม่มีคำทับศัพท์เพี้ยนๆ) มักอยู่อันดับต้นๆ — เอาจนได้ ~10 วิ
  for (const c of clips) {
    if (seconds >= 9) break
    picked.push(c)
    seconds += c.duration ?? 3.5
  }
  if (!picked.length) throw new Error(`เสียง "${id}" ไม่มีคลิปของอารมณ์ ${emotion}`)
  mkdirSync(dir, { recursive: true })
  const inputs = picked.flatMap((c) => ['-i', join(dirname(sel), c.file)])
  const filters = picked.map((_, i) => `[${i}]aresample=24000,aformat=channel_layouts=mono${i < picked.length - 1 ? ',apad=pad_dur=0.3' : ''}[a${i}]`)
  await run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', `${filters.join(';')};${picked.map((_, i) => `[a${i}]`).join('')}concat=n=${picked.length}:v=0:a=1`, '-ac', '1', wav])
  const text = picked.map((c) => String(c.text ?? '').trim()).join(' ')
  writeFileSync(txt, text + '\n', 'utf8')
  return { wav, text }
}

/**
 * สังเคราะห์ทุก segment ด้วย VoxCPM2 → ไฟล์ .wav ตาม seg.out
 * @param {(msg: object) => void} onEvent  event แบบเดียวกับ worker อื่น (loading/loaded/segment/done/error)
 */
/**
 * โทนเสียงหลังสร้าง — เสียงอ้างอิงจากไมค์ทั่วไปมักทุ้ม (พลังงานกองต่ำกว่า 400Hz, ช่วง 1–3kHz เบา) โมเดลเลียนแบบโทนนั้นมาตรงๆ
 * ลดเสียงต่ำ + เพิ่มเสียงกลาง ให้ฟังชัดขึ้นบนมือถือ · ไม่เปลี่ยนความสูงของเสียง (pitch)
 */
export const VOICE_EQ = {
  off: { label: 'ไม่ปรับ', filter: null },
  clear: { label: 'เสียงกลางชัดขึ้น', filter: 'highpass=f=70,lowshelf=f=180:g=-3,equalizer=f=1000:t=o:w=1:g=1.5,equalizer=f=2500:t=o:w=1.2:g=4,highshelf=f=6000:g=1.5' },
  bright: { label: 'สว่างชัดมาก', filter: 'highpass=f=90,lowshelf=f=200:g=-5,equalizer=f=1200:t=o:w=1:g=2.5,equalizer=f=2800:t=o:w=1.2:g=6,highshelf=f=6000:g=3' },
}

export async function synthVoxcpm(segments, { voice, emotion = 'calm', speed = 1, cfg = 2.0, steps = 10, eq = 'clear' }, onEvent = () => {}) {
  if (!voxcpmInstalled()) throw new Error('ยังไม่ได้ติดตั้ง VoxCPM2 — รัน scripts/setup-voxcpm.ps1')
  const ref = await voxcpmReference(voice, emotion)
  mkdirSync(dirname(segments[0].out), { recursive: true })
  // "..." ในบท = ช่วงหยุด แต่ VoxCPM2 อ่านเป็นเสียงแปลก (ทดสอบแล้ว: "ห้อง... แล้ว" → "ห่องถือก", "ชัด... แต่" → "ชัด เนี่ย")
  // → แยกท่อนตรง "..." อ่านทีละท่อน แล้วต่อกันด้วยความเงียบจริง
  const PAUSE_SEC = 0.28
  const pieces = []
  for (const s of segments) {
    const parts = String(s.text).split(/\s*(?:\.{2,}|…)\s*/).map((p) => p.trim()).filter(Boolean)
    s.pieces = parts.length > 1 ? parts.map((text, k) => ({ text, out: s.out.replace(/\.wav$/i, `.p${k}.wav`) })) : [{ text: parts[0] ?? s.text, out: s.out }]
    for (const p of s.pieces) pieces.push({ index: pieces.length, text: p.text, out: p.out })
  }
  const jobFile = join(dirname(segments[0].out), '.voxcpm_job.json')
  writeFileSync(jobFile, JSON.stringify({ model: 'openbmb/VoxCPM2', ref_wav: ref.wav, ref_text: ref.text, cfg_value: cfg, inference_timesteps: steps, segments: pieces }, null, 2))
  // progress ต่อประโยคของบท ไม่ใช่ต่อท่อนย่อย
  const pieceToSeg = pieces.map((p) => segments.findIndex((s) => s.pieces.some((x) => x.out === p.out)))
  const userOnEvent = onEvent
  onEvent = (msg) => {
    if (msg.event === 'done') return userOnEvent({ ...msg, total: segments.length })
    if (msg.event !== 'segment') return userOnEvent(msg)
    const seg = pieceToSeg[msg.index]
    const last = segments[seg].pieces.at(-1).out === pieces[msg.index].out
    if (last) userOnEvent({ ...msg, index: seg, total: segments.length })
  }
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', KMP_DUPLICATE_LIB_OK: 'TRUE' }
  delete env.PYTHONHOME
  delete env.PYTHONPATH
  let error = null
  let stderrTail = ''
  const code = await new Promise((resolve) => {
    const proc = spawn(VOXCPM_PYTHON, [join(ROOT, 'tts', 'voxcpm', 'synth_voxcpm.py'), jobFile], { cwd: ROOT, env, windowsHide: true })
    createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (msg.event === 'error') error = msg.message
        onEvent(msg)
      } catch {}
    })
    proc.stderr.on('data', (d) => (stderrTail = (stderrTail + d).slice(-3000)))
    proc.on('close', resolve)
    proc.on('error', (err) => {
      error = err.message
      resolve(1)
    })
  })
  if (code !== 0) throw new Error(error ?? (stderrTail.trim().split(/\r?\n/).slice(-3).join(' ') || `VoxCPM2 จบด้วย exit ${code}`))
  // ต่อท่อนย่อยกลับเป็นประโยคเดียว คั่นด้วยช่วงหยุดตรงที่บทเขียน "..."
  for (const s of segments) {
    if (s.pieces.length < 2) continue
    // ตัดความเงียบหัวท้ายของแต่ละท่อนก่อน ช่วงหยุดจะยาวเท่าที่ตั้งไว้จริง
    for (const p of s.pieces) await trimSilence(p.out)
    const inputs = s.pieces.flatMap((p) => ['-i', p.out])
    const filters = s.pieces.map((_, k) => `[${k}]aformat=channel_layouts=mono${k < s.pieces.length - 1 ? `,apad=pad_dur=${PAUSE_SEC}` : ''}[a${k}]`)
    await run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', `${filters.join(';')};${s.pieces.map((_, k) => `[a${k}]`).join('')}concat=n=${s.pieces.length}:v=0:a=1`, s.out])
    for (const p of s.pieces) unlinkSync(p.out)
  }
  // ปรับโทน (EQ) + ความเร็ว — VoxCPM2 ไม่มีตัวปรับความเร็ว → ยืด/หดเสียงทีหลัง (atempo ไม่เปลี่ยนความสูงเสียง)
  const filters = [
    VOICE_EQ[eq]?.filter,
    Math.abs(Number(speed) - 1) > 0.01 ? `atempo=${Math.min(2, Math.max(0.5, Number(speed)))}` : null,
  ].filter(Boolean)
  if (filters.length) {
    for (const s of segments) {
      const tmp = s.out.replace(/\.wav$/i, '.post.wav')
      // alimiter กันเสียงแตกหลังเพิ่มย่านเสียงกลาง
      await run('ffmpeg', ['-y', '-v', 'error', '-i', s.out, '-filter:a', [...filters, 'alimiter=limit=0.95'].join(','), tmp])
      unlinkSync(s.out)
      renameSync(tmp, s.out)
    }
  }
}

/**
 * เสียงใหม่แบบไม่ต้องเทรน: เอาไฟล์ที่อัปโหลดมา (ใช้แค่ 10–15 วิแรกที่มีเสียงพูด) เป็นเสียงอ้างอิงของ VoxCPM2
 * แล้วถอดข้อความที่พูดด้วย Whisper ในเครื่อง — ผู้ใช้แก้ข้อความให้ตรงได้ทีหลัง
 */
export async function voxcpmVoiceFromRaw(id) {
  const rawDir = join(voiceDir(id), 'raw')
  // ใช้ไฟล์ที่อัปโหลดล่าสุด — ผู้ใช้เปลี่ยนไฟล์แล้วกดใหม่ ต้องได้เสียงจากไฟล์ใหม่
  const raws = existsSync(rawDir)
    ? readdirSync(rawDir)
        .filter((f) => AUDIO_EXT.includes(f.split('.').pop().toLowerCase()))
        .sort((a, b) => statSync(join(rawDir, b)).mtimeMs - statSync(join(rawDir, a)).mtimeMs)
    : []
  if (!raws.length) throw new Error('ยังไม่มีไฟล์เสียง — เลือกไฟล์เสียงก่อน (พูดชัด 10–15 วินาทีพอ)')
  const dir = join(voiceDir(id), 'voxcpm')
  mkdirSync(dir, { recursive: true })
  const wav = join(dir, 'calm.wav')
  // ตัดความเงียบหัวไฟล์ แล้วเอาไม่เกิน 15 วิ (ยาวกว่านี้ไม่ช่วยให้เหมือนขึ้น แต่ช้าลง)
  await run('ffmpeg', ['-y', '-v', 'error', '-i', join(rawDir, raws[0]), '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse', '-t', '15', '-ar', '24000', '-ac', '1', wav])

  const out = join(dir, '.transcript.json')
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', KMP_DUPLICATE_LIB_OK: 'TRUE' }
  delete env.PYTHONHOME
  delete env.PYTHONPATH
  let error = ''
  const code = await new Promise((resolve) => {
    const proc = spawn(ttsPython(), [join(ROOT, 'tts', 'asr', 'transcribe.py'), wav, out, '--language', 'th'], { cwd: ROOT, env, windowsHide: true })
    proc.stderr.on('data', (d) => (error = (error + d).slice(-1500)))
    proc.on('close', resolve)
    proc.on('error', (err) => {
      error = err.message
      resolve(1)
    })
  })
  if (code !== 0 || !existsSync(out)) throw new Error(`ถอดข้อความจากเสียงไม่สำเร็จ: ${error.trim().split(/\r?\n/).pop() ?? code}`)
  const text = JSON.parse(readFileSync(out, 'utf8')).segments.map((x) => x.text.trim()).join(' ').trim()
  unlinkSync(out)
  if (!text) throw new Error('ไม่ได้ยินเสียงพูดในไฟล์ — ใช้ไฟล์ที่พูดชัด ไม่มีเพลงประกอบ')
  writeFileSync(join(dir, 'calm.txt'), text + '\n', 'utf8')
  // เสียงนี้ใช้กับ VoxCPM2 ได้แล้ว — ล้างสถานะ "เทรนไม่สำเร็จ" ของการเทรนแบบเดิม
  writeVoice(id, { voxcpm: true, voxcpmSource: raws[0], error: null, status: readVoice(id)?.status === 'failed' ? 'draft' : readVoice(id)?.status })
  return { text, source: raws[0] }
}

/** แก้ข้อความของเสียงอ้างอิง ให้ตรงกับที่พูดในคลิปทุกคำ */
export function setVoxcpmRefText(id, text, emotion = 'calm') {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('ข้อความว่าง')
  const dir = join(voiceDir(id), 'voxcpm')
  if (!existsSync(join(dir, `${emotion}.wav`))) throw new Error('เสียงนี้ยังไม่มีคลิปอ้างอิงของ VoxCPM2')
  writeFileSync(join(dir, `${emotion}.txt`), clean + '\n', 'utf8')
  return { text: clean }
}
