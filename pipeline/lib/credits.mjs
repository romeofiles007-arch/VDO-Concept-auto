/**
 * เครดิตคงเหลือของบริการที่ใช้เงิน — แสดงค้างไว้บนสุดของแผงข้าง
 * (ยกมาจากโปรแกรมตำนานจีนที่โครงเดียวกัน — ผู้ใช้ 21 พ.ย. 2026: "ให้มีสถานะเครดิตทุกอย่างแสดงค้างไว้ด้านบน เช่น ElevenLabs และ Kie")
 * อ่านไม่ได้ → บอกเหตุผล ไม่ขวางงานผลิต · มี key ของบริการไหนค่อยแสดงบริการนั้น
 */
import { loadEnv } from './env.mjs'
import { kieBalance } from './kie.mjs'

const key = (name) => (loadEnv(), process.env[name]?.trim() || '')

/** ElevenLabs: ใช้ไป/โควตาของรอบบิล — ต้องใช้ key ที่มีสิทธิ์ User: Read (key ที่สร้างแบบจำกัดสิทธิ์อ่านไม่ได้) */
export async function elevenCredits(fetchImpl = fetch) {
  const k = key('ELEVENLABS_API_KEY')
  if (!k) return null
  try {
    const r = await fetchImpl('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': k }, signal: AbortSignal.timeout(15_000) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) {
      const status = d?.detail?.status ?? d?.detail?.code
      if (status === 'missing_permissions') return { error: 'key นี้ไม่มีสิทธิ์อ่านเครดิต — สร้าง key ใหม่ที่เปิด "User: Read" ด้วย', short: 'key ไม่มีสิทธิ์อ่าน' }
      if (r.status === 401) return { error: 'API key ใช้ไม่ได้' }
      return { error: d?.detail?.message ?? `ตอบ ${r.status}` }
    }
    const used = Number(d.character_count) || 0
    const limit = Number(d.character_limit) || 0
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      tier: d.tier ?? null,
      resetAt: d.next_character_count_reset_unix ? d.next_character_count_reset_unix * 1000 : null,
    }
  } catch (err) {
    return { error: err.name === 'TimeoutError' ? 'ElevenLabs ไม่ตอบ' : err.message }
  }
}

/** Kie: เครดิตคงเหลือ */
export async function kieCredits(fetchImpl = fetch) {
  if (!key('KIE_API_KEY')) return null
  const balance = await kieBalance(fetchImpl)
  return balance == null ? { error: 'อ่านเครดิต Kie ไม่ได้' } : { remaining: balance }
}

let cache = null
/** ทุกบริการ — จำไว้ 5 นาที (แผงข้างถามทุก 1 นาที ไม่ต้องยิงไปหาบริการทุกครั้ง) · refresh = อ่านใหม่ทันที */
export async function allCredits({ refresh = false, now = Date.now(), fetchImpl = fetch } = {}) {
  if (!refresh && cache && now - cache.at < 5 * 60_000) return cache
  const [elevenlabs, kie] = await Promise.all([elevenCredits(fetchImpl), kieCredits(fetchImpl)])
  const services = [
    elevenlabs && { id: 'elevenlabs', label: 'ElevenLabs', unit: 'เครดิต', ...elevenlabs },
    kie && { id: 'kie', label: 'Kie', unit: 'เครดิต', ...kie },
  ].filter(Boolean)
  cache = { at: now, services }
  return cache
}
