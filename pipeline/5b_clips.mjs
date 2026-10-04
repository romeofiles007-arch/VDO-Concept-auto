#!/usr/bin/env node
/**
 * ขั้นที่ 5b (ไม่บังคับ) — ทำคลิปขยับจริงด้วย Kie API จากภาพของ Flow บางช็อต
 *
 *   1. ChatGPT อ่านบททั้งคลิปแล้วเลือกช่วงสำคัญ (ฉากเปิด จุดหักมุม ไคลแมกซ์ ตอนจบ)
 *      ตามสัดส่วนที่ตั้งไว้ (config.clips.coveragePercent) · ChatGPT ตอบไม่ได้ → เลือกด้วยกฎในเครื่อง
 *   2. แนบภาพจริงให้ ChatGPT คิดคำสั่งการเคลื่อนไหวทีละภาพ (พลาด → ใช้ Action ของ prompt ภาพแทน)
 *   3. ม้าน้ำส่งภาพ + คำสั่งไป Kie API → รอวิดีโอ → เซฟ 05_images/clips/<timecode>.mp4
 *
 * ไม่มีคลิป / Kie เครดิตไม่พอ → ขั้นตัดต่อใช้ภาพเหมือนเดิม คลิปไม่พัง
 *
 *   node pipeline/5b_clips.mjs <slug> [--coverage 20|60|80|100] [--max N] [--redo]
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import { join, extname } from 'node:path'
import { loadConfig, projectDir } from './lib/config.mjs'
import { requireBridge, runJob } from './lib/bridge.mjs'
import { collectImages } from './lib/shotfile.mjs'
import { run } from './lib/ffmpeg.mjs'
import { clipSettings, clipTarget, clipsDir, clipName, collectClips, scenes, pickKeyShots, keyShotRequest, parseKeyShots, motionRequest, parseMotions, motionFor } from './lib/clips.mjs'
import { animateWithKie, kieKey, kieTier, fallbackOf } from './lib/kie.mjs'

// SSIM ของเฟรมแรกเทียบภาพต้นฉบับ — AI อาจขยับองค์ประกอบตั้งแต่เฟรมแรก
// จึงต้องเผื่อการเลื่อน/ซูมเล็กน้อย มิฉะนั้นคลิปที่ยังเป็นฉากเดิมจะถูกปฏิเสธผิด
const MIN_SIMILARITY = 0.20
async function firstFrameSimilarity(clip, image) {
  const out = await run('ffmpeg', [
    '-v', 'info', '-i', clip, '-i', image,
    '-filter_complex', '[0:v]trim=end_frame=1,scale=320:320,format=gray[a];[1:v]scale=320:320,format=gray[b];[a][b]ssim',
    '-frames:v', '1', '-f', 'null', '-',
  ])
  const m = /All:([\d.]+)/.exec(out)
  return m ? Number(m[1]) : null
}

const [slug, ...rest] = process.argv.slice(2)
if (!slug) {
  console.error('ใช้: node pipeline/5b_clips.mjs <slug> [--coverage 20|60|80|100] [--max N] [--redo]')
  process.exit(1)
}

const config = loadConfig()
const settings = clipSettings(config)
if (!settings.enabled) {
  console.log('ปิดแอนิเมชัน Kie — ใช้ภาพนิ่งตัดต่อ')
  process.exit(0)
}
kieKey() // แจ้งตั้งแต่ต้นก่อนเลือกฉาก/สร้างไฟล์ หากเปิด Kie แต่ยังไม่ได้ตั้ง key
const redo = rest.includes('--redo')
const dir = clipsDir(slug)
if (redo) rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const shotsFile = join(projectDir(slug, 'shotlist'), 'shots.json')
const shots = existsSync(shotsFile) ? JSON.parse(readFileSync(shotsFile, 'utf8')) : []
const images = new Map(collectImages(projectDir(slug, 'images')).images.map((i) => [i.name, i.file]))
const ready = shots.filter((s) => images.has(s.filename))
if (!ready.length) {
  console.error('ยังไม่มีภาพของคลิปนี้ — รันขั้นที่ 5 (Google Flow) ก่อน')
  process.exit(1)
}

const requestedCoverage = rest.includes('--coverage') ? Number(rest[rest.indexOf('--coverage') + 1]) : settings.coveragePercent
const coverage = [20, 60, 80, 100].includes(requestedCoverage) ? requestedCoverage : settings.coveragePercent
const sceneTotal = scenes(ready).length
const max = rest.includes('--max')
  ? Math.max(1, Math.min(sceneTotal, Number(rest[rest.indexOf('--max') + 1]) || 1))
  : clipTarget(sceneTotal, coverage)
console.log(`สัดส่วนแอนิเมชัน ${coverage}% ของเรื่อง: ${max}/${sceneTotal} ฉาก`)

const sceneOf = (shot) => scenes(ready).find((sc) => sc.includes(shot)) ?? [shot]

await requireBridge()

// ── ช่วงสำคัญของคลิป: ChatGPT เลือกจากบท (เก็บไว้ ลองซ้ำ/ทำต่อพรุ่งนี้ใช้ชุดเดิม) ──
// ChatGPT ไม่ตอบครั้งหนึ่ง (แท็บค้าง/ติด limit) → ข้ามคำถามที่เหลือ ไม่ให้ Kie ต้องรอหมดเวลาซ้ำทีละ 4–6 นาที
let chatgptDown = false
const picksFile = join(dir, 'picks.json')
let keyShots = existsSync(picksFile) ? parseKeyShots(readFileSync(picksFile, 'utf8'), ready, max) : []
if (keyShots.length < Math.min(max, ready.length)) {
  try {
    console.log(`ChatGPT อ่านบทเลือกช่วงสำคัญ ${max} ช็อต...`)
    const result = await runJob({
      agent: 'chatgpt',
      kind: 'prompt',
      payload: { prompt: keyShotRequest(ready, max), newChat: true },
      timeoutMs: 4 * 60_000, // ช้ากว่านี้ใช้กฎในเครื่องเลือกแทน ไม่ให้ Kie ต้องรอนาน
      label: 'เลือกช่วงสำคัญของคลิป',
    })
    keyShots = parseKeyShots(result?.text ?? '', ready, max)
  } catch (err) {
    chatgptDown = true
    console.warn(`ChatGPT เลือกไม่สำเร็จ: ${err.message}`)
  }
  if (keyShots.length < Math.min(max, ready.length)) {
    const extra = pickKeyShots(ready.filter((s) => !keyShots.includes(s)), max - keyShots.length)
    if (extra.length) console.log(`เลือกด้วยกฎในเครื่องเพิ่ม ${extra.length} ช็อต`)
    keyShots = [...keyShots, ...extra].sort((a, b) => a.start - b.start)
  }
  writeFileSync(picksFile, JSON.stringify(keyShots.map((s) => s.filename), null, 2))
}
console.log(`ช่วงสำคัญ: ${keyShots.map((s) => s.filename).join(', ')}`)

const have = collectClips(slug)
const picks = keyShots.filter((s) => !have.has(s.filename))
console.log(`คลิปขยับด้วย Kie API: ${keyShots.length} ช็อต · มีแล้ว ${have.size} · จะทำเพิ่ม ${picks.length}`)
if (!picks.length) process.exit(0)

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
const attachment = (s) => ({
  name: s.filename,
  type: MIME[extname(s.filename).toLowerCase()] ?? 'image/png',
  base64: readFileSync(images.get(s.filename)).toString('base64'),
})

// ── คำสั่งการเคลื่อนไหว: ChatGPT ดูภาพจริง (เก็บไว้ ลองซ้ำไม่ต้องถามใหม่) ──
const promptsFile = join(dir, 'motions.json')
const motions = existsSync(promptsFile) ? JSON.parse(readFileSync(promptsFile, 'utf8')) : {}
const needMotion = picks.filter((s) => motionFor(motions[s.filename]) !== motions[s.filename]) // ยังไม่มี หรือเป็นภาษาไทยของรอบก่อน
for (let i = 0; i < needMotion.length; i += 8) {
  const batch = needMotion.slice(i, i + 8) // แนบทีละไม่เกิน 8 ภาพ
  if (!chatgptDown) try {
    console.log(`ChatGPT ดูภาพคิดท่าขยับ ${batch.length} ภาพ...`)
    const result = await runJob({
      agent: 'chatgpt',
      kind: 'prompt',
      payload: { prompt: motionRequest(batch.map((s) => ({ ...s, scene: sceneOf(s) }))), newChat: true, attachments: batch.map(attachment) },
      timeoutMs: 6 * 60_000, // ช้ากว่านี้ใช้ท่าขยับมาตรฐานแทน
      label: 'คิดท่าขยับของคลิป',
    })
    Object.assign(motions, parseMotions(result?.text ?? '', batch.map((s) => s.filename)))
  } catch (err) {
    chatgptDown = true
    console.warn(`ChatGPT คิดท่าขยับไม่สำเร็จ: ${err.message} — ใช้ท่าขยับมาตรฐานแทน`)
  }
  for (const s of batch) motions[s.filename] = motionFor(motions[s.filename])
  writeFileSync(promptsFile, JSON.stringify(motions, null, 2))
}

// ── ม้าน้ำส่งให้ Kie API ทีละช็อต ──
let made = 0
let failedInRow = 0
const tier = kieTier(settings.tier)
let model = tier.model // โมเดลหลักล้ม → สลับเป็นตัวสำรองสำหรับช็อตที่เหลือ
console.log(`โมเดล Kie: ${tier.label} · ${tier.name} (${tier.detail} · ≈ ${tier.credits} เครดิต/ฉาก)`)
for (const [i, s] of picks.entries()) {
  const prompt = motionFor(motions[s.filename])
  console.log(`[${i + 1}/${picks.length}] ${s.filename} · ${prompt}`)
  try {
    const args = {
      imageFile: images.get(s.filename),
      outFile: join(dir, clipName(s.filename)),
      taskFile: join(dir, `${s.filename}.kie.json`),
      prompt,
      onProgress: (stage) => process.stdout.write(`\r  ${stage}   `),
    }
    let result
    try {
      result = await animateWithKie({ ...args, model })
    } catch (err) {
      // เครดิตหมด/ภาพใช้ไม่ได้ เปลี่ยนโมเดลก็ไม่ช่วย · นอกนั้น (เช่น Internal Error ทั้งโมเดล) ลองตัวสำรอง
      const next = fallbackOf(model)
      if (!next || /credit|balance|402|quota|width|height|10 MB/i.test(err.message)) throw err
      console.warn(`\n  ${model} ไม่สำเร็จ: ${err.message} — ลอง ${next}`)
      model = next
      result = await animateWithKie({ ...args, model })
    }
    if (result?.file) {
      // ตรวจว่าคลิปเริ่มจากภาพเดิมจริง — บางครั้ง AI วาดภาพใหม่ทั้งภาพ ตัดต่อแล้วภาพกระโดด
      const file = join(dir, clipName(s.filename))
      const score = await firstFrameSimilarity(file, images.get(s.filename)).catch(() => null)
      if (score != null && score < MIN_SIMILARITY) {
        renameSync(file, file.replace(/\.mp4$/i, `.rejected_${Date.now()}.mp4`))
        console.warn(`\n  คลิปไม่เหมือนภาพต้นฉบับ (ใกล้เคียง ${score.toFixed(2)}) — ไม่ใช้ ช็อตนี้ใช้ภาพแบบเดิม`)
        failedInRow++
      } else {
        made++
        failedInRow = 0
        console.log(`\n  ได้คลิป ${clipName(s.filename)}${score != null ? ` (เหมือนภาพต้นฉบับ ${score.toFixed(2)})` : ''}`)
      }
    }
  } catch (err) {
    console.warn(`\n  ไม่สำเร็จ: ${err.message}`)
    if (/credit|balance|402|quota/i.test(err.message)) {
      console.warn('Kie เครดิตไม่พอ — ช็อตที่เหลือใช้ภาพเดิม')
      break
    }
    if (++failedInRow >= 2) {
      console.warn('ล้มเหลวติดกัน 2 ช็อต — หยุดไว้ก่อน ช็อตที่เหลือใช้ภาพขยับแบบเดิม')
      break
    }
  }
}

const total = collectClips(slug).size
console.log(`\nเสร็จ: ได้คลิปใหม่ ${made} · รวม ${total} คลิปใน ${dir}`)
console.log(`ขั้นต่อไป: node pipeline/6_render.mjs ${slug}`)
