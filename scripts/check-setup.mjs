#!/usr/bin/env node
// ตรวจว่าเครื่องพร้อมรัน pipeline หรือยัง — node scripts/check-setup.mjs
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadConfig } from '../pipeline/lib/config.mjs'
import { loadEnv, hasKey, WHERE } from '../pipeline/lib/env.mjs'

loadEnv()
const config = loadConfig()

const rows = []
const check = (name, fn, hint, { optional = false } = {}) => {
  try {
    rows.push({ name, ok: true, detail: fn(), optional })
  } catch {
    rows.push({ name, ok: false, detail: hint, optional })
  }
}
const run = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()

check('Node.js', () => {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error()
  return process.version
}, 'ต้อง Node 20+')

check('ffmpeg', () => run('ffmpeg -version').split('\n')[0].slice(0, 40), 'ลง ffmpeg แล้วใส่ใน PATH')

check('GPU (CUDA)', () => run('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader'),
  'ไม่พบ NVIDIA GPU — TTS local จะช้ามาก')

check('Python 3.11', () => {
  const v = run('py -3.11 --version')
  if (!v.includes('3.11')) throw new Error()
  return v
}, 'ยังไม่ได้ลง → https://www.python.org/downloads/release/python-3119/')

check('TTS venv', () => {
  if (!existsSync('tts/.venv')) throw new Error()
  return 'tts/.venv'
}, 'ยังไม่ได้สร้าง → powershell -ExecutionPolicy Bypass -File scripts\\setup-tts.ps1')

check('เสียงต้นแบบ', () => {
  if (!existsSync(config.tts.referenceVoice)) throw new Error()
  return config.tts.referenceVoice
}, `วางไฟล์ wav 10-15 วิ ที่ ${config.tts.referenceVoice}`)

check('.env', () => {
  if (!existsSync('.env')) throw new Error()
  return 'พบไฟล์'
}, 'คัดลอกจาก .env.example → copy .env.example .env')

// key ที่จำเป็นจริงขึ้นกับ provider ที่เลือกใน config — ที่เหลือแค่แนะนำ
const needed = new Set([
  config.script.provider === 'claude-api' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY', // ขั้นที่ 4 (shot list) ใช้ Claude เสมอ
  config.images.provider === 'gemini-api' ? 'GEMINI_API_KEY' : null,
  config.tts.engine === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : null,
].filter(Boolean))

for (const key of Object.keys(WHERE)) {
  check(key, () => {
    if (!hasKey(key)) throw new Error()
    return `ตั้งค่าแล้ว (${process.env[key].slice(0, 8)}...)`
  }, needed.has(key) ? `จำเป็น → ${WHERE[key]}` : `ไม่บังคับ → ${WHERE[key]}`, { optional: !needed.has(key) })
}

check('Blueprint', () => {
  if (!existsSync(config.blueprint)) throw new Error()
  return config.blueprint
}, `ไม่พบ ${config.blueprint} ที่ root`)

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length))
console.log('\n  สถานะความพร้อม\n  ' + '─'.repeat(64))
for (const r of rows) {
  const mark = r.ok ? '[ok]  ' : r.optional ? '[  ]  ' : '[--]  '
  console.log(`  ${mark}${pad(r.name, 20)} ${r.detail}`)
}
const missing = rows.filter((r) => !r.ok && !r.optional)
const optional = rows.filter((r) => !r.ok && r.optional)
console.log('  ' + '─'.repeat(64))
console.log(missing.length ? `  ยังขาดของจำเป็น ${missing.length} อย่าง${optional.length ? ` (ไม่บังคับอีก ${optional.length})` : ''}\n` : '  พร้อมรันทุกขั้นแล้ว\n')
process.exit(missing.length ? 1 : 0)
