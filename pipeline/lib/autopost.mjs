/**
 * ส่งคลิปที่ทำเสร็จเข้าโฟลเดอร์ "โพสต์อัตโนมัติ" ของ PagePilot
 *
 * โฟลเดอร์นี้ควรอยู่ใน Google Drive for desktop (เช่น G:\My Drive\PagePilot Auto Post)
 * Drive จะอัปโหลดขึ้นคลาวด์เอง แล้ว PagePilot ตรวจโฟลเดอร์ทุก 5 นาที → เข้าคิว → โพสต์ลงเพจตามเวลา
 *
 * แต่ละคลิปได้โฟลเดอร์ย่อยของตัวเอง: <dir>/<slug>/{post.json, title.txt, script_*.txt, <slug>.mp4}
 * คัดลอกไฟล์ข้อความก่อน MP4 — PagePilot จะเห็น post.json พร้อมคลิปเสมอ
 * ตั้งค่าที่ config.autoPost.dir (หรือตัวแปร AUTO_POST_DIR) · เว้นว่าง = ไม่ส่ง
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { projectDir } from './config.mjs'

export function autoPostDir(config) {
  return String(config.autoPost?.dir || process.env.AUTO_POST_DIR || '').trim()
}

/** คืนโฟลเดอร์ปลายทางที่ส่งไป · null = ยังไม่ได้ตั้งโฟลเดอร์ */
export function exportForAutoPost(slug, config) {
  const dir = autoPostDir(config)
  if (!dir) return null
  if (!existsSync(dir)) throw new Error(`ไม่พบโฟลเดอร์ ${dir} — เปิด Google Drive for desktop หรือแก้ autoPost.dir ใน config`)
  const video = join(projectDir(slug, 'render'), `${slug}.mp4`)
  if (!existsSync(video)) throw new Error('ยังไม่มีไฟล์ MP4 ของคลิปนี้ — ตัดต่อให้เสร็จก่อน')
  const target = join(dir, slug)
  const targetVideo = join(target, `${slug}.mp4`)
  // ส่งไปแล้ว (ขนาดเท่ากัน) → ไม่คัดลอกซ้ำ เพราะ Drive จะนับเป็นไฟล์แก้ไขใหม่
  if (existsSync(targetVideo) && statSync(targetVideo).size === statSync(video).size) return target
  mkdirSync(target, { recursive: true })
  const scriptDir = join(projectDir(slug), '01_script')
  for (const name of existsSync(scriptDir) ? readdirSync(scriptDir) : []) {
    if (name === 'post.json' || name === 'title.txt' || (/^script_.*\.txt$/.test(name) && !name.includes('_offtarget_'))) copyFileSync(join(scriptDir, name), join(target, name))
  }
  copyFileSync(video, targetVideo)
  return target
}
