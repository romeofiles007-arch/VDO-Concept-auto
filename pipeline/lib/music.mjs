/**
 * ดนตรีประกอบ (BGM) — เพลงอยู่ในโฟลเดอร์ music/ ของโปรแกรม แบบเดียวกับโปรเจกต์ตำนานจีน (ผู้ใช้ 20 พ.ย. 2026)
 *
 *   วางไฟล์เพลงลงโฟลเดอร์ music/ ได้เลย (รวมโฟลเดอร์ย่อย) หรืออัปโหลดจากแผงข้าง → เก็บลงโฟลเดอร์เดียวกัน
 *   config.music = { mode: 'off' | 'one' | 'random', file: '<ชื่อเพลง เช่น calm/ocean.mp3>', volume: 'soft' | 'normal' | 'loud' | 'xloud' }
 *   ใช้ตอนตัดต่อ (6_render) กับทุกคลิป ทั้งคลิปที่สั่งเองและผลิตต่อเนื่อง · เพลงสั้นกว่าคลิปเล่นวนซ้ำ
 *   ไม่ได้ตั้งค่า = สุ่มเพลงจากโฟลเดอร์ music ทีละคลิป (โฟลเดอร์ว่าง = ไม่มีเพลง)
 *
 * music/ เป็นของลูกค้า: ไม่ขึ้น git (.gitignore) และตัวอัปเดตไม่แตะ (package-rules.js isCustomerData)
 * เพลงที่เคยอัปโหลดไว้ใน projects/_music/ (รุ่นก่อน 0.27.8) ย้ายมาเองครั้งแรกที่อ่านรายการเพลง
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { ROOT } from './config.mjs'

export const MUSIC_DIR = join(ROOT, 'music')
const OLD_MUSIC_DIR = join(ROOT, 'projects', '_music')
export const MUSIC_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']
export const MUSIC_MAX_MB = 40
export const MUSIC_MODES = [
  { id: 'off', label: 'ไม่มี' },
  { id: 'one', label: 'เพลงที่เลือก' },
  { id: 'random', label: '🎲 สุ่มทีละคลิป' },
]
export const MUSIC_DEFAULT_MODE = 'random'
/** ความดังของเพลงเทียบเสียงพากย์ (dB) — กลาง = ค่าเดิมของโปรแกรม (-21) · ดังมาก เท่าโปรเจกต์จีน */
export const MUSIC_VOLUMES = {
  soft: { label: 'เบา', db: -27 },
  normal: { label: 'กลาง', db: -21 },
  loud: { label: 'ดัง', db: -15 },
  xloud: { label: 'ดังมาก', db: -12 },
}

const isMusic = (name) => MUSIC_EXT.includes(extname(name).slice(1).toLowerCase())

/** ชื่อเพลง (path ย่อยจาก music/ ใช้ / คั่น) → ไฟล์จริง · กันหลุดออกนอกโฟลเดอร์ music */
export function trackPath(name) {
  const file = resolve(MUSIC_DIR, ...String(name ?? '').split(/[\\/]/).filter(Boolean))
  return file.startsWith(MUSIC_DIR + sep) && isMusic(file) ? file : null
}

/** ย้ายเพลงจาก projects/_music/ (รุ่นเก่า) มา music/ — ชื่อซ้ำกับที่มีอยู่แล้วเก็บไว้ที่เดิม */
function migrateOldDir() {
  if (!existsSync(OLD_MUSIC_DIR)) return
  try {
    const old = readdirSync(OLD_MUSIC_DIR, { withFileTypes: true }).filter((e) => e.isFile() && isMusic(e.name))
    if (old.length) mkdirSync(MUSIC_DIR, { recursive: true })
    for (const e of old) {
      const dest = join(MUSIC_DIR, e.name)
      if (!existsSync(dest)) renameSync(join(OLD_MUSIC_DIR, e.name), dest)
    }
    if (!readdirSync(OLD_MUSIC_DIR).length) rmdirSync(OLD_MUSIC_DIR)
  } catch {}
}

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile() && isMusic(e.name)) out.push(p)
  }
  return out
}

/** เพลงทั้งหมดในโฟลเดอร์ music (รวมโฟลเดอร์ย่อย) เรียงตามชื่อ */
export function listTracks() {
  migrateOldDir()
  if (!existsSync(MUSIC_DIR)) return []
  return walk(MUSIC_DIR)
    .map((file) => {
      const st = statSync(file)
      return { name: relative(MUSIC_DIR, file).split(sep).join('/'), mb: +(st.size / 1048576).toFixed(1), at: st.mtimeMs }
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'th'))
}

/** ชื่อไฟล์ที่ปลอดภัยบนทุกระบบ — ตัดโฟลเดอร์และอักขระต้องห้ามของ Windows · นามสกุลต้องเป็นไฟล์เสียงที่รองรับ */
export function cleanTrackName(name) {
  const raw = basename(String(name ?? '').replace(/\\/g, '/'))
  const ext = extname(raw).slice(1).toLowerCase()
  if (!MUSIC_EXT.includes(ext)) throw new Error(`รองรับเฉพาะไฟล์ ${MUSIC_EXT.join(', ')}`)
  const stem = raw.slice(0, -(ext.length + 1)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/g, '').trim().slice(0, 80) || 'music'
  return `${stem}.${ext}`
}

/** เก็บเพลงใหม่ลง music/ — ชื่อซ้ำได้ชื่อใหม่ "ชื่อ (2).mp3" · คืนชื่อที่เก็บจริง */
export function addTrack(name, buf) {
  const clean = cleanTrackName(name)
  if (!buf?.length) throw new Error('ไฟล์เพลงว่างเปล่า')
  if (buf.length > MUSIC_MAX_MB * 1048576) throw new Error(`ไฟล์เพลงใหญ่เกิน ${MUSIC_MAX_MB} MB`)
  mkdirSync(MUSIC_DIR, { recursive: true })
  const ext = extname(clean)
  const stem = clean.slice(0, -ext.length)
  let final = clean
  for (let n = 2; existsSync(join(MUSIC_DIR, final)); n++) final = `${stem} (${n})${ext}`
  writeFileSync(join(MUSIC_DIR, final), buf)
  return final
}

export function removeTrack(name) {
  const file = trackPath(name)
  if (!file || !existsSync(file)) throw new Error('ไม่พบเพลงนี้')
  unlinkSync(file)
}

/** ค่าที่ตั้งไว้ (ค่าแปลกๆ → ค่าเริ่มต้น) */
export function musicSettings(config) {
  const m = config?.music ?? {}
  return {
    mode: MUSIC_MODES.some((o) => o.id === m.mode) ? m.mode : MUSIC_DEFAULT_MODE,
    file: typeof m.file === 'string' && m.file ? m.file : null,
    volume: MUSIC_VOLUMES[m.volume] ? m.volume : 'normal',
  }
}

/**
 * เพลงของคลิปนี้ตอนตัดต่อ → { file, name, db } หรือ null (ไม่มีดนตรี)
 * เลือกเพลงเดียวแต่ไฟล์หายไปแล้ว → สุ่มแทน (เหมือนโปรเจกต์จีน) ไม่ปล่อยคลิปเงียบ
 * สุ่ม: จำเพลงที่สุ่มได้ไว้ใน projects/<slug>/music.json — ตัดต่อซ้ำได้เพลงเดิม (ถ้ายังตั้งสุ่มและเพลงยังอยู่)
 */
export function pickMusic(slug, config, rand = Math.random) {
  const s = musicSettings(config)
  if (s.mode === 'off') return null
  const db = MUSIC_VOLUMES[s.volume].db
  const at = (name) => ({ file: trackPath(name), name, db })
  if (s.mode === 'one' && s.file && trackPath(s.file) && existsSync(trackPath(s.file))) return at(s.file)
  const tracks = listTracks()
  if (!tracks.length) return null
  if (s.mode === 'one') console.warn(`ไม่พบเพลง "${s.file ?? ''}" ในโฟลเดอร์ music แล้ว — สุ่มเพลงแทน`)
  const memo = slug ? join(ROOT, 'projects', slug, 'music.json') : null
  try {
    const name = memo && JSON.parse(readFileSync(memo, 'utf8')).name
    if (name && tracks.some((t) => t.name === name)) return at(name)
  } catch {}
  const name = tracks[Math.floor(rand() * tracks.length)].name
  if (memo && existsSync(join(memo, '..'))) writeFileSync(memo, JSON.stringify({ name }, null, 2))
  return at(name)
}

/** สิ่งที่แผงข้างใช้แสดง — url ต่อ token เองฝั่งแผง */
export function musicView(config) {
  const s = musicSettings(config)
  const tracks = listTracks().map((t) => ({ ...t, url: `/music/${t.name.split('/').map(encodeURIComponent).join('/')}?v=${Math.round(t.at)}` }))
  return {
    ...s,
    file: s.file && tracks.some((t) => t.name === s.file) ? s.file : null,
    tracks,
    folder: MUSIC_DIR,
    maxMb: MUSIC_MAX_MB,
    options: {
      mode: MUSIC_MODES,
      volume: Object.entries(MUSIC_VOLUMES).map(([id, v]) => ({ id, label: v.label })),
    },
  }
}
