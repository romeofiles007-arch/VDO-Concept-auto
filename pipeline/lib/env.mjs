import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './config.mjs'

let loaded = false

/** โหลด .env เข้า process.env — ค่าที่ตั้งไว้ใน shell อยู่แล้วชนะเสมอ */
export function loadEnv() {
  if (loaded) return
  loaded = true
  const file = join(ROOT, '.env')
  if (existsSync(file)) process.loadEnvFile(file) // Node 20.12+ / 24
}

const PROVIDER_KEYS = {
  'claude-api': 'ANTHROPIC_API_KEY',
  'openai-api': 'OPENAI_API_KEY',
  'gemini-api': 'GEMINI_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
}

const WHERE = {
  ANTHROPIC_API_KEY: 'https://console.anthropic.com/settings/keys',
  GEMINI_API_KEY: 'https://aistudio.google.com/apikey',
  OPENAI_API_KEY: 'https://platform.openai.com/api-keys',
  ELEVENLABS_API_KEY: 'https://elevenlabs.io/app/settings/api-keys',
}

export function hasKey(name) {
  loadEnv()
  return Boolean(process.env[name]?.trim())
}

/** ดึง key ของ provider — ถ้าไม่มีให้ตายพร้อมบอกว่าไปเอาที่ไหน */
export function requireKey(provider) {
  loadEnv()
  const name = PROVIDER_KEYS[provider] ?? provider
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(`ยังไม่ได้ตั้ง ${name}\nกรอกลงในไฟล์ .env ที่ root ของโปรเจกต์\nเอา key ได้ที่ ${WHERE[name] ?? '(ดู .env.example)'}`)
    process.exit(1)
  }
  return value
}

export { PROVIDER_KEYS, WHERE }
