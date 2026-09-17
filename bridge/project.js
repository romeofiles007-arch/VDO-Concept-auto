/**
 * สถานะของคลิปหนึ่งคลิป อ่านจากไฟล์ในโฟลเดอร์ล้วน — ไม่มี state ในหน่วยความจำ
 * รันขั้นไหนจาก terminal เอง หน้า UI ก็เห็นตรงกัน
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT, ttsPython } from '../pipeline/lib/config.mjs'
import { loadScript } from '../pipeline/lib/stage2.mjs'
import { collectImages } from '../pipeline/lib/shotfile.mjs'
import { selectedVoice } from '../pipeline/lib/voices.mjs'
import { edgePython } from '../pipeline/lib/cloud_tts.mjs'
import { hasKey } from '../pipeline/lib/env.mjs'

const mtime = (file) => (existsSync(file) ? statSync(file).mtimeMs : 0)
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null)

export const BGM_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg']

export function bgmFile(slug) {
  const dir = join(ROOT, 'projects', slug)
  const ext = BGM_EXT.find((e) => existsSync(join(dir, `bgm.${e}`)))
  return ext ? join(dir, `bgm.${ext}`) : null
}

export function projectStatus(config, title, slug) {
  const base = join(ROOT, 'projects', slug)
  const fileUrl = (rel, t) => `/files/${encodeURIComponent(slug)}/${rel}?v=${Math.round(t)}`

  const script = loadScript(config, title)
  const scriptT = script ? mtime(script.file) : 0

  const voice = join(base, '02_audio', 'voiceover.wav')
  const voiceT = mtime(voice)
  const audio = voiceT ? { url: fileUrl('02_audio/voiceover.wav', voiceT) } : null

  const timecodeJson = readJson(join(base, '03_timecode', 'timecode.json'))
  const slots = readJson(join(base, '04_shotlist', 'slots.json'))
  const timecodeT = mtime(join(base, '04_shotlist', 'slots.json'))
  const timecode =
    timecodeJson && slots
      ? {
          segments: timecodeJson.entries?.length ?? 0,
          seconds: timecodeJson.totalDuration ?? 0,
          shots: slots.length,
          text: existsSync(join(base, '03_timecode', 'timecode.txt'))
            ? readFileSync(join(base, '03_timecode', 'timecode.txt'), 'utf8')
            : '',
        }
      : null

  const shots = readJson(join(base, '04_shotlist', 'shots.json'))
  const shotlistT = mtime(join(base, '04_shotlist', 'agent_brief.txt'))
  const shotlist =
    shots && shotlistT
      ? {
          total: shots.length,
          withPrompt: shots.filter((s) => s.prompt).length,
          shots: shots.map((s) => ({ filename: s.filename, prompt: s.prompt, narration: s.narration })),
        }
      : null

  const imagesDir = join(base, '05_images')
  const found = existsSync(imagesDir) ? collectImages(imagesDir).images : []
  const imagesT = found.reduce((t, i) => Math.max(t, mtime(i.file)), 0)
  const images = found.length
    ? {
        count: found.length,
        expected: shotlist?.withPrompt ?? null,
        list: found.map((i) => ({ name: i.name, url: fileUrl(`05_images/${encodeURIComponent(i.name)}`, mtime(i.file)) })),
      }
    : null

  const video = join(base, '06_render', `${slug}.mp4`)
  const videoT = mtime(video)
  const render = videoT
    ? { url: fileUrl(`06_render/${encodeURIComponent(slug)}.mp4`, videoT), mb: +(statSync(video).size / 1048576).toFixed(1) }
    : null

  const bgm = bgmFile(slug)

  // ผลของขั้นไหนเก่ากว่าขั้นก่อนหน้า = ถูกแก้ต้นทางทีหลัง ต้องทำขั้นนี้ใหม่
  const stale = (t, prevT) => !!(t && prevT && t < prevT)

  return {
    slug,
    script: script && { ...script, stale: false },
    audio: audio && { ...audio, stale: stale(voiceT, scriptT) },
    timecode: timecode && { ...timecode, stale: stale(timecodeT, voiceT) },
    shotlist: shotlist && { ...shotlist, stale: stale(shotlistT, timecodeT) },
    images: images && { ...images, stale: stale(imagesT, shotlistT) },
    render: render && { ...render, stale: stale(videoT, Math.max(imagesT, voiceT)) },
    bgm: bgm ? { name: bgm.split(/[\\/]/).pop() } : null,
  }
}

const NEXT_STEP = [
  ['script', 'เขียนบทพากย์'],
  ['audio', 'ทำเสียงพากย์'],
  ['timecode', 'ทำ Timecode'],
  ['shotlist', 'เขียน Shot List'],
  ['images', 'สร้างภาพ'],
  ['render', 'ตัดต่อวิดีโอ'],
]

/** ไฟล์ที่แก้ล่าสุดในโฟลเดอร์ project (ลึก 2 ชั้นพอ — ทุกขั้นเขียนไฟล์ไว้ในโฟลเดอร์ของขั้นนั้น) */
function lastTouched(dir, depth = 2) {
  let latest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    latest = Math.max(latest, entry.isDirectory() ? (depth > 1 ? lastTouched(full, depth - 1) : 0) : mtime(full))
  }
  return latest
}

/**
 * project ทั้งหมดใน projects/ เรียงจากที่ทำล่าสุด — ไว้ให้เลือกกลับมาทำต่อ
 * ชื่อเรื่องอ่านจาก 01_script/title.txt (หรือ meta.json) โฟลเดอร์ที่ขึ้นต้นด้วย _ เป็นของทดสอบ ข้ามไป
 */
export function listProjects(config) {
  const root = join(ROOT, 'projects')
  if (!existsSync(root)) return []
  const items = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    const dir = join(root, entry.name, '01_script')
    const meta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : {}
    const title = existsSync(join(dir, 'title.txt')) ? readFileSync(join(dir, 'title.txt'), 'utf8').trim() : meta.title
    if (!title) continue
    const status = projectStatus(config, title, entry.name)
    const next = NEXT_STEP.find(([key]) => !status[key])
    const coverFile = join(root, entry.name, '05_images', 'cover.png')
    items.push({
      slug: entry.name,
      title,
      updatedAt: lastTouched(join(root, entry.name)),
      done: Object.fromEntries(NEXT_STEP.map(([key]) => [key, !!status[key]])),
      images: status.images ? { count: status.images.count, expected: status.images.expected } : null,
      next: next ? next[1] : 'เสร็จครบแล้ว',
      cover: existsSync(coverFile) ? `/files/${encodeURIComponent(entry.name)}/05_images/cover.png?v=${Math.round(statSync(coverFile).mtimeMs)}` : null,
    })
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ── ความพร้อมของเครื่อง (ขั้นเสียงพากย์กับตัดต่อ) — เรียก process ภายนอก จึง cache ไว้ ──
let setupCache = null
let setupAt = 0

export function setupStatus(config, { fresh = false } = {}) {
  if (!fresh && setupCache && Date.now() - setupAt < 20_000) return withVoice(setupCache, config)
  const ok = (cmd) => {
    try {
      execSync(cmd, { stdio: 'ignore', windowsHide: true, timeout: 8000 })
      return true
    } catch {
      return false
    }
  }
  setupCache = {
    ffmpeg: ok('ffmpeg -version'),
    python: ok('py -3.11 --version'),
    venv: existsSync(ttsPython(config)),
  }
  setupAt = Date.now()
  return withVoice(setupCache, config)
}

function withVoice(cache, config) {
  const mv = config.tts.myVoice
  // เสียงออนไลน์: ไม่ต้องใช้การ์ดจอ แค่มี edge-tts หรือ Gemini key
  if (['edge', 'gemini'].includes(config.tts.engine)) {
    const ready = config.tts.engine === 'edge' ? existsSync(edgePython()) : hasKey('GEMINI_API_KEY')
    return { ...cache, engine: config.tts.engine, python: true, venv: ready, voice: ready, referenceText: config.tts.engine }
  }
  if (config.tts.engine === 'my-voice' && mv) {
    // เสียงของเรา: ระบบเสียงในเครื่อง (tts/.venv) + เสียงที่เลือกจากคลังเสียง
    const voice = selectedVoice(config)
    const ready = !!voice && existsSync(ttsPython(config))
    return {
      ...cache,
      engine: 'my-voice',
      python: true,
      venv: ready,
      voice: ready,
      referenceText: 'my-voice',
      myVoice: { ready, voice: mv.voice, label: voice?.label ?? null, emotion: mv.emotion, speed: mv.speed },
    }
  }
  return {
    ...cache,
    engine: config.tts.engine,
    voice: existsSync(join(ROOT, config.tts.referenceVoice)),
    referenceText: config.tts.referenceText ?? '',
  }
}
