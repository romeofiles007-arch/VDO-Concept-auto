/**
 * ลายเส้นของภาพต่อคลิป — ตัดสินครั้งแรกที่ใช้ (ตามตั้งค่าคลิป · สุ่มถ้าเลือกสุ่ม) แล้วจำไว้ใน projects/<slug>/art_style.json
 * ให้ Shot List กับ Google Flow ของคลิปเดียวกันใช้ลายเส้นเดียวกันเสมอ แม้เปลี่ยนตั้งค่าระหว่างทำ
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadConfig } from './config.mjs'
import { ART_STYLES, isPhotoStyle } from '../../extension/prompts.js'

const STYLES = Object.keys(ART_STYLES).filter((k) => k !== 'random')
// 🎲 สุ่ม = สุ่มเฉพาะลายเส้นภาพวาด — คนที่ตั้งสุ่มไว้ทำช่องการ์ตูน ไม่ควรจู่ๆ ได้คลิปภาพคนจริง
// (เลือกภาพเสมือนจริง/แบบหนังได้ตามปกติ แค่ต้องเลือกเอง)
const RANDOM_POOL = STYLES.filter((k) => !isPhotoStyle(k))

export function artStyleOf(slug, config = loadConfig()) {
  const dir = slug ? join(ROOT, 'projects', slug) : null
  const file = dir && join(dir, 'art_style.json')
  if (file && existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')).style
      if (STYLES.includes(saved)) return saved
    } catch {}
  }
  // ผลิตต่อเนื่องส่ง CLIP_ART_STYLE มาแทนตั้งค่าคลิป (สุ่มต่อคลิปโดยไม่แก้ค่าของผู้ใช้)
  const want = process.env.CLIP_ART_STYLE || config.art?.style
  const style = want === 'random' ? RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)] : STYLES.includes(want) ? want : 'doodle'
  if (dir && existsSync(dir)) writeFileSync(file, JSON.stringify({ style }, null, 2))
  return style
}

/** body/bodyFlow เป็นข้อความเดียว หรือแยก { simple, ref } ตามว่าผู้ใช้แนบรูปตัวละครไว้ไหม */
const variant = (v, hasRef) => (v && typeof v === 'object' ? (hasRef ? v.ref : v.simple) : v)

/** กฎแบบตัวละคร + ลายเส้น สำหรับ Shot List (fallback = กฎเดิมของโปรแกรม) */
export const artBodyRule = (style, fallback, hasRef = false) => variant(ART_STYLES[style]?.body, hasRef) ?? fallback
export const artImageRule = (style) => (ART_STYLES[style]?.rule ? `\n${ART_STYLES[style].rule}` : '')
export const artFlowNote = (style, fallback, hasRef = false) =>
  `${variant(ART_STYLES[style]?.bodyFlow, hasRef) ?? fallback}${ART_STYLES[style]?.flow ? `\n${ART_STYLES[style].flow}` : ''}`

/** ลายเส้นนี้เป็นภาพถ่ายไหม — ใช้ปลดกฎ "ต้องเป็นการ์ตูน/สีสด/ห้ามโทนหม่น" ที่เขียนไว้ให้ภาพวาด */
export const artIsPhoto = (style) => isPhotoStyle(style)
