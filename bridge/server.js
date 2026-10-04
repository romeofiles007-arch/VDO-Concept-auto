#!/usr/bin/env node
/**
 * Bridge — สะพานระหว่าง pipeline (Node) กับ Chrome extension
 *
 * ใช้ HTTP long-poll ไม่ใช่ WebSocket เพราะไม่ต้องพึ่ง dependency ใดๆ
 * และงานนี้เป็นคิวงานหนักไม่กี่ชิ้น ไม่ต้องการ latency ระดับ ms
 *
 * ทำไมต้องมีตัวนี้: extension เขียนไฟล์ลงโฟลเดอร์โปรเจกต์เองไม่ได้
 * (chrome.downloads ลงได้แค่ Downloads) — bridge จึงเป็นคนเขียนไฟล์ให้
 *
 *   node bridge/server.js
 */
import { createServer } from 'node:http'
import { randomUUID, randomBytes } from 'node:crypto'
import { writeFileSync, mkdirSync, appendFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { ROOT } from '../pipeline/lib/config.mjs'
import { loadEnv } from '../pipeline/lib/env.mjs'
import { createUi } from './ui.js'
import { watchBridgeCode, extensionVersion } from './selfupdate.js'

loadEnv()

const PORT = Number(process.env.BRIDGE_PORT || 8765)
const TOKEN = process.env.BRIDGE_TOKEN || randomBytes(16).toString('hex')
if (!process.env.BRIDGE_TOKEN) {
  console.warn(`BRIDGE_TOKEN ยังไม่ได้ตั้งใน .env — ใช้ค่าชั่วคราวรอบนี้:\n  BRIDGE_TOKEN=${TOKEN}\nใส่ลง .env แล้วกรอกใน popup ของ extension ให้ตรงกัน`)
}

/** @type {Map<string, {id, agent, kind, payload, status, result, error, progress, createdAt, touchedAt, attempts}>} */
const jobs = new Map()

// ── คิวงานเก็บลงดิสก์ — ปิดเปิด bridge ระหว่างที่ ChatGPT/Flow ยังทำงานอยู่ ผลลัพธ์ต้องไม่หาย ──
// bridge ทดสอบ (port อื่น) ใช้ไฟล์คิวแยก ไม่ปนกับตัวจริง
const JOBS_FILE = join(ROOT, 'bridge', PORT === 8765 ? 'jobs.json' : `jobs-${PORT}.json`)
const KEEP_MS = 24 * 60 * 60_000
let saveTimer = null
function saveJobs() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const keep = [...jobs.values()].filter((j) => Date.now() - j.createdAt < KEEP_MS)
    try {
      writeFileSync(JOBS_FILE + '.tmp', JSON.stringify(keep))
      renameSync(JOBS_FILE + '.tmp', JOBS_FILE)
    } catch {}
  }, 300)
}
try {
  if (existsSync(JOBS_FILE)) for (const j of JSON.parse(readFileSync(JOBS_FILE, 'utf8'))) jobs.set(j.id, { ...j, touchedAt: Date.now() })
} catch {}

/**
 * งานที่ส่งให้ extension แล้วเงียบหาย (แท็บถูกปิด, service worker ตาย, Chrome ปิด)
 * content script ส่ง heartbeat ทุก 20 วิระหว่างทำงาน → เงียบเกินนี้ถือว่าหลุด ส่งงานให้ใหม่
 */
const STALE_MS = { chatgpt: 3 * 60_000, flow: 6 * 60_000, meta: 4 * 60_000 }
const MAX_ATTEMPTS = 3

/**
 * งานกำพร้า: pipeline ที่สั่งงานถามสถานะทุก 1.5 วิ — เงียบเกิน 90 วิ = โปรแกรมนั้นถูกปิด/กดเริ่มใหม่ไปแล้ว
 * ปล่อยไว้จะถูกส่งซ้ำให้ extension ทำงานที่ไม่มีใครรอ แย่งแท็บ Flow กับงานใหม่ (ภาพไม่ถูกเก็บ ค้าง "0/21")
 */
const ORPHAN_MS = 90_000
const isOrphan = (job) => job.watchedAt != null && Date.now() - job.watchedAt > ORPHAN_MS
function dropOrphan(job) {
  job.status = 'error'
  job.error = 'โปรแกรมที่สั่งงานนี้ถูกปิดไปแล้ว — ยกเลิก'
  job.cancelled = true
  job.touchedAt = Date.now()
  log(`ยกเลิกงานกำพร้า ${job.kind} (${job.id.slice(0, 8)})`)
  saveJobs()
}

setInterval(() => {
  for (const job of jobs.values()) {
    if ((job.status === 'running' || job.status === 'queued') && isOrphan(job)) {
      dropOrphan(job)
      continue
    }
    if (job.status !== 'running') continue
    if (Date.now() - (job.touchedAt ?? job.createdAt) < (STALE_MS[job.agent] ?? 5 * 60_000)) continue
    job.attempts = (job.attempts ?? 1) + 1
    if (job.attempts > MAX_ATTEMPTS) {
      job.status = 'error'
      job.error = `${job.agent} เงียบหายระหว่างทำงาน ${MAX_ATTEMPTS} ครั้ง — แท็บถูกปิดหรือหน้าเว็บค้าง`
      log(`ล้มเหลว ${job.kind} (${job.id.slice(0, 8)}): ${job.error}`)
    } else {
      job.status = 'queued'
      job.touchedAt = Date.now()
      log(`งาน ${job.kind} (${job.id.slice(0, 8)}) เงียบเกินเวลา → ส่งใหม่ครั้งที่ ${job.attempts}`)
      dispatch(job)
    }
    saveJobs()
  }
}, 20_000).unref()
const waiting = [] // ผู้รอ job ฝั่ง extension: {agent, respond, timer}
const lastPoll = {} // agent → เวลาที่ extension มาถามหางานล่าสุด ใช้บอกหน้า UI ว่าต่ออยู่ไหม

const LOG = join(ROOT, 'bridge', 'bridge.log')
// เหตุการณ์ล่าสุดของ bridge (ส่งงานให้ ChatGPT/Flow, ยกเลิก, ส่งใหม่) — ให้หน้าต่าง log ในแผงข้างเห็นว่างานติดอยู่ตรงไหน
const recentLog = []
const log = (...parts) => {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`
  recentLog.push({ at: Date.now(), text: parts.join(' ') })
  if (recentLog.length > 300) recentLog.splice(0, recentLog.length - 300)
  console.log(line)
  try {
    appendFileSync(LOG, line + '\n')
  } catch {}
}

function json(res, code, body) {
  const data = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-bridge-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-private-network': 'true',
  })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 256 * 1024 * 1024) return reject(new Error('payload ใหญ่เกินไป'))
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** เขียนไฟล์ที่ extension ส่งมา — ปลายทางถูกล็อกไว้ใน projects/ เท่านั้น */
function writeFiles(job, files) {
  const written = []
  for (const f of files ?? []) {
    // กัน path traversal — extension กำหนดชื่อไฟล์ได้ แต่ออกนอกโฟลเดอร์ที่สั่งไม่ได้
    const safe = String(f.name).replace(/[\\/]/g, '_').replace(/^\.+/, '')
    const dest = join(job.payload.outDir, safe)
    if (!dest.startsWith(join(ROOT, 'projects'))) throw new Error('ปลายทางไม่ถูกต้อง')
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, Buffer.from(f.base64, 'base64'))
    written.push(safe)
  }
  return written
}

/** ส่งงานให้ extension ที่กำลังรออยู่ ถ้าไม่มีคนรอก็ค้างในคิว */
function dispatch(job) {
  const idx = waiting.findIndex((w) => w.agent === job.agent)
  if (idx === -1) return
  const [w] = waiting.splice(idx, 1)
  clearTimeout(w.timer)
  job.status = 'running'
  job.touchedAt = Date.now()
  saveJobs()
  json(w.respond, 200, { id: job.id, kind: job.kind, payload: job.payload })
  log(`ส่งงาน ${job.kind} (${job.id.slice(0, 8)}) ให้ ${job.agent}`)
}

function enqueue(agent, kind, payload) {
  const job = { id: randomUUID(), agent, kind, payload, status: 'queued', progress: null, createdAt: Date.now(), touchedAt: Date.now(), attempts: 1 }
  jobs.set(job.id, job)
  saveJobs()
  log(`รับงาน ${kind} → ${agent} (${job.id.slice(0, 8)})`)
  dispatch(job)
  return job
}

const ui = createUi({ jobs, enqueue, lastPoll, token: TOKEN, port: PORT, json, readBody, log, recentLog: () => recentLog })

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') return json(res, 204, {})
  if (path === '/health') return json(res, 200, { ok: true, jobs: jobs.size, waiting: waiting.length })
  if (await ui.handle(req, res, url)) return

  // ทุก endpoint ที่เหลือต้องมี token — กันหน้าเว็บอื่นยิงเข้า localhost มาสั่งงาน
  const token = req.headers['x-bridge-token'] || url.searchParams.get('token')
  if (token !== TOKEN) return json(res, 401, { error: 'token ไม่ถูกต้อง' })

  try {
    // extension เทียบลายนิ้วมือไฟล์ของตัวเอง — เปลี่ยนแล้ว reload ตัวเองเมื่อไม่มีงานค้าง
    if (req.method === 'GET' && path === '/ext-version') {
      return json(res, 200, { version: extensionVersion(), busy: workInProgress() })
    }

    // ── ฝั่ง pipeline ────────────────────────────────────────────
    if (req.method === 'POST' && path === '/enqueue') {
      const { agent, kind, payload } = await readBody(req)
      if (!agent || !kind) return json(res, 400, { error: 'ต้องมี agent และ kind' })
      return json(res, 200, { id: enqueue(agent, kind, payload).id })
    }

    if (req.method === 'GET' && path === '/status') {
      const job = jobs.get(url.searchParams.get('id'))
      if (!job) return json(res, 404, { error: 'ไม่พบงานนี้' })
      job.watchedAt = Date.now() // ยังมีคนรองานนี้อยู่
      return json(res, 200, {
        status: job.status,
        progress: job.progress,
        result: job.result ?? null,
        error: job.error ?? null,
      })
    }

    if (req.method === 'POST' && path === '/cancel') {
      const { id, reason } = await readBody(req)
      const job = jobs.get(id)
      if (!job) return json(res, 404, { error: 'ไม่พบงานนี้' })
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'error'
        job.error = reason || 'ยกเลิกจาก pipeline'
        job.cancelled = true
        job.touchedAt = Date.now()
        saveJobs()
        log(`ยกเลิก ${job.kind} (${job.id.slice(0, 8)}): ${job.error}`)
      }
      return json(res, 200, { ok: true, status: job.status })
    }

    // ── ฝั่ง extension ───────────────────────────────────────────
    if (req.method === 'GET' && path === '/job') {
      const agent = url.searchParams.get('agent')
      lastPoll[agent] = Date.now()
      for (const j of jobs.values()) if (j.agent === agent && j.status === 'queued' && isOrphan(j)) dropOrphan(j)
      const pending = [...jobs.values()].find((j) => j.agent === agent && j.status === 'queued')
      if (pending) {
        pending.status = 'running'
        pending.touchedAt = Date.now()
        saveJobs()
        log(`ส่งงาน ${pending.kind} (${pending.id.slice(0, 8)}) ให้ ${agent}`)
        return json(res, 200, { id: pending.id, kind: pending.kind, payload: pending.payload })
      }
      // ไม่มีงาน → ค้างสายไว้ 25 วิ แล้วตอบ 204 (long-poll)
      const w = {
        agent,
        respond: res,
        timer: setTimeout(() => {
          const i = waiting.indexOf(w)
          if (i !== -1) waiting.splice(i, 1)
          json(res, 204, {})
        }, 25_000),
      }
      waiting.push(w)
      req.on('close', () => {
        const i = waiting.indexOf(w)
        if (i !== -1) {
          clearTimeout(w.timer)
          waiting.splice(i, 1)
        }
      })
      return
    }

    if (req.method === 'POST' && path === '/progress') {
      const { id, progress } = await readBody(req)
      const job = jobs.get(id)
      if (!job) return json(res, 404, { error: 'ไม่พบงานนี้' })
      // heartbeat ไม่มี progress — แค่บอกว่ายังทำงานอยู่
      if (progress) job.progress = progress
      job.touchedAt = Date.now()
      // bridge เพิ่งเปิดใหม่หรือเคยถูกตัดสินว่าหลุด แต่ extension ยังทำงานนี้อยู่จริง → กลับเป็น running
      if (job.status === 'queued') job.status = 'running'
      // ถูกยกเลิกแล้ว (pipeline หมดเวลา/ถูกปิด) → บอก extension ให้หยุด จะได้ไม่แย่งแท็บกับงานถัดไป
      return json(res, 200, { ok: true, status: job.status, cancelled: !!job.cancelled })
    }

    // เขียนไฟล์เป็นชุดๆ ระหว่างทาง โดยไม่ปิดงาน — สำหรับภาพ 30-40 ใบที่ส่งทีเดียวไม่ไหว
    if (req.method === 'POST' && path === '/partial') {
      const { id, files } = await readBody(req)
      const job = jobs.get(id)
      if (!job) return json(res, 404, { error: 'ไม่พบงานนี้' })
      if (job.cancelled) return json(res, 200, { ok: true, ignored: true, total: job.written?.length ?? 0 })
      let written
      try {
        written = writeFiles(job, files)
      } catch (err) {
        return json(res, 400, { error: err.message })
      }
      job.written = [...(job.written ?? []), ...written]
      job.touchedAt = Date.now()
      saveJobs()
      job.progress = { done: job.written.length, total: job.payload?.shots?.length ?? null }
      log(`รับไฟล์ระหว่างทาง ${written.length} ไฟล์ (${job.id.slice(0, 8)}) รวม ${job.written.length}`)
      return json(res, 200, { ok: true, total: job.written.length })
    }

    if (req.method === 'POST' && path === '/result') {
      const { id, text, files, meta } = await readBody(req)
      const job = jobs.get(id)
      if (!job) return json(res, 404, { error: 'ไม่พบงานนี้' })
      if (job.cancelled) return json(res, 200, { ok: true, ignored: true, written: 0 })
      // ส่งซ้ำ (retry จาก extension) → ตอบว่าได้แล้ว ไม่เขียนทับผลเดิม
      if (job.status === 'done') return json(res, 200, { ok: true, written: job.result?.files?.length ?? 0, duplicate: true })

      let written
      try {
        written = [...(job.written ?? []), ...writeFiles(job, files)]
      } catch (err) {
        return json(res, 400, { error: err.message })
      }

      job.status = 'done'
      job.result = { text: text ?? null, files: written, meta: meta ?? null }
      saveJobs()
      log(`เสร็จ ${job.kind} (${job.id.slice(0, 8)}) · ${written.length ? `${written.length} ไฟล์` : `${(text ?? '').length} ตัวอักษร`}`)
      return json(res, 200, { ok: true, written: written.length })
    }

    if (req.method === 'POST' && path === '/error') {
      const { id, message } = await readBody(req)
      const job = jobs.get(id)
      if (job && job.status !== 'done') {
        job.status = 'error'
        job.error = message
        saveJobs()
        log(`ล้มเหลว ${job.kind} (${job.id.slice(0, 8)}): ${message}`)
      }
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'ไม่มี endpoint นี้' })
  } catch (err) {
    return json(res, 500, { error: String(err.message) })
  }
})

/** มีงานค้างอยู่ไหม: งานของ ChatGPT/Flow ในคิว หรือขั้นของ pipeline กำลังรัน */
// นับเฉพาะงานของแท็บจริง — งานทดสอบ (agent x / cancel-test / flow-selftest) ที่ค้างไว้เคยขวางไม่ให้ bridge รีสตาร์ทรับโค้ดใหม่
const REAL_AGENTS = new Set(['chatgpt', 'flow', 'meta'])
const workInProgress = () => ui.busy() || [...jobs.values()].some((j) => REAL_AGENTS.has(j.agent) && (j.status === 'running' || (j.status === 'queued' && Date.now() - j.createdAt < 30 * 60_000)))

// โค้ดของโปรแกรมเปลี่ยน → รีสตาร์ทตัวเองเมื่อว่าง (เฉพาะตัวจริงที่ port 8765 — ตัวทดสอบไม่ต้อง)
if (PORT === 8765) watchBridgeCode({ busy: workInProgress, server, log })

// ตอนรีสตาร์ทตัวเอง ตัวเก่าอาจยังไม่ปล่อย port — ลองใหม่ทุกครึ่งวินาทีสูงสุด 15 วิ
let listenTries = 0
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && ++listenTries <= 30) return setTimeout(() => server.listen(PORT, '127.0.0.1'), 500)
  console.error(err.message)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  log(`bridge ทำงานที่ http://127.0.0.1:${PORT} (เปิดเฉพาะ localhost)`)
  console.log(`หน้า UI: http://127.0.0.1:${PORT}/`)
  console.log('เปิดค้างไว้ระหว่างรันขั้นที่ 1 (ChatGPT) และขั้นที่ 5 (Google Flow)')
})
