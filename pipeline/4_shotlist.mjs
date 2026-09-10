#!/usr/bin/env node
/**
 * ขั้นที่ 4 — OUTPUT 5 (Style Bible + Character Bible + Shot List)
 *
 * เราคำนวณ "ช่อง" shot มาแล้วในขั้นที่ 3 (ชื่อไฟล์ + จังหวะ 2-3 วิ)
 * ขั้นนี้แค่ให้ AI เติมเนื้อหาภาพลงในช่อง — จำนวนและชื่อไฟล์ห้ามเปลี่ยน
 *
 *   node pipeline/4_shotlist.mjs <slug>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, projectDir, ROOT } from './lib/config.mjs'
import { requireBridge, runJob } from './lib/bridge.mjs'
import { shotlistPrompt, parseShotList } from './lib/prompts.mjs'

const slug = process.argv[2]
if (!slug) {
  console.error('ใช้: node pipeline/4_shotlist.mjs <slug>')
  process.exit(1)
}

const config = loadConfig()
const shotDir = projectDir(slug, 'shotlist')
const slotsFile = join(shotDir, 'slots.json')
if (!existsSync(slotsFile)) {
  console.error('ไม่พบ slots.json — รันขั้นที่ 3 ก่อน')
  process.exit(1)
}

const slots = JSON.parse(readFileSync(slotsFile, 'utf8'))
const timecodeText = readFileSync(join(projectDir(slug, 'timecode'), 'timecode.txt'), 'utf8')
const titleFile = join(projectDir(slug, 'script'), 'title.txt')
const title = existsSync(titleFile) ? readFileSync(titleFile, 'utf8').trim() : slug

await requireBridge()
console.log(`ส่ง ${slots.length} ช็อตให้ ChatGPT เติม prompt ภาพ`)

const result = await runJob({
  agent: 'chatgpt',
  kind: 'prompt',
  payload: {
    prompt: shotlistPrompt(config, { title, slots, timecodeText }),
    newChat: true,
    outDir: shotDir,
  },
  timeoutMs: 25 * 60_000,
})

const raw = result.text
writeFileSync(join(shotDir, 'output5_raw.txt'), raw, 'utf8')

const { shots, missing } = parseShotList(raw, slots)
if (missing.length) {
  console.warn(`ขาด prompt ${missing.length} ช็อต: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`)
  console.warn('ดูคำตอบดิบที่ output5_raw.txt แล้วเติมเองใน shots.json หรือสั่งขั้นนี้ใหม่')
}

// AGENT BRIEF = ทุกอย่างก่อน "=== SHOT LIST ===" (Style + Character + Rules)
// ต่อด้วย shot list ที่จับคู่ชื่อไฟล์แล้ว เพื่อกันกรณี AI พิมพ์ชื่อไฟล์ตกหล่น
const briefHead = raw.split(/^=== SHOT LIST ===$/m)[0].trim()
const agentBrief = `${briefHead}\n\n=== SHOT LIST ===\n\n${shots
  .filter((s) => s.prompt)
  .map((s) => `${s.filename} ${s.prompt}`)
  .join('\n\n')}`

writeFileSync(join(shotDir, 'agent_brief.txt'), agentBrief, 'utf8')
writeFileSync(join(shotDir, 'shots.json'), JSON.stringify(shots, null, 2))

console.log(`\nagent_brief.txt · ${shots.filter((s) => s.prompt).length}/${slots.length} ช็อตมี prompt`)
console.log(`ขั้นต่อไป: node pipeline/5_images.mjs ${slug}`)
