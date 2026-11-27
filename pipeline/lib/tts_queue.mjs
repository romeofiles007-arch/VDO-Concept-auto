/**
 * คิวพากย์ข้ามเครื่อง — เครื่องที่ผลิตคลิป (24hrs, การ์ด 1080 Ti รัน VoxCPM2 ไม่ได้ การ์ดหลุดทุกครั้ง)
 * ฝากงานไว้ในโฟลเดอร์คิว แล้วเครื่องที่มีการ์ดจอแรง (4070) มาดึงไปพากย์ผ่าน SSH (scripts/tts-worker.mjs)
 *
 * เครื่องการ์ดจอแรงปิดอยู่ → งานรออยู่ในคิว · เปิดเครื่องแล้ว worker เริ่มเอง ดึงงาน พากย์ ส่งไฟล์กลับ
 * เครื่องผลิตไม่ต้องเปิด port ให้ใคร — worker เป็นฝ่ายเชื่อมเข้ามาทาง SSH ที่ใช้อยู่แล้ว
 *
 * projects/_tts_queue/
 *   worker.json               เครื่องพากย์มาเช็กคิวล่าสุดเมื่อไร (ทุก ~20 วิ ตอนเปิดเครื่อง)
 *   <id>/job.json             ข้อความทุกประโยค + ค่าเสียง + ข้อความของคลิปอ้างอิง
 *   <id>/ref.wav              คลิปอ้างอิงของเสียง (เครื่องพากย์ไม่ต้องมีเสียงนี้ในเครื่อง)
 *   <id>/client.json          เครื่องผลิตยังรออยู่ไหม (หยุดคลิปแล้ว = ไม่ต้องพากย์ ลบทิ้ง)
 *   <id>/claim.json           เครื่องพากย์รับงานแล้ว · progress.json ทำไปกี่ประโยค
 *   <id>/out/0000.wav …       เสียงที่ได้ · done.json เขียนหลังไฟล์ครบ (อ่านได้เมื่อเห็น done.json เท่านั้น)
 *   <id>/error.json           พากย์ไม่สำเร็จ
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, copyFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ROOT } from './config.mjs'

export const QUEUE_DIR = join(ROOT, 'projects', '_tts_queue')

// เครื่องพากย์เช็กคิวทุก ~20 วิ — ไม่เห็นเกิน 90 วิ = ปิดอยู่ / เน็ตหลุด
export const WORKER_ONLINE_MS = 90_000
// เครื่องผลิตแตะ client.json ทุก ~20 วิ ระหว่างรอ — เงียบเกิน 10 นาที = คลิปถูกหยุดไปแล้ว งานนี้ทิ้งได้
export const CLIENT_STALE_MS = 10 * 60_000
// รับงานไปแล้วเงียบเกิน 10 นาที (เครื่องพากย์ดับกลางงาน) → ให้เครื่องไหนก็รับใหม่ได้
export const CLAIM_STALE_MS = 10 * 60_000

const now = () => Date.now()
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
// เขียนไฟล์ชั่วคราวแล้วเปลี่ยนชื่อ — อีกฝั่งไม่มีวันอ่านเจอไฟล์ครึ่งๆ
function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file)
}
const jobDir = (id, root = QUEUE_DIR) => {
  if (!/^[\w-]+$/.test(String(id))) throw new Error(`รหัสงานไม่ถูกต้อง: ${id}`)
  return join(root, id)
}

/** เครื่องผลิต: ฝากงานพากย์ → รหัสงาน */
export function enqueueJob({ refWav, refText, settings = {}, segments, label = '' }, root = QUEUE_DIR) {
  const id = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`
  const dir = jobDir(id, root)
  mkdirSync(dir, { recursive: true })
  copyFileSync(refWav, join(dir, 'ref.wav'))
  writeJson(join(dir, 'client.json'), { seen: now() })
  // job.json เขียนท้ายสุด — worker เห็นงานเมื่อไฟล์ประกอบครบแล้วเท่านั้น
  writeJson(join(dir, 'job.json'), { id, label, createdAt: now(), refText, settings, segments: segments.map((s) => ({ index: s.index, text: s.text })) })
  return id
}

export const touchClient = (id, root = QUEUE_DIR) => existsSync(jobDir(id, root)) && writeJson(join(jobDir(id, root), 'client.json'), { seen: now() })

export function removeJob(id, root = QUEUE_DIR) {
  rmSync(jobDir(id, root), { recursive: true, force: true })
}

/** เครื่องพากย์ออนไลน์อยู่ไหม (ดูจากครั้งล่าสุดที่มาเช็กคิว) */
export function workerStatus(root = QUEUE_DIR) {
  const w = readJson(join(root, 'worker.json'))
  if (!w?.seen) return { online: false, name: null, seen: null }
  return { online: now() - w.seen < WORKER_ONLINE_MS, name: w.name ?? null, seen: w.seen, gpu: w.gpu ?? null, busy: w.busy ?? null }
}

/** สถานะงาน: waiting (ในคิว) · working (กำลังพากย์ n/m) · done · failed · missing */
export function jobState(id, root = QUEUE_DIR) {
  const dir = jobDir(id, root)
  if (!existsSync(join(dir, 'job.json'))) return { state: 'missing' }
  const error = readJson(join(dir, 'error.json'))
  if (error) return { state: 'failed', message: error.message ?? 'พากย์ไม่สำเร็จ', worker: error.worker }
  if (existsSync(join(dir, 'done.json'))) return { state: 'done', ...readJson(join(dir, 'done.json')), outDir: join(dir, 'out') }
  const claim = readJson(join(dir, 'claim.json'))
  if (claim) return { state: 'working', worker: claim.worker, ...(readJson(join(dir, 'progress.json')) ?? {}) }
  return { state: 'waiting' }
}

const listJobs = (root) =>
  existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'job.json')))
        .map((d) => d.name)
        .sort()
    : []

/**
 * เครื่องพากย์: แจ้งว่ายังออนไลน์ + รับงานถัดไป (เก่าสุดก่อน) → { id, job, refWav } หรือ null
 * งานที่เครื่องผลิตเลิกรอแล้ว (คลิปถูกหยุด) ลบทิ้ง · งานที่เครื่องนี้รับไว้แต่ยังไม่เสร็จ (ดับกลางงาน) รับต่อ
 */
export function heartbeat(worker, { gpu = null, busy = null } = {}, root = QUEUE_DIR) {
  mkdirSync(root, { recursive: true })
  // heartbeat ระหว่างพากย์ไม่ได้ส่งชื่อการ์ดมา — ใช้ชื่อเดิมของเครื่องนี้
  const before = readJson(join(root, 'worker.json'))
  writeJson(join(root, 'worker.json'), { name: worker, gpu: gpu ?? (before?.name === worker ? before.gpu : null), busy, seen: now() })
}

export function claimNext(worker, { gpu = null } = {}, root = QUEUE_DIR) {
  heartbeat(worker, { gpu }, root)
  for (const id of listJobs(root)) {
    const dir = jobDir(id, root)
    const state = jobState(id, root)
    if (state.state === 'done' || state.state === 'failed') {
      // เครื่องผลิตเอาไฟล์ไปแล้วจะลบเอง · ค้างนานแปลว่าเครื่องผลิตเลิกรอ → เก็บกวาด
      if (now() - (readJson(join(dir, 'client.json'))?.seen ?? 0) > CLIENT_STALE_MS) removeJob(id, root)
      continue
    }
    if (now() - (readJson(join(dir, 'client.json'))?.seen ?? 0) > CLIENT_STALE_MS) {
      removeJob(id, root)
      continue
    }
    const claim = readJson(join(dir, 'claim.json'))
    const claimSeen = Math.max(claim?.at ?? 0, readJson(join(dir, 'progress.json'))?.at ?? 0)
    if (claim && claim.worker !== worker && now() - claimSeen < CLAIM_STALE_MS) continue
    writeJson(join(dir, 'claim.json'), { worker, at: now() })
    rmSync(join(dir, 'progress.json'), { force: true })
    return { id, job: readJson(join(dir, 'job.json')), refWav: join(dir, 'ref.wav') }
  }
  return null
}

export function writeProgress(id, done, total, root = QUEUE_DIR) {
  const dir = jobDir(id, root)
  if (existsSync(dir)) writeJson(join(dir, 'progress.json'), { done, total, at: now() })
}

/** เครื่องพากย์ส่งเสียงกลับ: files = { '0000.wav': Buffer } */
export function finishJob(id, files, info = {}, root = QUEUE_DIR) {
  const dir = jobDir(id, root)
  if (!existsSync(join(dir, 'job.json'))) throw new Error(`ไม่มีงาน ${id} แล้ว (เครื่องผลิตเลิกรอ)`)
  const out = join(dir, 'out')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  for (const [name, data] of Object.entries(files)) {
    if (!/^[\w.-]+\.wav$/i.test(name)) throw new Error(`ชื่อไฟล์ไม่ถูกต้อง: ${name}`)
    writeFileSync(join(out, name), data)
  }
  writeJson(join(dir, 'done.json'), { ...info, files: Object.keys(files).length, at: now() })
}

export function failJob(id, message, worker = null, root = QUEUE_DIR) {
  const dir = jobDir(id, root)
  if (existsSync(dir)) writeJson(join(dir, 'error.json'), { message: String(message).slice(0, 2000), worker, at: now() })
}

const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)} วิที่แล้ว` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} นาทีที่แล้ว` : `${Math.round(ms / 3_600_000)} ชม.ที่แล้ว`)

/** ข้อความสถานะสำหรับคนดู — ใช้ทั้ง log ของขั้นเสียงและแผงข้าง */
export function describeWait(state, worker) {
  // ชื่อเครื่องที่รับงานนี้จริง (worker.json = เครื่องที่มาเช็กคิวล่าสุด อาจเป็นอีกเครื่อง)
  const who = (state.state === 'working' && state.worker) || worker.name || 'เครื่องพากย์'
  if (state.state === 'working') return state.done ? `${who} กำลังพากย์ ${state.done}/${state.total}` : `${who} รับงานแล้ว กำลังโหลดโมเดล${state.total ? ` (${state.total} ประโยค)` : ''}`
  if (worker.online && worker.busy) return `อยู่ในคิว — ${who} กำลังพากย์งานอื่นอยู่ เสร็จแล้วจะรับงานนี้ต่อ`
  if (worker.online) return `อยู่ในคิว — ${who} จะรับงานภายในไม่กี่วินาที`
  return worker.seen
    ? `รอเครื่องพากย์ (${who}) เปิด — ออนไลน์ล่าสุด ${ago(now() - worker.seen)} · เปิดเครื่องแล้วจะพากย์ต่อให้เอง`
    : 'รอเครื่องพากย์เปิด — ยังไม่เคยมีเครื่องพากย์มาเชื่อม (ตั้งค่า scripts/tts-worker.mjs บนเครื่องการ์ดจอแรง)'
}

/**
 * เครื่องผลิต: รอจนงานเสร็จ แล้วคัดลอกเสียงไปตาม segments[].out
 * onStatus(text, state) เรียกเมื่อสถานะเปลี่ยน · timeoutMs = 0 รอไม่จำกัด (เครื่องพากย์อาจปิดทั้งคืน)
 */
/**
 * พากย์ที่เครื่องพากย์เท่านั้น — ทำไม่ได้ (เครื่องพากย์ปิด / พากย์พัง / ส่งเสียงกลับไม่ครบ / งานหายจากคิว) ก็ฝากงานใหม่แล้วรอต่อ
 * ห้ามพากย์เองบนเครื่องผลิต หรือสลับไปใช้เสียงอื่นแทน (ผู้ใช้ 27 พ.ย. 2026) — เลิกรอได้ทางเดียวคือผู้ใช้กดหยุดคลิป
 */
export async function narrateRemote(job, segments, { onStatus = () => {}, onQueued = () => {}, retryMs = 60_000, pollMs, root = QUEUE_DIR } = {}) {
  for (let attempt = 1; ; attempt++) {
    const id = enqueueJob({ ...job, segments }, root)
    onQueued(id, attempt)
    try {
      return { ...(await waitForJob(id, segments, { onStatus, pollMs, root })), id, attempts: attempt }
    } catch (err) {
      removeJob(id, root)
      onStatus(`เครื่องพากย์ทำไม่สำเร็จ (${err.message}) — ฝากงานใหม่ใน ${Math.round(retryMs / 1000)} วิ แล้วรอเครื่องพากย์ต่อ (รอบที่ ${attempt + 1})`, { state: 'retry', attempt })
      await new Promise((r) => setTimeout(r, retryMs))
    }
  }
}

export async function waitForJob(id, segments, { onStatus = () => {}, timeoutMs = 0, pollMs = 3000, root = QUEUE_DIR } = {}) {
  const started = now()
  let lastText = ''
  let lastTouch = 0
  for (;;) {
    if (now() - lastTouch > 20_000) {
      touchClient(id, root)
      lastTouch = now()
    }
    const state = jobState(id, root)
    if (state.state === 'missing') throw new Error('งานพากย์หายจากคิว (มีคนลบโฟลเดอร์ projects/_tts_queue)')
    if (state.state === 'failed') {
      removeJob(id, root)
      throw new Error(`เครื่องพากย์${state.worker ? ` ${state.worker}` : ''}: ${state.message}`)
    }
    if (state.state === 'done') {
      for (const s of segments) {
        const name = `${String(s.index).padStart(4, '0')}.wav`
        const file = join(state.outDir, name)
        if (!existsSync(file) || statSync(file).size < 100) throw new Error(`เครื่องพากย์ส่งเสียงประโยค ${s.index + 1} มาไม่ครบ`)
        copyFileSync(file, s.out)
      }
      removeJob(id, root)
      return state
    }
    const text = describeWait(state, workerStatus(root))
    if (text !== lastText) onStatus(text, state)
    lastText = text
    if (timeoutMs && now() - started > timeoutMs) {
      removeJob(id, root)
      throw new Error(workerStatus(root).online ? 'เครื่องพากย์ทำไม่ทันเวลา' : 'เครื่องพากย์ปิดอยู่')
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}
