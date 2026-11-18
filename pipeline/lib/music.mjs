/**
 * ดนตรีประกอบ — ผู้ใช้อัปโหลดเพลงเก็บไว้ใน projects/_music/ แล้วเลือกในตั้งค่าคลิป (ผู้ใช้ 18 พ.ย. 2026)
 *
 *   config.music = { mode: 'off' | 'one' | 'random', file: '<ชื่อไฟล์>', volume: 'soft' | 'normal' | 'loud' }
 *   ใช้ตอนตัดต่อ (6_render) กับทุกคลิป ทั้งคลิปที่สั่งเองและผลิตต่อเนื่อง · เพลงสั้นกว่าคลิปเล่นวนซ้ำ
 *
 * เก็บใน projects/ = ข้อมูลของลูกค้า ตัวอัปเดตไม่แตะ และไม่ขึ้น git (projects/*\/ อยู่ใน .gitignore)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { ROOT } from './config.mjs'

export const MUSIC_DIR = join(ROOT, 'projects', '_music')
export const MUSIC_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg']
export const MUSIC_MAX_MB = 40
export const MUSIC_MODES = [
  { id: 'off', label: 'ไม่มี' },
  { id: 'one', label: 'เพลงที่เลือก' },
  { id: 'random', label: '🎲 สุ่มทีละคลิป' },
]
/** ความดังของเพลงเทียบเสียงพากย์ (dB) — กลาง = ค่าเดิมของโปรแกรม (-21) */
export const MUSIC_VOLUMES = {
  soft: { label: 'เบา', db: -27 },
  normal: { label: 'กลาง', db: -21 },
  loud: { label: 'ดัง', db: -15 },
}

const isMusic = (name) => MUSIC_EXT.includes(extname(name).slice(1).toLowerCase())

/** เพลงทั้งหมดที่อัปโหลดไว้ เรียงตามชื่อ */
export function listTracks() {
  if (!existsSync(MUSIC_DIR)) return []
  return readdirSync(MUSIC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && isMusic(e.name))
    .map((e) => {
      const st = statSync(join(MUSIC_DIR, e.name))
      return { name: e.name, mb: +(st.size / 1048576).toFixed(1), at: st.mtimeMs }
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

/** เก็บเพลงใหม่ — ชื่อซ้ำได้ชื่อใหม่ "ชื่อ (2).mp3" · คืนชื่อที่เก็บจริง */
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
  const file = join(MUSIC_DIR, basename(String(name ?? '')))
  if (!isMusic(file) || !existsSync(file)) throw new Error('ไม่พบเพลงนี้')
  unlinkSync(file)
}

/** ค่าที่ตั้งไว้ (ค่าแปลกๆ → ค่าเริ่มต้น) */
export function musicSettings(config) {
  const m = config?.music ?? {}
  return {
    mode: MUSIC_MODES.some((o) => o.id === m.mode) ? m.mode : 'off',
    file: typeof m.file === 'string' && m.file ? m.file : null,
    volume: MUSIC_VOLUMES[m.volume] ? m.volume : 'normal',
  }
}

/**
 * เพลงของคลิปนี้ตอนตัดต่อ → { file, name, db } หรือ null (ไม่มีดนตรี)
 * สุ่ม: จำเพลงที่สุ่มได้ไว้ใน projects/<slug>/music.json — ตัดต่อซ้ำได้เพลงเดิม (ถ้ายังตั้งสุ่มและเพลงยังอยู่)
 */
export function pickMusic(slug, config, rand = Math.random) {
  const s = musicSettings(config)
  const db = MUSIC_VOLUMES[s.volume].db
  const at = (name) => ({ file: join(MUSIC_DIR, name), name, db })
  if (s.mode === 'one') return s.file && existsSync(join(MUSIC_DIR, s.file)) ? at(s.file) : null
  if (s.mode !== 'random') return null
  const tracks = listTracks()
  if (!tracks.length) return null
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
  const tracks = listTracks().map((t) => ({ ...t, url: `/files/_music/${encodeURIComponent(t.name)}?v=${Math.round(t.at)}` }))
  return {
    ...s,
    file: s.file && tracks.some((t) => t.name === s.file) ? s.file : null,
    tracks,
    maxMb: MUSIC_MAX_MB,
    options: {
      mode: MUSIC_MODES,
      volume: Object.entries(MUSIC_VOLUMES).map(([id, v]) => ({ id, label: v.label })),
    },
  }
}
