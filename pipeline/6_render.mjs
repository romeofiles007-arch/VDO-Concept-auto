#!/usr/bin/env node
/**
 * ขั้นที่ 6 — ประกอบภาพ + เสียงพากย์ + BGM → MP4
 *
 * ไม่ใช้ AI ตัดต่อ เพราะชื่อไฟล์ภาพคือ timecode อยู่แล้ว จังหวะจึงตรงกับเสียงโดยอัตโนมัติ
 * และผลลัพธ์ deterministic — รันซ้ำได้เหมือนเดิมทุกครั้ง
 *
 *   node pipeline/6_render.mjs <slug> [--bgm path.mp3]
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, projectDir } from './lib/config.mjs'
import { collectImages } from './lib/shotfile.mjs'
import { probeDuration, renderVideo } from './lib/ffmpeg.mjs'
import { hhmmss } from './lib/timecode.mjs'

const [slug, ...rest] = process.argv.slice(2)
if (!slug) {
  console.error('ใช้: node pipeline/6_render.mjs <slug> [--bgm path.mp3]')
  process.exit(1)
}

const config = loadConfig()
const bgmArg = rest.includes('--bgm') ? rest[rest.indexOf('--bgm') + 1] : config.render.bgmFile
const imagesDir = projectDir(slug, 'images')
const voiceover = join(projectDir(slug, 'audio'), 'voiceover.wav')
const outFile = join(projectDir(slug, 'render'), `${slug}.mp4`)

if (!existsSync(voiceover)) {
  console.error(`ไม่พบไฟล์เสียง: ${voiceover}\nรันขั้นที่ 2 (TTS) ก่อน`)
  process.exit(1)
}

const { images, ignored } = collectImages(imagesDir)
if (!images.length) {
  console.error(`ไม่พบภาพที่ตั้งชื่อเป็น timecode ใน ${imagesDir}`)
  if (ignored.length) console.error(`มีภาพที่ชื่อผิดรูป ${ignored.length} ไฟล์ เช่น ${ignored.slice(0, 3).join(', ')}`)
  process.exit(1)
}
if (ignored.length) {
  console.warn(`ข้ามภาพที่ชื่อไม่ใช่ timecode ${ignored.length} ไฟล์: ${ignored.slice(0, 5).join(', ')}`)
}

const totalDuration = await probeDuration(voiceover)

// เตือนช่องโหว่จังหวะก่อน render (กฎ 5: เปลี่ยนภาพทุก 2–3 วิ)
const gaps = images
  .map((img, i) => ({ name: img.name, hold: (images[i + 1]?.start ?? totalDuration) - img.start }))
  .filter((g) => g.hold > config.timecode.maxShotSeconds + 0.5)
if (gaps.length) {
  console.warn(`ภาพค้างนานเกิน ${config.timecode.maxShotSeconds} วิ ${gaps.length} จุด:`)
  for (const g of gaps.slice(0, 5)) console.warn(`  ${g.name} ค้าง ${g.hold.toFixed(1)} วิ`)
}
if (images.at(-1).start > totalDuration) {
  console.warn(`ภาพสุดท้าย (${images.at(-1).name}) เริ่มหลังเสียงจบที่ ${hhmmss(totalDuration)} — จะถูกตัดทิ้ง`)
}

console.log(`ภาพ ${images.length} ใบ · เสียง ${hhmmss(totalDuration)} · กำลัง render...`)
await renderVideo({
  images,
  voiceover,
  bgm: bgmArg && existsSync(bgmArg) ? bgmArg : null,
  outFile,
  totalDuration,
  config: config.render,
})

const mb = (statSync(outFile).size / 1024 / 1024).toFixed(1)
console.log(`เสร็จ: ${outFile} (${mb} MB)`)
