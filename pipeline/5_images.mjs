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
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, projectDir } from './lib/config.mjs'
import { requireBridge, runJob } from './lib/bridge.mjs'
import { flowPrompt } from './lib/prompts.mjs'
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

const shots = JSON.parse(readFileSync(join(shotDir, 'shots.json'), 'utf8')).filter((s) => s.prompt)
const imagesDir = projectDir(slug, 'images')

const existing = collectImages(imagesDir).images
if (existing.length) {
  console.log(`มีภาพอยู่แล้ว ${existing.length} ใบใน ${imagesDir} — จะถูกเขียนทับถ้าชื่อซ้ำ`)
}

await requireBridge()
console.log(`ส่ง ${shots.length} ช็อตให้ Google Flow — เปิดดูเบราว์เซอร์ได้ ห้ามปิดแท็บระหว่างรอ`)
console.log('งาน batch ขนาดนี้ปกติใช้เวลา 10-40 นาที')

const result = await runJob({
  agent: 'flow',
  kind: 'generate-images',
  payload: {
    prompt: flowPrompt(readFileSync(briefFile, 'utf8')),
    shots: shots.map((s) => ({ filename: s.filename, shot: s.shot })),
    outDir: imagesDir,
    newProject: true,
    agentMode: true,
    askAgentToRename: process.argv.includes('--rename'),
  },
  timeoutMs: 60 * 60_000,
  onProgress: (p) => process.stdout.write(`\r  ได้ภาพ ${p.done}/${p.total ?? shots.length} ใบ`),
})

console.log(`\nเซฟแล้ว ${result.files.length} ไฟล์`)
if (result.meta && result.meta.generated !== result.meta.expected) {
  console.warn(`เตือน: Flow gen มา ${result.meta.generated} ใบ แต่สั่งไป ${result.meta.expected} ช็อต`)
}

const { images } = collectImages(imagesDir)
const missing = shots.filter((s) => !images.some((i) => i.name === s.filename))
if (missing.length) {
  console.warn(`ยังขาด ${missing.length} ใบ: ${missing.slice(0, 5).map((s) => s.filename).join(', ')}`)
  console.warn('สั่งขั้นนี้ใหม่ หรือ gen เฉพาะช็อตที่ขาดใน Flow แล้วเซฟชื่อให้ตรงเอง')
} else {
  console.log(`ครบทุกช็อต · ขั้นต่อไป: node pipeline/6_render.mjs ${slug}`)
}
