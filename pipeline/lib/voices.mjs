/**
 * คลังเสียงของเรา — แต่ละเสียงคือโฟลเดอร์ใน tts/voices/<id>/ ที่มี voice.json
 *
 *   status: draft (อัปโหลดไฟล์แล้ว ยังไม่เทรน) | training | ready | failed
 *   ckpt, vocab: model.pt / vocab.txt ในโฟลเดอร์เสียง (path เต็มแบบเก่าก็ยังใช้ได้)
 *   references: selections.json ของคลิปต้นแบบ อ้างอิงจากโฟลเดอร์เสียง
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { ROOT } from './config.mjs'

export const VOICES_DIR = join(ROOT, 'tts', 'voices')
export const AUDIO_EXT = ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'aac', 'opus']

/** id ใช้เป็นชื่อโฟลเดอร์และชื่อ dataset ของ F5-TTS — จำกัดเป็นอักษรอังกฤษ ตัวเลข _ - */
export function voiceId(label) {
  const id = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return id || `voice_${Date.now().toString(36)}`
}

export function voiceDir(id) {
  if (!/^[a-z0-9_-]+$/i.test(String(id))) throw new Error('ชื่อเสียงไม่ถูกต้อง')
  return join(VOICES_DIR, id)
}

export function readVoice(id) {
  const file = join(voiceDir(id), 'voice.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

export function writeVoice(id, changes) {
  const dir = voiceDir(id)
  mkdirSync(dir, { recursive: true })
  const data = { ...(readVoice(id) ?? {}), ...changes }
  writeFileSync(join(dir, 'voice.json'), JSON.stringify(data, null, 2) + '\n')
  return data
}

export function rawFiles(id) {
  const dir = join(voiceDir(id), 'raw')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => AUDIO_EXT.includes(f.split('.').pop().toLowerCase()))
    .map((name) => ({ name, mb: +(statSync(join(dir, name)).size / 1048576).toFixed(1) }))
}

/** path ใน voice.json อ้างอิงจากโฟลเดอร์เสียง (ย้ายโปรเจกต์ไปเครื่องอื่นได้) — path เต็มแบบเก่าก็ยังใช้ได้ */
const voiceFile = (id, p) => (p ? (isAbsolute(p) ? p : join(voiceDir(id), p)) : '')

/** เสียงพร้อมใช้ = มีโมเดลและคลิปต้นแบบครบจริงบนดิสก์ */
export function voiceReady(id, voice = readVoice(id)) {
  if (!voice || voice.status !== 'ready') return false
  return [voice.ckpt, voice.vocab, voice.references].every((p) => p && existsSync(voiceFile(id, p)))
}

export function listVoices() {
  if (!existsSync(VOICES_DIR)) return []
  return readdirSync(VOICES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(VOICES_DIR, d.name, 'voice.json')))
    .map((d) => {
      const v = readVoice(d.name)
      return {
        id: d.name,
        label: v.label ?? d.name,
        status: v.status ?? 'draft',
        ready: voiceReady(d.name, v),
        error: v.error ?? null,
        trainedAt: v.trainedAt ?? null,
        epochs: v.epochs ?? null,
        raw: rawFiles(d.name),
      }
    })
    .sort((a, b) => Number(b.ready) - Number(a.ready) || a.label.localeCompare(b.label))
}

/** เสียงที่ config เลือกไว้ พร้อม path เต็มสำหรับ worker */
export function selectedVoice(config) {
  const id = config.tts.myVoice?.voice
  if (!id) return null
  const voice = readVoice(id)
  if (!voiceReady(id, voice)) return null
  return { id, ...voice, ckpt: voiceFile(id, voice.ckpt), vocab: voiceFile(id, voice.vocab), references: voiceFile(id, voice.references) }
}
