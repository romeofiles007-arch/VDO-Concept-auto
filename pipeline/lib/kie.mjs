import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { loadEnv } from './env.mjs'

// ถูกสุดบน Kie (ก.ย. 2026): Seedance 1.5 Pro 480p ไม่มีเสียง ≈ 8.75 เครดิต/คลิป 5 วิ
// (v1-lite ตอบ Internal Error ทุกงาน · v1-pro 14 เครดิต)
export const KIE_MODEL = 'bytedance/seedance-1.5-pro'
/** สำรองเมื่อโมเดลหลักล้ม (Kie เคยพังทั้งโมเดลแบบ Internal Error) — แพงกว่า (14 เครดิต) แต่ดีกว่าได้ภาพนิ่ง */
export const KIE_FALLBACK_MODEL = 'bytedance/v1-pro-image-to-video'
export const KIE_RESOLUTION = '480p'
export const KIE_DURATION = '5'

// แต่ละโมเดลใช้ชื่อพารามิเตอร์ไม่เหมือนกัน (ตาม docs.kie.ai)
const INPUTS = {
  'bytedance/seedance-1.5-pro': ({ imageUrl, prompt, image }) => ({
    input_urls: [imageUrl], prompt, aspect_ratio: aspectOf(image),
    resolution: KIE_RESOLUTION, duration: Number(KIE_DURATION), fixed_lens: true, generate_audio: false,
  }),
  'bytedance/v1-pro-image-to-video': ({ imageUrl, prompt }) => ({
    image_url: imageUrl, prompt, resolution: KIE_RESOLUTION, duration: KIE_DURATION, camera_fixed: true,
  }),
  'hailuo/2-3-image-to-video-standard': ({ imageUrl, prompt }) => ({
    image_url: imageUrl, prompt, duration: '6', resolution: '768P',
  }),
  'kling-2.6/image-to-video': ({ imageUrl, prompt }) => ({
    image_urls: [imageUrl], prompt: prompt.slice(0, 1000), sound: false, duration: '5',
  }),
}

/**
 * 3 ระดับให้เลือกในตั้งค่าม้าน้ำ (ราคา kie.ai/pricing ก.ย. 2026 · 1 เครดิต = $0.005)
 * ทุกตัวทดสอบยิงจริงกับภาพการ์ตูนแนวตั้งแล้ว
 */
export const KIE_TIERS = {
  cheap: { label: 'ถูก', model: 'bytedance/seedance-1.5-pro', name: 'Seedance 1.5 Pro', credits: 8.75, detail: '480p · 5 วิ' },
  mid: { label: 'พอใช้', model: 'hailuo/2-3-image-to-video-standard', name: 'Hailuo 2.3', credits: 30, detail: '768p · 6 วิ' },
  pro: { label: 'เก่ง', model: 'kling-2.6/image-to-video', name: 'Kling 2.6', credits: 55, detail: 'คมชัด · 5 วิ' },
}
export const kieTier = (tier) => KIE_TIERS[tier] ?? KIE_TIERS.cheap
/** ตัวหลักล้ม → ลองตัวสำรอง: ระดับถูกสำรองด้วย v1-pro · ระดับอื่นถอยมาใช้ Seedance (ถูกกว่า ดีกว่าได้ภาพนิ่ง) */
export const fallbackOf = (model) => (model === KIE_TIERS.cheap.model ? KIE_FALLBACK_MODEL : model === KIE_FALLBACK_MODEL ? null : KIE_TIERS.cheap.model)
const API = 'https://api.kie.ai/api/v1/jobs'
const UPLOAD = 'https://kieai.redpandaai.co/api/file-stream-upload'
const RATIOS = { '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9, '9:16': 9 / 16, '21:9': 21 / 9 }

/** Seedance ต้องระบุสัดส่วนเอง — เลือกค่าที่ใกล้ภาพที่สุด ไม่ให้คลิปถูกครอป (อ่านขนาดจากหัวไฟล์ PNG) */
export function aspectOf(image) {
  const isPng = image.length > 24 && image.readUInt32BE(0) === 0x89504e47
  if (!isPng) return '16:9'
  const ratio = image.readUInt32BE(16) / image.readUInt32BE(20)
  return Object.entries(RATIOS).sort((a, b) => Math.abs(Math.log(a[1] / ratio)) - Math.abs(Math.log(b[1] / ratio)))[0][0]
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

export function kieKey() {
  loadEnv()
  const key = process.env.KIE_API_KEY?.trim()
  if (!key) throw new Error('ยังไม่มี Kie API key — กรอกในตั้งค่าม้าน้ำ หรือปิดแอนิเมชันเพื่อใช้ภาพนิ่ง')
  return key
}

async function responseJson(response, label) {
  const data = await response.json().catch(() => null)
  if (!response.ok || !data || (data.code != null && data.code !== 200) || data.success === false) {
    throw new Error(`${label}: ${data?.msg || data?.message || `HTTP ${response.status}`}`)
  }
  return data
}

async function request(url, options, label, fetchImpl) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(60_000) })
  return responseJson(response, label)
}

/**
 * ห้ามมีตัวอักษรในคลิป — ท่าขยับสำรองมาจาก Action ของ prompt ภาพ ซึ่งบางทีสั่งให้เขียนข้อความ
 * ("มี thought bubble ข้อความ \"ตั้งใจล้วนๆ\"") ตัดคำในเครื่องหมายคำพูดออกไม่ให้โมเดลมีคำไปเขียน แล้วย้ำทั้งต้นและท้าย
 */
export function kiePrompt(motion) {
  const clean = String(motion)
    .replace(/["“”「」『』][^"“”「」『』]*["“”「」『』]/g, '')
    .replace(/(?:มี|พร้อม)?\s*(?:(?:thought|speech)\s*bubble|ข้อความ(?:บนภาพ)?|ตัวอักษร|ตัวหนังสือ|ป้าย(?:สั้น)?|ลูกศร|คำบรรยาย|text|caption|label)s?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `No text of any kind. Begin exactly on the provided first frame (same composition, characters, poses and background). ${clean}. Make the described action clearly visible, expressive and natural, with secondary motion on hair, clothes and props. Keep the original cartoon style, colors and faces. Static camera or very slow push-in. One continuous shot; no cuts or new objects. Absolutely no text, letters, words, numbers, captions, subtitles, speech bubbles, signs, labels, watermarks or logos appearing anywhere in the video; do not add or change any writing.`
}

export async function animateWithKie({ imageFile, outFile, prompt, taskFile, model = KIE_MODEL, onProgress = () => {}, fetchImpl = fetch, pollMs = 5000, timeoutMs = 15 * 60_000 }) {
  const key = kieKey()
  const headers = { Authorization: `Bearer ${key}` }
  const image = readFileSync(imageFile)
  const type = MIME[extname(imageFile).toLowerCase()]
  if (!type || image.length > 10_000_000) throw new Error('Kie รับภาพ PNG/JPEG/WebP ขนาดไม่เกิน 10 MB')
  const fingerprint = createHash('sha256').update(image).update(kiePrompt(prompt)).update(model).digest('hex')
  let saved = null
  try { saved = JSON.parse(readFileSync(taskFile, 'utf8')) } catch {}
  let taskId = saved?.fingerprint === fingerprint ? saved.taskId : null

  if (!taskId) {
    onProgress('อัปโหลดภาพไป Kie')
    const form = new FormData()
    form.set('file', new Blob([image], { type }), basename(imageFile))
    form.set('uploadPath', 'cartoon-auto/images')
    const uploaded = await request(UPLOAD, { method: 'POST', headers, body: form }, 'อัปโหลดภาพไม่สำเร็จ', fetchImpl)
    const imageUrl = uploaded.data?.downloadUrl || uploaded.data?.fileUrl
    if (!imageUrl?.startsWith('https://')) throw new Error('Kie ไม่ส่ง URL ของภาพกลับมา')

    onProgress('ส่งคำขอแอนิเมชันไป Kie')
    const created = await request(`${API}/createTask`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: INPUTS[model]({ imageUrl, prompt: kiePrompt(prompt), image }) }),
    }, 'สร้างงาน Kie ไม่สำเร็จ', fetchImpl)
    taskId = created.data?.taskId
    if (!taskId) throw new Error('Kie ไม่ส่ง taskId กลับมา')
    writeFileSync(taskFile, JSON.stringify({ taskId, fingerprint, model }, null, 2))
  } else onProgress('ทำต่อจากงาน Kie ที่ส่งไว้แล้ว')

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await request(`${API}/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers }, 'อ่านสถานะ Kie ไม่สำเร็จ', fetchImpl)
    const state = result.data?.state
    if (state === 'fail') {
      rmSync(taskFile, { force: true }) // งานที่ล้มแล้วไม่ต้องจำไว้ — รันใหม่จะส่งงานใหม่ ไม่ใช่วนอ่านงานที่ล้มเดิม
      throw new Error(`Kie สร้างคลิปไม่สำเร็จ: ${result.data?.failMsg || result.data?.failCode || 'ไม่ทราบสาเหตุ'}`)
    }
    if (state === 'success') {
      const parsed = typeof result.data.resultJson === 'string' ? JSON.parse(result.data.resultJson) : result.data.resultJson
      const videoUrl = parsed?.resultUrls?.[0]
      if (!videoUrl || !/^https:\/\//.test(videoUrl)) throw new Error('Kie ทำงานเสร็จแต่ไม่ส่งลิงก์วิดีโอ')
      onProgress('ดาวน์โหลดคลิปจาก Kie')
      const video = await fetchImpl(videoUrl, { signal: AbortSignal.timeout(120_000) })
      if (!video.ok) throw new Error(`ดาวน์โหลดคลิป Kie ไม่สำเร็จ: HTTP ${video.status}`)
      const bytes = Buffer.from(await video.arrayBuffer())
      if (bytes.length < 20_000 || bytes.length > 200_000_000) throw new Error('ไฟล์คลิป Kie ไม่สมบูรณ์หรือใหญ่เกินไป')
      writeFileSync(`${outFile}.tmp`, bytes)
      renameSync(`${outFile}.tmp`, outFile)
      // เครดิตที่ Kie หักจริง — ใช้รวมค่าใช้จ่ายของคลิป (pipeline/lib/usage.mjs)
      const credits = Number(result.data.creditsConsumed) || 0
      writeFileSync(taskFile, JSON.stringify({ taskId, fingerprint, model, credits, doneAt: Date.now() }, null, 2))
      return { taskId, file: outFile, credits }
    }
    onProgress(`Kie กำลังสร้างคลิป (${state || 'รอคิว'})`)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error(`Kie ใช้เวลานานเกินกำหนด — งาน ${taskId} ถูกบันทึกไว้ กดทำต่อภายหลังได้`)
}
