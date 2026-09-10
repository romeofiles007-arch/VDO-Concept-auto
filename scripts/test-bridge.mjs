// จำลอง extension คุยกับ bridge — ตรวจว่า queue/long-poll/เขียนไฟล์/ป้องกัน token ทำงานถูก
import { runJob } from '../pipeline/lib/bridge.mjs'
import { projectDir } from '../pipeline/lib/config.mjs'
import { readdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.BRIDGE_PORT || 8765
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = process.env.BRIDGE_TOKEN
const outDir = projectDir('_bridgetest', 'images')
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })

// 1x1 png
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// ── ฝั่ง extension จำลอง: poll แล้วตอบกลับ ──
;(async () => {
  const res = await fetch(`${BASE}/job?agent=flow`, { headers: { 'x-bridge-token': TOKEN } })
  if (res.status !== 200) throw new Error(`long-poll ควรได้งาน แต่ได้ ${res.status}`)
  const job = await res.json()
  console.log(`  extension ได้งาน: ${job.kind}`)
  await fetch(`${BASE}/progress`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN }, body: JSON.stringify({ id: job.id, progress: { done: 1, total: 2 } }) })
  await new Promise((r) => setTimeout(r, 300))
  await fetch(`${BASE}/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN },
    body: JSON.stringify({ id: job.id, files: [{ name: '00_00_00.png', base64: PNG }, { name: '00_00_02_5.png', base64: PNG }] }),
  })
})()

// ── ฝั่ง pipeline: สั่งงานแล้วรอ ──
const result = await runJob({
  agent: 'flow',
  kind: 'generate-images',
  payload: { outDir, prompt: 'ทดสอบ' },
  timeoutMs: 20_000,
  onProgress: (p) => console.log(`  progress: ${p.done}/${p.total}`),
})
console.log('  ได้ไฟล์:', result.files.join(', '))

const written = readdirSync(outDir)
if (written.length !== 2) throw new Error(`ควรได้ 2 ไฟล์ แต่ได้ ${written.length}`)

// ── ตรวจว่า token ผิดถูกปฏิเสธ ──
const bad = await fetch(`${BASE}/enqueue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': 'wrong-token' }, body: '{}' })
if (bad.status !== 401) throw new Error(`token ผิดควรได้ 401 แต่ได้ ${bad.status}`)
console.log('  token ผิด → 401 ถูกต้อง')

// ── ตรวจว่าเขียนออกนอก projects/ ไม่ได้ ──
const esc = await fetch(`${BASE}/enqueue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN }, body: JSON.stringify({ agent: 'x', kind: 'k', payload: { outDir: 'C:\Windows\Temp' } }) })
const { id } = await esc.json()
await fetch(`${BASE}/job?agent=x`, { headers: { 'x-bridge-token': TOKEN } })
const escRes = await fetch(`${BASE}/result`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN }, body: JSON.stringify({ id, files: [{ name: 'evil.png', base64: PNG }] }) })
if (escRes.status !== 400) throw new Error(`เขียนออกนอก projects/ ควรได้ 400 แต่ได้ ${escRes.status}`)
console.log('  เขียนออกนอก projects/ → 400 ถูกต้อง')

rmSync(projectDir('_bridgetest'), { recursive: true, force: true })
console.log('\nbridge ผ่านทุกข้อ')
