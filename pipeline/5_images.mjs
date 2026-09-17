#!/usr/bin/env node
/**
 * ขั้นที่ 5 — gen ภาพด้วย Google Flow Agent (ข้อ 5-7 ของสเปก)
 *
 * extension จะ: new project → เลือกโหมด agent → วาง prompt → รอ gen
 * → ดึงภาพตามลำดับ shot แล้วเซฟเป็นชื่อ timecode ผ่าน bridge
 *
 *   node pipeline/5_images.mjs <slug>
 *   node pipeline/5_images.mjs <slug> --rename   สั่ง agent เปลี่ยนชื่อ shot ก่อนโหลดด้วย
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, projectDir } from './lib/config.mjs'
import { requireBridge, runJob } from './lib/bridge.mjs'
import { flowPrompt, aspectOf, stripSafeArea } from './lib/prompts.mjs'
import { characterAttachments } from './lib/character.mjs'
import { coverShot, coverBriefLines, hasCover, COVER_NAME } from './lib/cover.mjs'
import { probeSize } from './lib/ffmpeg.mjs'
import { collectImages } from './lib/shotfile.mjs'

const slug = process.argv[2]
if (!slug) {
  console.error('ใช้: node pipeline/5_images.mjs <slug> [--rename]')
  process.exit(1)
}

const config = loadConfig()
if (config.images.provider !== 'google-flow') {
  console.error(`ขั้นนี้รองรับเฉพาะ google-flow — ตอนนี้ config ตั้งเป็น ${config.images.provider}`)
  process.exit(1)
}

const shotDir = projectDir(slug, 'shotlist')
const briefFile = join(shotDir, 'agent_brief.txt')
if (!existsSync(briefFile)) {
  console.error('ไม่พบ agent_brief.txt — รันขั้นที่ 4 ก่อน')
  process.exit(1)
}

const allShots = JSON.parse(readFileSync(join(shotDir, 'shots.json'), 'utf8'))
  .filter((s) => s.prompt)
  .map((s) => ({ ...s, prompt: stripSafeArea(s.prompt).trim() })) // ไม่ให้ Flow เว้นแถบว่างในภาพ
const imagesDir = projectDir(slug, 'images')

const existing = collectImages(imagesDir).images
// --missing: สร้างเฉพาะช็อตที่ยังไม่มีภาพ (เช่น เติม prompt ที่ขาดทีหลัง หรือ Flow ทำไม่ครบรอบก่อน)
// --cover-only: สร้างแค่ภาพปกคลิป (project เก่าที่ยังไม่มีปก)
const onlyMissing = process.argv.includes('--missing')
const coverOnly = process.argv.includes('--cover-only')
const have = new Set(existing.map((i) => i.name))
if (hasCover(slug)) have.add(COVER_NAME)
const titleFile = join(projectDir(slug, 'script'), 'title.txt')
const title = existsSync(titleFile) ? readFileSync(titleFile, 'utf8').trim() : slug
// ปกคลิปเป็นภาพสุดท้ายเสมอ — มีอยู่แล้วก็ไม่สร้างซ้ำ (ยกเว้นสั่ง --cover-only)
const cover = coverOnly || !have.has(COVER_NAME) ? coverShot(slug, title) : null
const timeline = coverOnly ? [] : onlyMissing ? allShots.filter((s) => !have.has(s.filename)) : allShots
const shots = [...timeline, ...(cover ? [cover] : [])]
if (coverOnly) console.log('สร้างภาพปกคลิป')
if (onlyMissing) console.log(`มีภาพแล้ว ${existing.length} ใบ · สร้างเฉพาะที่ขาด ${shots.length} ช็อต`)
else if (existing.length && !coverOnly) console.log(`มีภาพอยู่แล้ว ${existing.length} ใบใน ${imagesDir} — จะถูกเขียนทับถ้าชื่อซ้ำ`)
if (!shots.length) {
  console.log('ทุกช็อตมีภาพครบแล้ว')
  process.exit(0)
}

// brief = Style + Character Bible เดิม + เฉพาะ shot ที่จะสร้าง
const briefHead = stripSafeArea(readFileSync(briefFile, 'utf8').split(/^=== SHOT LIST ===$/m)[0]).trim()
// แนวภาพของปก/ช็อตใหม่: ถ้ามีภาพของคลิปนี้แล้ว ใช้แนวเดียวกับภาพที่มี (คลิปเก่าแนวนอนได้ปกแนวนอน)
let aspect = aspectOf(config)
if (existing.length) {
  const { width, height } = await probeSize(existing[0].file).catch(() => ({}))
  if (width && height) aspect = height > width ? '9:16' : '16:9'
}
const shotLines = timeline.map((s) => `${s.filename} ${stripSafeArea(s.prompt).trim()}`)
const brief = [
  briefHead,
  ...(shotLines.length ? ['=== SHOT LIST ===', ...shotLines] : []),
  ...(cover ? coverBriefLines(cover, aspect === '9:16') : []),
].join('\n\n')

// project ใน Flow ของคลิปนี้ — ลองซ้ำ/ทำต่อจะกลับไป project เดิม (--new-project = เปิดใหม่)
const projectFile = join(imagesDir, '_flow_project.json')
const savedProject = !process.argv.includes('--new-project') && existsSync(projectFile) ? JSON.parse(readFileSync(projectFile, 'utf8')) : null
if (savedProject?.url) console.log(`ใช้ project เดิมใน Flow: ${savedProject.url}`)

await requireBridge()
console.log(`ส่ง ${coverOnly ? 'ภาพปก' : `${shots.length} ช็อต`}ให้ Google Flow — เปิดดูเบราว์เซอร์ได้ ห้ามปิดแท็บระหว่างรอ`)
if (!coverOnly) console.log('งาน batch ขนาดนี้ปกติใช้เวลา 10-40 นาที')

const result = await runJob({
  agent: 'flow',
  kind: 'generate-images',
  payload: {
    prompt: flowPrompt(brief),
    shots: shots.map((s) => ({ filename: s.filename, shot: s.shot, prompt: s.prompt })),
    model: 'Nano Banana 2 Lite', // ใช้ 0 credits — extension ตรวจตัวเลข credit ก่อนสั่ง agent ทุกครั้ง
    aspect, // 16:9 แนวนอน | 9:16 แนวตั้ง
    projectTitle: title, // ตั้งชื่อ project ใน Flow เป็นชื่อเรื่อง แทนชื่อวันที่ของ Flow
    attachments: characterAttachments(), // รูปตัวละครของฉัน (ถ้ามี) — แนบเป็น ingredient กับ prompt แรก
    outDir: imagesDir,
    newProject: !savedProject?.url,
    projectUrl: savedProject?.url ?? null,
    agentMode: true,
    askAgentToRename: process.argv.includes('--rename'),
  },
  timeoutMs: 60 * 60_000,
  onProgress: (p) => {
    if (p.stage === 'project') {
      if (p.projectUrl && p.projectUrl !== savedProject?.url) {
        writeFileSync(projectFile, JSON.stringify({ url: p.projectUrl, at: Date.now() }, null, 2))
        console.log(`project ใน Flow: ${p.projectUrl}`)
      }
      return
    }
    if (p.stage === 'retry') {
      const f = p.failed ?? {}
      const why = [f.images && `ภาพ Failed ${f.images} ใบ`, f.agent && `Agent failed ${f.agent} ครั้ง`].filter(Boolean).join(' · ')
      return console.log(`\n  ได้ ${p.done}/${p.total} ใบ${why ? ` (${why})` : ''} — สั่งช็อตที่ขาดซ้ำ`)
    }
    process.stdout.write(`\r  ${{ generate: 'Flow สร้างภาพ', rename: 'Agent ตั้งชื่อภาพ', save: 'บันทึกภาพ' }[p.stage] ?? 'ได้ภาพ'} ${p.done}/${p.total ?? shots.length} ใบ   `)
  },
})

console.log(`\nเซฟแล้ว ${result.files.length} ไฟล์`)
if (result.meta && result.meta.generated !== result.meta.expected) {
  console.warn(`เตือน: Flow gen มา ${result.meta.generated} ใบ แต่สั่งไป ${result.meta.expected} ช็อต`)
}

const { images } = collectImages(imagesDir)
const got = new Set(images.map((i) => i.name))
if (hasCover(slug)) got.add(COVER_NAME)
if (cover) console.log(hasCover(slug) ? 'ได้ภาพปกคลิปแล้ว: 05_images/cover.png' : 'ยังไม่ได้ภาพปกคลิป')
const missing = shots.filter((s) => !got.has(s.filename))
if (missing.length) {
  console.warn(`ยังขาด ${missing.length} ใบ: ${missing.slice(0, 5).map((s) => s.filename).join(', ')}`)
  console.warn('สั่งขั้นนี้ใหม่ หรือ gen เฉพาะช็อตที่ขาดใน Flow แล้วเซฟชื่อให้ตรงเอง')
} else {
  console.log(`ครบทุกช็อต · ขั้นต่อไป: node pipeline/6_render.mjs ${slug}`)
}
