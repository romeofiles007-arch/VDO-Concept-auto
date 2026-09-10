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
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { ROOT } from '../pipeline/lib/config.mjs'
import { loadEnv } from '../pipeline/lib/env.mjs'

loadEnv()

const PORT = Number(process.env.BRIDGE_PORT || 8765)
const TOKEN = process.env.BRIDGE_TOKEN || randomBytes(16).toString('hex')
if (!process.env.BRIDGE_TOKEN) {
  console.warn(`BRIDGE_TOKEN ยังไม่ได้ตั้งใน .env — ใช้ค่าชั่วคราวรอบนี้:\n  BRIDGE_TOKEN=${TOKEN}\nใส่ลง .env แล้วกรอกใน popup ของ extension ให้ตรงกัน`)
}

/** @type {Map<string, {id, agent, kind, payload, status, result, error, progress, createdAt}>} */
const jobs = new Map()
const waiting = [] // ผู้รอ job ฝั่ง extension: {agent, respond, timer}

const LOG = join(ROOT, 'bridge', 'bridge.log')
const log = (...parts) => {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`
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

/** ส่งงานให้ extension ที่กำลังรออยู่ ถ้าไม่มีคนรอก็ค้างในคิว */
function dispatch(job) {
  const idx = waiting.findIndex((w) => w.agent === job.agent)
  if (idx === -1) return
  const [w] = waiting.splice(idx, 1)
  clearTimeout(w.timer)
  job.status = 'running'
  json(w.respond, 200, { id: job.id, kind: job.kind, payload: job.payload })
  log(`ส่งงาน ${job.kind} (${job.id.slice(0, 8)}) ให้ ${job.agent}`)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') return json(res, 204, {})
  if (path === '/health') return json(res, 200, { ok: true, jobs: jobs.size, waiting: waiting.length })

  // ทุก endpoint ที่เหลือต้องมี token — กันหน้าเว็บอื่นยิงเข้า localhost มาสั่งงาน
  const token = req.headers['x-bridge-token'] || url.searchParams.get('token')
  if (token !== TOKEN) return json(res, 401, { error: 'token ไม่ถูกต้อง' })

  try {
    // ── ฝั่ง pipeline ────────────────────────────────────────────
    if (req.method === 'POST' && path === '/enqueue') {
      const { agent, kind, payload } = await readBody(req)
      if (!agent || !kind) return json(res, 400, { error: 'ต้องมี agent และ kind' })
      const job = { id: randomUUID(), agent, kind, payload, status: 'queued', progress: null, createdAt: Date.now() }
      jobs.set(job.id, job)
      log(`รับงาน ${kind} → ${agent} (${job.id.slice(0, 8)})`)
      dispatch(job)
      return json(res, 200, { id: job.id })
    }

    if (req.method === 'GET' && path === '/status') {
      const job = jobs.get(url.searchParams.get('id'))
      if (!job) return json(res, 404, { error: 'ไม่พบงานนี้' })
      return json(res, 200, {
        status: job.status,
        progress: job.progress,
        result: job.result ?? null,
        error: job.error ?? null,
      })
    }

    // ── ฝั่ง extension ───────────────────────────────────────────
    if (req.method === 'GET' && path === '/job') {
      const agent = url.searchParams.get('agent')
      const pending = [...jobs.values()].find((j) => j.agent === agent && j.status === 'queued')
      if (pending) {
        pending.status = 'running'
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
      if (job) job.progress = progress
      return json(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path === '/result') {
      const { id, text, files, meta } = await readBody(req)
      const job = jobs.get(id)
      if (!job) return json(res, 404, { error: 'ไม่พบงานนี้' })

      const written = []
      for (const f of files ?? []) {
        // กัน path traversal — extension กำหนดชื่อไฟล์ได้ แต่ออกนอกโฟลเดอร์ที่สั่งไม่ได้
        const safe = String(f.name).replace(/[\\/]/g, '_').replace(/^\.+/, '')
        const dest = join(job.payload.outDir, safe)
        if (!dest.startsWith(join(ROOT, 'projects'))) return json(res, 400, { error: 'ปลายทางไม่ถูกต้อง' })
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, Buffer.from(f.base64, 'base64'))
        written.push(safe)
      }

      job.status = 'done'
      job.result = { text: text ?? null, files: written, meta: meta ?? null }
      log(`เสร็จ ${job.kind} (${job.id.slice(0, 8)}) · ${written.length ? `${written.length} ไฟล์` : `${(text ?? '').length} ตัวอักษร`}`)
      return json(res, 200, { ok: true, written: written.length })
    }

    if (req.method === 'POST' && path === '/error') {
      const { id, message } = await readBody(req)
      const job = jobs.get(id)
      if (job) {
        job.status = 'error'
        job.error = message
        log(`ล้มเหลว ${job.kind} (${job.id.slice(0, 8)}): ${message}`)
      }
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'ไม่มี endpoint นี้' })
  } catch (err) {
    return json(res, 500, { error: String(err.message) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  log(`bridge ทำงานที่ http://127.0.0.1:${PORT} (เปิดเฉพาะ localhost)`)
  console.log('เปิดค้างไว้ระหว่างรันขั้นที่ 1 (ChatGPT) และขั้นที่ 5 (Google Flow)')
})
