#!/usr/bin/env node
// ตรวจว่าเครื่องพร้อมรัน pipeline หรือยัง — node scripts/check-setup.mjs
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const rows = []
const check = (name, fn, hint) => {
  try {
    const detail = fn()
    rows.push({ name, ok: true, detail })
  } catch (err) {
    rows.push({ name, ok: false, detail: hint })
  }
}
const run = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()

check('Node.js', () => {
  const v = Number(process.versions.node.split('.')[0])
  if (v < 20) throw new Error()
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
}, 'ยังไม่ได้สร้าง → รัน scripts/setup-tts.ps1')

check('ANTHROPIC_API_KEY', () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error()
  return 'ตั้งค่าแล้ว'
}, 'ยังไม่ได้ตั้ง → https://console.anthropic.com')

check('GEMINI_API_KEY', () => {
  if (!process.env.GEMINI_API_KEY) throw new Error()
  return 'ตั้งค่าแล้ว'
}, 'ยังไม่ได้ตั้ง → https://aistudio.google.com/apikey')

check('Blueprint', () => {
  if (!existsSync('Cartoon_Storytelling_Blueprint.txt')) throw new Error()
  return 'พบไฟล์'
}, 'ไม่พบ Cartoon_Storytelling_Blueprint.txt ที่ root')

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length))
console.log('\n  สถานะความพร้อม\n  ' + '─'.repeat(56))
for (const r of rows) {
  console.log(`  ${r.ok ? '[ok]  ' : '[--]  '}${pad(r.name, 20)} ${r.detail}`)
}
const missing = rows.filter((r) => !r.ok)
console.log('  ' + '─'.repeat(56))
console.log(missing.length ? `  ยังขาด ${missing.length} อย่าง\n` : '  พร้อมรันทุกขั้นแล้ว\n')
process.exit(missing.length ? 1 : 0)
