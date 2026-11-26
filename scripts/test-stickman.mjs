// ลายเส้น Stickman (ผู้ใช้ 26 พ.ย. 2026: "เพิ่มโหมด stickman เอาให้เหมือนนะ" → ตัวก้างมีสีหน้า + ฉากสี)
//   node --test scripts/test-stickman.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { ART_STYLES } from '../extension/prompts.js'
import { artBodyRule, artImageRule, artFlowNote, artPastNote, artStyleOf } from '../pipeline/lib/art_style.mjs'
import { loadConfig } from '../pipeline/lib/config.mjs'
import { flowPrompt, shotlistPrompt } from '../pipeline/lib/prompts.mjs'

const withStyle = (style) => {
  const c = loadConfig()
  return { ...c, art: { ...(c.art ?? {}), style } }
}

test('มีตัวเลือก Stickman ในตั้งค่าคลิป (แผงข้างสร้างปุ่มจาก ART_STYLES เอง)', () => {
  assert.equal(ART_STYLES.stickman?.label, 'Stickman ตัวก้าง')
  assert.equal(artStyleOf(null, withStyle('stickman')), 'stickman')
})

test('กฎ ChatGPT: ตัวก้างจริง + ประกาศชัดว่ามีผลเหนือ "NEVER stick figures" ของ Blueprint + สีหน้า + ฉากลงสี', () => {
  const rule = artImageRule('stickman')
  assert.match(rule, /NEVER stick figures/)
  assert.match(rule, /มีผลเหนือ/)
  assert.match(rule, /single bold black lines/)
  assert.match(rule, /expressive face/)
  assert.match(rule, /ลงสีแบนสดใสเต็มภาพ/)
  // แทน SIMPLE MODE (doodle แขนขาเป็นหลอด) — ไม่มีข้อ "ห้ามตัวก้าง" หลุดมา
  const body = artBodyRule('stickman', 'FALLBACK-ห้ามวาดเป็นตัวก้าง', false)
  assert.match(body, /STICKMAN/)
  assert.doesNotMatch(body, /FALLBACK/)
  assert.match(artBodyRule('stickman', 'x', true), /คนในรูปที่แนบ/, 'แนบรูปตัวละคร → ตัวก้างเวอร์ชันของคนในรูป')
})

test('คำสั่ง Shot List จริง: กฎ stickman อยู่หลัง Blueprint (คำสั่งท้ายชนะ) และไม่มีกฎ SIMPLE MODE "ห้ามตัวก้าง" ของระบบ', () => {
  const p = shotlistPrompt(withStyle('stickman'), { title: 'ทดสอบ', slots: [{ filename: '00_00_00.png', shot: 1, duration: 3, narration: 'สวัสดี' }], timecodeText: '00:00 สวัสดี', slug: null })
  const blueprintBan = p.indexOf('NEVER stick figures: no single-line arms')
  const ours = p.indexOf('ลายเส้นของคลิปนี้: STICKMAN')
  assert.ok(blueprintBan >= 0 && ours > blueprintBan)
  assert.doesNotMatch(p, /SIMPLE MODE \(ไม่มีรูปตัวละครแนบ\)/)
})

test('คำสั่ง Flow: ตัวก้าง + ข้อยกเว้นกฎ "ลงสีเต็มทั้งตัวละคร" (ตัวเป็นเส้นดำโดยตั้งใจ) · ไม่มีข้อห้ามตัวก้างของ doodle', () => {
  const p = flowPrompt('00_00_00.png | SHOT 01 | test', withStyle('stickman'), null)
  assert.match(p, /ตัวก้าง \(stick figure\)/)
  assert.match(p, /ยกเว้นตัวละครตัวก้าง/)
  assert.doesNotMatch(p, /ห้ามวาดเป็นตัวก้าง/)
  assert.equal(artPastNote('stickman'), ART_STYLES.stickman.color)
  assert.match(artFlowNote('stickman', 'x', false), /^ตัวละครทุกตัวเป็นตัวก้าง/)
})

test('ลายเส้นเดิมไม่เปลี่ยน: doodle ยังห้ามตัวก้าง · สีน้ำไม่มีข้อยกเว้นสี', () => {
  const p = flowPrompt('00_00_00.png | SHOT 01 | test', withStyle('doodle'), null)
  assert.match(p, /ห้ามวาดเป็นตัวก้าง/)
  assert.doesNotMatch(p, /ยกเว้นตัวละครตัวก้าง/)
  assert.equal(artPastNote('watercolor'), '')
})

test('🎲 สุ่ม ไม่สุ่มได้ Stickman (โหมดเฉพาะ ต้องเลือกเอง)', () => {
  const seen = new Set()
  const orig = Math.random
  try {
    for (let i = 0; i < 40; i++) {
      Math.random = () => i / 40
      seen.add(artStyleOf(null, withStyle('random')))
    }
  } finally {
    Math.random = orig
  }
  assert.ok(!seen.has('stickman'))
  assert.ok(seen.has('doodle'))
})
