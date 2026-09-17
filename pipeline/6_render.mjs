#!/usr/bin/env node
/**
 * ขั้นที่ 6 — ประกอบภาพ + เสียงพากย์ + BGM → MP4
 *
 *   --motion off|gentle|lively = ภาพนิ่ง / ซูม-เลื่อนกล้องช้าๆ ทุกช็อต (ค่าเริ่มต้นจาก config.render.motion)
 *
 * ไม่ใช้ AI ตัดต่อ เพราะชื่อไฟล์ภาพคือ timecode อยู่แล้ว จังหวะจึงตรงกับเสียงโดยอัตโนมัติ
 * และผลลัพธ์ deterministic — รันซ้ำได้เหมือนเดิมทุกครั้ง
 *
 *   node pipeline/6_render.mjs <slug> [--bgm path.mp3] [--subs off|black|white|yellow]
 */
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, projectDir } from './lib/config.mjs'
import { collectImages } from './lib/shotfile.mjs'
import { probeDuration, probeSize, renderVideo, MOTION_PRESETS } from './lib/ffmpeg.mjs'
import { hhmmss } from './lib/timecode.mjs'
import { buildAss, SUBTITLE_STYLES } from './lib/subtitles.mjs'

const [slug, ...rest] = process.argv.slice(2)
if (!slug) {
  console.error('ใช้: node pipeline/6_render.mjs <slug> [--bgm path.mp3] [--subs off|black|white|yellow] [--motion off|gentle|lively]')
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

// แนวภาพ: ดูจากภาพจริงของคลิปนี้ (คลิปเก่าแนวนอนยังตัดต่อเป็นแนวนอนแม้ตั้งค่าใหม่เป็นแนวตั้ง)
const { width: iw, height: ih } = await probeSize(images[0].file)
const portrait = ih > iw
const resolution = portrait ? '1080x1920' : '1920x1080'
// สัดส่วนภาพต่างจากจอไม่เกิน 5% → เต็มจอ ตัดขอบนิดเดียว · ต่างมาก → ย่อทั้งภาพ เติมขอบขาว
const fit = Math.abs(iw / ih / (portrait ? 9 / 16 : 16 / 9) - 1) < 0.05 ? 'cover' : 'contain'
const wantPortrait = config.render.orientation === 'portrait'
if (portrait !== wantPortrait) {
  console.warn(`ภาพของคลิปนี้เป็น${portrait ? 'แนวตั้ง' : 'แนวนอน'} — ตัดต่อตามภาพ (ตั้งค่าปัจจุบันคือ${wantPortrait ? 'แนวตั้ง' : 'แนวนอน'} ใช้กับคลิปใหม่)`)
}

// ซับไตเติลพื้นทึบ
const subsArg = rest.includes('--subs') ? rest[rest.indexOf('--subs') + 1] : config.render.subtitles?.style ?? 'off'
const subStyle = SUBTITLE_STYLES[subsArg] ? subsArg : 'off'
let subtitles = null
const tcFile = join(projectDir(slug, 'timecode'), 'timecode.json')
if (subStyle !== 'off') {
  if (!existsSync(tcFile)) {
    console.warn('ไม่พบ timecode.json — ข้ามซับไตเติล')
  } else {
    const [w, h] = resolution.split('x').map(Number)
    const dir = projectDir(slug, 'render')
    writeFileSync(join(dir, 'subtitles.ass'), buildAss(JSON.parse(readFileSync(tcFile, 'utf8')).entries, { width: w, height: h, style: subStyle }), 'utf8')
    subtitles = { dir, name: 'subtitles.ass' }
  }
}

const motionArg = rest.includes('--motion') ? rest[rest.indexOf('--motion') + 1] : config.render.motion ?? 'off'
const motion = MOTION_PRESETS[motionArg] ? motionArg : 'off'

console.log(`ภาพ ${images.length} ใบ · เสียง ${hhmmss(totalDuration)} · ${portrait ? 'แนวตั้ง 9:16' : 'แนวนอน 16:9'} · ซับไตเติล${SUBTITLE_STYLES[subStyle].label} · ${MOTION_PRESETS[motion].label} · กำลัง render...`)
await renderVideo({
  images,
  voiceover,
  bgm: bgmArg && existsSync(bgmArg) ? bgmArg : null,
  outFile,
  totalDuration,
  config: config.render,
  resolution,
  subtitles,
  fit,
  motion,
  onProgress: (done, total) => process.stdout.write(`\rขยับภาพ ${done}/${total} ช็อต${done === total ? ' · กำลังรวมเป็นวิดีโอ...\n' : ''}`),
})
// ค่าที่ใช้ตัดต่อ — ทำคลิปอัตโนมัติใช้ตัดสินว่าต้องตัดต่อใหม่ไหมเมื่อเปลี่ยนตั้งค่า
writeFileSync(join(projectDir(slug, 'render'), 'render.json'), JSON.stringify({ resolution, subtitles: subStyle, motion, renderedAt: Date.now() }, null, 2))

const mb = (statSync(outFile).size / 1024 / 1024).toFixed(1)
console.log(`เสร็จ: ${outFile} (${mb} MB)`)
