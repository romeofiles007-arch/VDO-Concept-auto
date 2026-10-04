import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './config.mjs'
import { clipsDir } from './clips.mjs'
import { kieKey } from './kie.mjs'

/**
 * ค่าใช้จ่ายต่อคลิป
 *
 * - Kie: เครดิตที่ใช้จริง (creditsConsumed จาก Kie) เก็บไว้ใน 05_images/clips/<ภาพ>.kie.json · 1 เครดิต = $0.005
 * - ChatGPT: ใช้ผ่านเว็บตามแพ็กเกจ ไม่เสียเงินเพิ่ม — นับ token แบบประมาณให้รู้ว่าใช้ไปเท่าไร
 *   (เว็บไม่บอกตัวเลขจริง: ไทย ≈ 2.5 ตัวอักษร/token · อังกฤษ ≈ 4 ตัวอักษร/token · รูปแนบ ≈ 765 token/รูป)
 * - Google Flow ใช้ 0 credits · เสียงพากย์ทำในเครื่อง → ไม่มีค่าใช้จ่าย
 */
export const KIE_USD_PER_CREDIT = 0.005
const IMAGE_TOKENS = 765
const FALLBACK_THB = 35
const FX_FILE = join(ROOT, 'projects', '_fx.json')
export const PENDING_USAGE = join(ROOT, 'projects', '_usage_pending.json')

export function estimateTokens(text = '') {
  const s = String(text)
  const thai = (s.match(/[฀-๿]/g) ?? []).length
  return Math.round(thai / 2.5 + (s.length - thai) / 4)
}

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/** บันทึกการคุยกับ ChatGPT หนึ่งครั้งลงไฟล์ของคลิป (autopilot ตั้ง CARTOON_USAGE_FILE ให้ขั้นลูกทุกขั้น) */
export function recordChatUsage({ prompt, text, attachments = 0 }, file = process.env.CARTOON_USAGE_FILE) {
  if (!file) return
  const u = readJson(file, {})
  const c = u.chatgpt ?? { calls: 0, inTokens: 0, outTokens: 0 }
  c.calls += 1
  c.inTokens += estimateTokens(prompt) + attachments * IMAGE_TOKENS
  c.outTokens += estimateTokens(text)
  u.chatgpt = c
  try { writeFileSync(file, JSON.stringify(u, null, 2)) } catch {}
}

/** ช่วงคิดหัวข้อยังไม่รู้ชื่อคลิป → จดไว้ที่ไฟล์พัก แล้วรวมเข้าคลิปเมื่อได้ชื่อ */
export function adoptPendingUsage(file) {
  if (!existsSync(PENDING_USAGE)) return
  const pending = readJson(PENDING_USAGE, {})
  const u = readJson(file, {})
  if (pending.chatgpt) {
    const c = u.chatgpt ?? { calls: 0, inTokens: 0, outTokens: 0 }
    for (const k of ['calls', 'inTokens', 'outTokens']) c[k] += pending.chatgpt[k] ?? 0
    u.chatgpt = c
    writeFileSync(file, JSON.stringify(u, null, 2))
  }
  rmSync(PENDING_USAGE, { force: true })
}

/** อัตรา USD→THB วันละครั้ง (open.er-api.com ไม่ต้องใช้ key) · ดึงไม่ได้ใช้ค่าเดิมที่เก็บไว้ หรือ 35 */
export async function usdToThb({ fetchImpl = fetch } = {}) {
  const cached = readJson(FX_FILE, null)
  const today = new Date().toISOString().slice(0, 10)
  if (cached?.date === today && cached.rate > 0) return cached
  try {
    const res = await fetchImpl('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(5000) })
    const rate = Number((await res.json())?.rates?.THB)
    if (rate > 0) {
      const fx = { rate, date: today, source: 'open.er-api.com' }
      try { writeFileSync(FX_FILE + '.tmp', JSON.stringify(fx)); renameSync(FX_FILE + '.tmp', FX_FILE) } catch {}
      return fx
    }
  } catch {}
  return cached?.rate > 0 ? { ...cached, stale: true } : { rate: FALLBACK_THB, date: null, source: 'ค่าตั้งต้น' }
}

/** งาน Kie รุ่นก่อนที่ยังไม่ได้จดเครดิต → ถาม Kie ด้วย taskId แล้วจดลงไฟล์ (ครั้งเดียวต่องาน) */
async function backfillCredits(dir, { fetchImpl = fetch } = {}) {
  if (!existsSync(dir)) return
  let key
  try { key = kieKey() } catch { return }
  const files = readdirSync(dir).filter((n) => n.endsWith('.kie.json'))
  await Promise.all(files.map(async (name) => {
    const file = join(dir, name)
    const task = readJson(file, null)
    if (!task?.taskId || task.credits != null) return
    try {
      const res = await fetchImpl(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(task.taskId)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) })
      const data = (await res.json())?.data
      if (!['success', 'fail'].includes(data?.state)) return
      writeFileSync(file, JSON.stringify({ ...task, credits: Number(data.creditsConsumed) || 0 }, null, 2))
    } catch {}
  }))
}

/** รวมค่าใช้จ่ายของคลิป: เครดิต Kie จริง + token ChatGPT โดยประมาณ + เงินบาท */
export async function clipCost(slug, opts) {
  const dir = clipsDir(slug)
  await backfillCredits(dir, opts)
  let credits = 0
  let clips = 0
  let unknown = 0
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.kie.json')) continue
      const task = readJson(join(dir, name), null)
      if (task?.credits == null) { unknown++; continue }
      credits += Number(task.credits) || 0
      clips++
    }
  }
  const usd = +(credits * KIE_USD_PER_CREDIT).toFixed(4)
  const fx = await usdToThb(opts)
  const chat = readJson(join(ROOT, 'projects', slug, 'usage.json'), {}).chatgpt ?? null
  return {
    kie: { credits: +credits.toFixed(2), clips, unknown },
    usd,
    thb: +(usd * fx.rate).toFixed(2),
    fx,
    chatgpt: chat && { calls: chat.calls, tokens: chat.inTokens + chat.outTokens, inTokens: chat.inTokens, outTokens: chat.outTokens },
  }
}
