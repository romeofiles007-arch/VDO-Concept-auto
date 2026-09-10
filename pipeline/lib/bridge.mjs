import { loadEnv } from './env.mjs'

loadEnv()

const PORT = Number(process.env.BRIDGE_PORT || 8765)
const BASE = `http://127.0.0.1:${PORT}`

function headers() {
  const token = process.env.BRIDGE_TOKEN
  if (!token) {
    console.error('ยังไม่ได้ตั้ง BRIDGE_TOKEN ใน .env')
    process.exit(1)
  }
  return { 'content-type': 'application/json', 'x-bridge-token': token }
}

export async function bridgeAlive() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

export async function requireBridge() {
  if (await bridgeAlive()) return
  console.error(`ไม่พบ bridge ที่ ${BASE}\nเปิดอีกหน้าต่างแล้วรัน: node bridge/server.js`)
  process.exit(1)
}

/**
 * ส่งงานให้ extension แล้วรอจนเสร็จ
 * @param {{agent:'chatgpt'|'flow', kind:string, payload:object, timeoutMs?:number, onProgress?:(p)=>void}} job
 */
export async function runJob({ agent, kind, payload, timeoutMs = 20 * 60_000, onProgress }) {
  const enq = await fetch(`${BASE}/enqueue`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ agent, kind, payload }),
  })
  if (!enq.ok) throw new Error(`enqueue ล้มเหลว: ${await enq.text()}`)
  const { id } = await enq.json()

  const deadline = Date.now() + timeoutMs
  let lastProgress = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const res = await fetch(`${BASE}/status?id=${id}`, { headers: headers() })
    if (!res.ok) throw new Error(`อ่านสถานะไม่ได้: ${await res.text()}`)
    const job = await res.json()

    if (job.progress && JSON.stringify(job.progress) !== JSON.stringify(lastProgress)) {
      lastProgress = job.progress
      onProgress?.(job.progress)
    }
    if (job.status === 'done') return job.result
    if (job.status === 'error') throw new Error(`extension แจ้งข้อผิดพลาด: ${job.error}`)
  }
  throw new Error(`งาน ${kind} ไม่เสร็จภายใน ${Math.round(timeoutMs / 60000)} นาที`)
}
