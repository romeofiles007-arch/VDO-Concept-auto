#!/usr/bin/env node
/**
 * Native messaging host — ให้กดไอคอน extension ครั้งเดียวแล้วพร้อมใช้
 *
 * Chrome เรียกไฟล์นี้เมื่อ extension ส่ง { type: 'ensure' } มา:
 *   1. bridge ยังไม่รัน → เปิดให้แบบซ่อนหน้าต่าง แล้วรอจนตอบ /health
 *   2. ยังไม่มี BRIDGE_TOKEN ใน .env → สร้างให้แล้วเขียนลงไฟล์
 *   3. ตอบ { ok, port, token } ให้ extension เอาไปตั้งค่าเอง ผู้ใช้ไม่ต้องคัดลอกรหัส
 *
 * มีแค่ extension ที่ ID ตรงกับ allowed_origins ใน manifest ของ host เท่านั้นที่เรียกได้
 * (ลงทะเบียนด้วย ติดตั้งครั้งแรก.bat)
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_FILE = join(ROOT, '.env')
const START_TIMEOUT_MS = 20_000

// ── โปรโตคอลของ Chrome: ข้อความ = ความยาว 4 ไบต์ (little-endian) + JSON ──
function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  // รอให้เขียนลง pipe เสร็จก่อนจบ process ไม่งั้นคำตอบขาดหาย
  return new Promise((resolve) => process.stdout.write(Buffer.concat([head, body]), resolve))
}

function readMessage() {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    process.stdin.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 4) return
      const len = buf.readUInt32LE(0)
      if (buf.length < 4 + len) return
      resolve(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')))
    })
    process.stdin.on('end', () => reject(new Error('ไม่มีข้อความจาก extension')))
  })
}

function readEnv() {
  const env = {}
  if (!existsSync(ENV_FILE)) return env
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line)
    if (m) env[m[1]] = m[2]
  }
  return env
}

/** token ต้องคงที่ข้ามการเปิดปิด — ถ้ายังไม่มีก็สร้างครั้งเดียวแล้วเก็บใน .env */
function ensureToken(env) {
  if (env.BRIDGE_TOKEN) return env.BRIDGE_TOKEN
  const token = randomBytes(16).toString('hex')
  if (!existsSync(ENV_FILE)) writeFileSync(ENV_FILE, '')
  const text = readFileSync(ENV_FILE, 'utf8')
  if (/^\s*BRIDGE_TOKEN\s*=.*$/m.test(text)) writeFileSync(ENV_FILE, text.replace(/^\s*BRIDGE_TOKEN\s*=.*$/m, `BRIDGE_TOKEN=${token}`))
  else appendFileSync(ENV_FILE, `${text && !text.endsWith('\n') ? '\n' : ''}BRIDGE_TOKEN=${token}\n`)
  return token
}

async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * เปิด bridge ผ่าน WMI แทน spawn ตรงๆ — Chrome ปิด process ลูกของ native host ทิ้งเมื่อ host จบ
 * process ที่ WMI สร้างไม่ได้เป็นลูกของ host จึงรันค้างต่อได้ และซ่อนหน้าต่างได้ (ShowWindow = 0)
 */
function startBridge() {
  const cmd = `"${process.execPath}" "${join(ROOT, 'bridge', 'server.js')}"`.replace(/'/g, "''")
  const ps = [
    `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }`,
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd}'; CurrentDirectory = '${ROOT.replace(/'/g, "''")}'; ProcessStartupInformation = $si }`,
    `exit $r.ReturnValue`,
  ].join('; ')
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore' })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

async function ensure() {
  const env = readEnv()
  const port = Number(env.BRIDGE_PORT || 8765)
  const token = ensureToken(env)

  if (!(await healthy(port))) {
    if (!(await startBridge())) return { ok: false, error: 'เปิดโปรแกรมไม่สำเร็จ (สร้าง process ไม่ได้)' }
    const deadline = Date.now() + START_TIMEOUT_MS
    while (!(await healthy(port))) {
      if (Date.now() > deadline) return { ok: false, error: 'เปิดโปรแกรมแล้วแต่ไม่ตอบภายใน 20 วินาที — ดู bridge/bridge.log' }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  return { ok: true, port, token, url: `http://127.0.0.1:${port}/` }
}

try {
  const msg = await readMessage()
  if (msg?.type !== 'ensure') await send({ ok: false, error: `ไม่รู้จักคำสั่ง ${msg?.type}` })
  else await send(await ensure())
} catch (err) {
  await send({ ok: false, error: String(err.message) })
}
process.exit(0)
