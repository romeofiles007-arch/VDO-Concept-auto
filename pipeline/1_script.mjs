#!/usr/bin/env node
/**
 * ขั้นที่ 1 — หัวข้อ + VO script ผ่าน ChatGPT (Chrome extension)
 *
 *   node pipeline/1_script.mjs topics            → ขอ 5 หัวข้อ viral
 *   node pipeline/1_script.mjs script 3          → เขียนสคริปต์จากหัวข้อข้อ 3
 *   node pipeline/1_script.mjs script "หัวข้อเอง"  → เขียนสคริปต์จากหัวข้อที่พิมพ์เอง
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, projectDir, slugify, ROOT } from './lib/config.mjs'
import { requireBridge, runJob } from './lib/bridge.mjs'
import { topicsPrompt, scriptPrompt, cleanScript, parseTopics } from './lib/prompts.mjs'
import { estimateMinutes } from './lib/segment.mjs'

const [command, ...args] = process.argv.slice(2)
const config = loadConfig()
const TOPICS_FILE = join(ROOT, 'projects', 'topics.json')

if (config.script.provider !== 'chatgpt-extension') {
  console.error(`ขั้นนี้รองรับเฉพาะ chatgpt-extension — ตอนนี้ config ตั้งเป็น ${config.script.provider}`)
  process.exit(1)
}

async function ask(prompt, label) {
  await requireBridge()
  console.log(`ส่งงานให้ ChatGPT (${label}) — ดูเบราว์เซอร์ได้เลย`)
  const result = await runJob({
    agent: 'chatgpt',
    kind: 'prompt',
    payload: { prompt, newChat: true, outDir: join(ROOT, 'projects') },
    timeoutMs: 20 * 60_000,
  })
  if (!result.text) throw new Error('ChatGPT ไม่ได้ส่งข้อความกลับมา')
  return result.text
}

if (command === 'topics') {
  const text = await ask(topicsPrompt(config), 'STAGE 1')
  const topics = parseTopics(text)
  if (!topics.length) {
    console.error('อ่านตารางหัวข้อไม่ออก — คำตอบดิบ:\n' + text.slice(0, 800))
    process.exit(1)
  }
  mkdirSync(join(ROOT, 'projects'), { recursive: true })
  writeFileSync(TOPICS_FILE, JSON.stringify(topics, null, 2))
  console.log('')
  for (const t of topics) console.log(`  ${t.n}. ${t.title}`)
  console.log(`\nเลือกแล้วรัน: node pipeline/1_script.mjs script <เลข>`)
} else if (command === 'script') {
  const arg = args.join(' ').trim()
  if (!arg) {
    console.error('ต้องระบุเลขหัวข้อหรือชื่อหัวข้อ')
    process.exit(1)
  }

  let title = arg
  if (/^\d+$/.test(arg)) {
    if (!existsSync(TOPICS_FILE)) {
      console.error('ยังไม่มีรายการหัวข้อ — รัน node pipeline/1_script.mjs topics ก่อน')
      process.exit(1)
    }
    const topics = JSON.parse(readFileSync(TOPICS_FILE, 'utf8'))
    const found = topics.find((t) => t.n === Number(arg))
    if (!found) {
      console.error(`ไม่มีหัวข้อเลข ${arg} (มี 1-${topics.length})`)
      process.exit(1)
    }
    title = found.title
  }

  console.log(`หัวข้อ: ${title}`)
  const raw = await ask(scriptPrompt(config, title), 'STAGE 2')
  const script = cleanScript(raw)

  const slug = slugify(title)
  const file = join(projectDir(slug, 'script'), `script_${slug}.txt`)
  writeFileSync(file, script, 'utf8')
  writeFileSync(join(projectDir(slug, 'script'), 'title.txt'), title, 'utf8')

  const minutes = estimateMinutes(script, config.script.wordsPerMinute)
  console.log(`\n${file}`)
  console.log(`ประมาณ ${minutes.toFixed(1)} นาที (เป้า ${config.script.targetMinutes})`)
  if (Math.abs(minutes - config.script.targetMinutes) > config.script.targetMinutes * 0.25) {
    console.warn('เตือน: ห่างจากเป้าเกิน 25% — สั่งใหม่หรือแก้ไฟล์เองก่อนไปขั้นที่ 2')
  }
  console.log(`ขั้นต่อไป: node pipeline/2_tts.mjs ${slug}`)
} else {
  console.error('ใช้: node pipeline/1_script.mjs topics | script <เลข|ชื่อหัวข้อ>')
  process.exit(1)
}
