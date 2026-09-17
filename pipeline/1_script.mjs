#!/usr/bin/env node
/**
 * ขั้นที่ 1 — หัวข้อ + VO script ผ่าน ChatGPT (Chrome extension)
 *
 *   node pipeline/1_script.mjs topics            → ขอ 5 หัวข้อ viral
 *   node pipeline/1_script.mjs script 3          → เขียนสคริปต์จากหัวข้อข้อ 3
 *   node pipeline/1_script.mjs script "หัวข้อเอง"  → เขียนสคริปต์จากหัวข้อที่พิมพ์เอง
 *   node pipeline/1_script.mjs script            → ใช้หัวข้อที่เลือกไว้ในหน้า UI
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, ROOT } from './lib/config.mjs'
import { requireBridge, runJob } from './lib/bridge.mjs'
import { topicsPrompt, scriptPrompt, parseTopics } from './lib/prompts.mjs'
import { saveScript } from './lib/stage2.mjs'

const [command, ...rawArgs] = process.argv.slice(2)
const config = loadConfig()
const TOPICS_FILE = join(ROOT, 'projects', 'topics.json')
const SELECTED_FILE = join(ROOT, 'projects', 'selected_topic.json')

// --lang th|en       ภาษาของ narration (ตัวที่จะเอาไปพากย์)
// --title-lang th|en ภาษาของชื่อเรื่อง — แยกกันได้ เช่นชื่ออังกฤษ narration ไทย
const args = []
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i]
  if (a === '--lang') config.script.language = rawArgs[++i]
  else if (a === '--title-lang') config.script.titleLanguage = rawArgs[++i]
  else if (a === '--minutes') config.script.targetMinutes = Number(rawArgs[++i])
  else args.push(a)
}
for (const [field, value] of [
  ['language', config.script.language],
  ['titleLanguage', config.script.titleLanguage],
]) {
  if (!['th', 'en'].includes(value)) {
    console.error(`script.${field} ต้องเป็น th หรือ en (ได้ "${value}")`)
    process.exit(1)
  }
}

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

const LANG_NAME = { th: 'ไทย', en: 'อังกฤษ' }

if (command === 'topics') {
  console.log(`ชื่อหัวข้อ: ${LANG_NAME[config.script.titleLanguage]}`)
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
  let arg = args.join(' ').trim()
  // ไม่ระบุ → ใช้หัวข้อที่คลิกเลือกไว้ในหน้า UI
  if (!arg && existsSync(SELECTED_FILE)) arg = JSON.parse(readFileSync(SELECTED_FILE, 'utf8')).title
  if (!arg) {
    console.error('ต้องระบุเลขหัวข้อหรือชื่อหัวข้อ — หรือเลือกหัวข้อในหน้า UI ก่อน')
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
  console.log(`narration: ${LANG_NAME[config.script.language]} · ${config.script.targetMinutes} นาที`)
  const raw = await ask(scriptPrompt(config, title), 'STAGE 2')
  const { slug, file, minutes, target, offTarget } = saveScript(config, title, raw)
  console.log(`\n${file}`)
  console.log(`ประมาณ ${minutes.toFixed(1)} นาที (เป้า ${target})`)
  if (offTarget) console.warn('เตือน: ห่างจากเป้าเกิน 25% — สั่งใหม่หรือแก้ไฟล์เองก่อนไปขั้นที่ 2')
  console.log(`ขั้นต่อไป: node pipeline/2_tts.mjs ${slug}`)
} else {
  console.error(`ใช้: node pipeline/1_script.mjs topics | script <เลข|ชื่อหัวข้อ>

ตัวเลือก:
  --lang th|en         ภาษาของ narration (ตอนนี้ ${config.script.language})
  --title-lang th|en   ภาษาของชื่อเรื่อง (ตอนนี้ ${config.script.titleLanguage})
  --minutes <n>        ความยาวเป้าหมาย (ตอนนี้ ${config.script.targetMinutes})

ตัวอย่าง:
  node pipeline/1_script.mjs topics --title-lang th
  node pipeline/1_script.mjs script 3 --lang en --minutes 12`)
  process.exit(1)
}
