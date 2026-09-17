#!/usr/bin/env node
/**
 * ขั้นที่ 4 (ต่อ) — ขอ prompt ภาพของช็อตที่ยังขาด ทีละรอบจนครบ ผ่าน ChatGPT (extension)
 *
 * ใช้ตรรกะเดียวกับปุ่ม "ขอช็อตที่ขาดต่อ" ในแผงข้าง (pipeline/lib/shotlist.mjs)
 * แต่สั่งจาก terminal/โปรแกรมในเครื่องผ่านคิวของ bridge
 *
 *   node pipeline/4b_shotlist_fill.mjs <slug> [--rounds 6]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, projectDir } from './lib/config.mjs'
import { requireBridge, runJob } from './lib/bridge.mjs'
import { nextRoundPrompt, saveRound, shotlistFiles } from './lib/shotlist.mjs'

const [slug, ...rest] = process.argv.slice(2)
if (!slug) {
  console.error('ใช้: node pipeline/4b_shotlist_fill.mjs <slug> [--rounds 6]')
  process.exit(1)
}
const roundsArg = rest.indexOf('--rounds')
const maxRounds = roundsArg >= 0 ? Number(rest[roundsArg + 1]) : 6

const config = loadConfig()
if (!existsSync(shotlistFiles(slug).slots)) {
  console.error('ยังไม่มี slots.json — ทำขั้นที่ 3–4 ก่อน')
  process.exit(1)
}
const context = {
  title: readFileSync(join(projectDir(slug, 'script'), 'title.txt'), 'utf8').trim(),
  timecodeText: readFileSync(join(projectDir(slug, 'timecode'), 'timecode.txt'), 'utf8'),
}

await requireBridge()
for (let i = 0; i < maxRounds; i++) {
  const next = nextRoundPrompt(config, slug, context)
  if (!next) {
    console.log('prompt ภาพครบทุกช็อตแล้ว')
    break
  }
  console.log(`รอบ ${next.round}: ขอ ${next.batch} ช็อต (เหลือ ${next.remaining})`)
  const result = await runJob({
    agent: 'chatgpt',
    kind: 'prompt',
    payload: { prompt: next.prompt, newChat: true },
    timeoutMs: 30 * 60_000,
  })
  const merged = saveRound(slug, result.text ?? '')
  console.log(`  ได้ prompt ${merged.withPrompt}/${merged.total} ช็อต`)
}
