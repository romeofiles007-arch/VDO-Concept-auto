/**
 * คลังวิดีโอ — วิดีโอที่ประกอบเสร็จแล้วของทุก project (projects/<slug>/06_render/*.mp4)
 *
 * ลบ = ย้ายไป projects/_trash/ (กู้คืนได้ด้วยการย้ายกลับ) ไม่ลบถาวรจากดิสก์
 * เปลี่ยนชื่อเรื่อง = ย้ายโฟลเดอร์ + ไฟล์ที่ตั้งชื่อตาม slug เพราะทั้งระบบหา project จาก slugify(title)
 */
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { ROOT, slugify } from '../pipeline/lib/config.mjs'
import { probeDuration } from '../pipeline/lib/ffmpeg.mjs'
import { collectImages } from '../pipeline/lib/shotfile.mjs'

const PROJECTS = join(ROOT, 'projects')
const TRASH = join(PROJECTS, '_trash')
const durations = new Map() // `${file}|${mtime}` → วินาที (ffprobe ช้า เก็บไว้)

const fileUrl = (slug, rel, t) => `/files/${encodeURIComponent(slug)}/${rel}?v=${Math.round(t)}`

function assertSlug(slug) {
  const s = String(slug ?? '')
  if (!s || s.startsWith('_') || /[\\/]|\.\./.test(s) || !existsSync(join(PROJECTS, s))) throw new Error('ไม่พบ project นี้')
  return s
}

function assertVideoFile(slug, file) {
  const f = String(file ?? '')
  if (!/^[^\\/]+\.mp4$/i.test(f) || !existsSync(join(PROJECTS, slug, '06_render', f))) throw new Error('ไม่พบไฟล์วิดีโอนี้')
  return f
}

function readTitle(slug) {
  const dir = join(PROJECTS, slug, '01_script')
  if (existsSync(join(dir, 'title.txt'))) return readFileSync(join(dir, 'title.txt'), 'utf8').trim()
  const meta = join(dir, 'meta.json')
  return existsSync(meta) ? (JSON.parse(readFileSync(meta, 'utf8')).title ?? slug) : slug
}

async function duration(file, mtime) {
  const key = `${file}|${mtime}`
  if (!durations.has(key)) durations.set(key, await probeDuration(file).catch(() => null))
  return durations.get(key)
}

/** วิดีโอทุกไฟล์ เรียงจากใหม่สุด — ไฟล์ชื่อ <slug>.mp4 คือตัวหลัก ที่เหลือเป็นเวอร์ชันที่เก็บไว้ */
export async function listVideos() {
  if (!existsSync(PROJECTS)) return []
  const out = []
  for (const entry of readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    const slug = entry.name
    const renderDir = join(PROJECTS, slug, '06_render')
    if (!existsSync(renderDir)) continue
    const mp4s = readdirSync(renderDir).filter((f) => /\.mp4$/i.test(f))
    if (!mp4s.length) continue

    const imagesDir = join(PROJECTS, slug, '05_images')
    const images = existsSync(imagesDir) ? collectImages(imagesDir).images : []
    // ภาพปก: cover.png ที่ Flow สร้าง ถ้ายังไม่มีใช้ภาพช็อตแรกๆ ที่ไม่ใช่วินาทีที่ 0 (มักเป็นภาพเปิดเรื่องเรียบๆ)
    const coverFile = join(imagesDir, 'cover.png')
    const cover = existsSync(coverFile) ? fileUrl(slug, '05_images/cover.png', statSync(coverFile).mtimeMs) : null
    const thumb = images[Math.min(2, images.length - 1)]
    const shotsFile = join(PROJECTS, slug, '04_shotlist', 'shots.json')

    const files = []
    for (const name of mp4s) {
      const path = join(renderDir, name)
      const st = statSync(path)
      files.push({
        name,
        main: name === `${slug}.mp4`,
        url: fileUrl(slug, `06_render/${encodeURIComponent(name)}`, st.mtimeMs),
        mb: +(st.size / 1048576).toFixed(1),
        seconds: await duration(path, st.mtimeMs),
        createdAt: st.mtimeMs,
      })
    }
    files.sort((a, b) => Number(b.main) - Number(a.main) || b.createdAt - a.createdAt)

    out.push({
      slug,
      title: readTitle(slug),
      files,
      updatedAt: Math.max(...files.map((f) => f.createdAt)),
      thumb: cover ?? (thumb ? fileUrl(slug, `05_images/${encodeURIComponent(thumb.name)}`, statSync(thumb.file).mtimeMs) : null),
      cover,
      images: images.length,
      shots: existsSync(shotsFile) ? JSON.parse(readFileSync(shotsFile, 'utf8')).length : null,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

/** ลบวิดีโอไฟล์เดียว หรือทั้ง project → ย้ายไปถังขยะ */
export function trashVideo({ slug, file, wholeProject }) {
  const s = assertSlug(slug)
  mkdirSync(TRASH, { recursive: true })
  if (wholeProject) {
    const dest = join(TRASH, `${s}__${stamp()}`)
    renameSync(join(PROJECTS, s), dest)
    return { moved: dest }
  }
  const f = assertVideoFile(s, file)
  const dir = join(TRASH, `${s}__videos`)
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, `${stamp()}__${f}`)
  renameSync(join(PROJECTS, s, '06_render', f), dest)
  return { moved: dest }
}

/** เปลี่ยนชื่อเรื่อง → ชื่อโฟลเดอร์/ไฟล์ตาม slug ใหม่ ข้อมูลภายใน (ภาพ เสียง timecode) ไม่เปลี่ยน */
export function renameProject({ slug, title }) {
  const s = assertSlug(slug)
  const newTitle = String(title ?? '').trim()
  if (!newTitle) throw new Error('ตั้งชื่อเรื่องก่อน')
  const newSlug = slugify(newTitle)
  if (!newSlug) throw new Error('ชื่อเรื่องนี้ใช้ไม่ได้')
  if (newSlug !== s && existsSync(join(PROJECTS, newSlug))) throw new Error('มี project ชื่อนี้อยู่แล้ว')

  const oldDir = join(PROJECTS, s)
  const dir = join(PROJECTS, newSlug)
  if (newSlug !== s) renameSync(oldDir, dir)

  const scriptDir = join(dir, '01_script')
  mkdirSync(scriptDir, { recursive: true })
  writeFileSync(join(scriptDir, 'title.txt'), newTitle, 'utf8')
  const metaFile = join(scriptDir, 'meta.json')
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'))
    writeFileSync(metaFile, JSON.stringify({ ...meta, title: newTitle, slug: newSlug }, null, 2))
  }
  if (newSlug !== s) {
    const oldScript = join(scriptDir, `script_${s}.txt`)
    if (existsSync(oldScript)) renameSync(oldScript, join(scriptDir, `script_${newSlug}.txt`))
    const oldVideo = join(dir, '06_render', `${s}.mp4`)
    if (existsSync(oldVideo)) renameSync(oldVideo, join(dir, '06_render', `${newSlug}.mp4`))
  }
  return { slug: newSlug, title: newTitle }
}

/** เปิด File Explorer ที่ไฟล์วิดีโอ (หรือโฟลเดอร์ project) */
export function revealVideo({ slug, file }) {
  const s = assertSlug(slug)
  const target = file ? join(PROJECTS, s, '06_render', assertVideoFile(s, file)) : join(PROJECTS, s)
  execFile('explorer.exe', file ? [`/select,${target}`] : [target], { windowsHide: false })
  return { opened: target }
}
