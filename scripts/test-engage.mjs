// เทสต์ชวนคุยท้ายคลิป (ผู้ใช้ 8 พ.ย. 2026: "มีแต่คนดู ไม่มีใครตอบอะไรเลย")
//   ค่าเริ่มต้นชวนคุย · ปิดได้ (script.engage = false) · ตัวอย่างคำถามตามภาษาพากย์ · cleanScript ไม่ตัดคำถามท้ายบท
//   node scripts/test-engage.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scriptPrompt, engageRule, cleanScript } from '../extension/prompts.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
let passed = 0
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`) }
const RULE = 'ปิดท้ายบทด้วยประโยคชวนคุย'

test('ค่าเริ่มต้น: บทปิดท้ายด้วยคำถามชวนคุย · ปิดได้', () => {
  assert.ok(scriptPrompt('BP', 'เรื่อง', { language: 'th', targetMinutes: 1 }).includes(RULE))
  assert.ok(scriptPrompt('BP', 'เรื่อง', { language: 'th', targetMinutes: 1, engage: undefined }).includes(RULE), 'config เก่าไม่มีค่านี้ = ชวนคุย')
  assert.ok(!scriptPrompt('BP', 'เรื่อง', { language: 'th', targetMinutes: 1, engage: false }).includes(RULE))
})

test('ตัวอย่างคำถามตามภาษาพากย์ · ห้ามขอไลก์/ติดตาม', () => {
  assert.match(engageRule('th'), /ถ้าเป็นคุณ จะทำอย่างไร\?/)
  assert.match(engageRule('th'), /ใครเคยเจอเหตุการณ์แบบนี้บ้าง/)
  assert.match(engageRule('en'), /What would you do\?/)
  assert.match(engageRule('zh'), /如果是你/)
  assert.match(engageRule('th'), /ห้ามขอไลก์/)
})

test('cleanScript ไม่ตัดคำถามชวนคุยท้ายบท', () => {
  const out = cleanScript('เรื่องเล่า...\n\nถ้าเป็นคุณ จะทำอย่างไร?\nใครเคยเจอเหตุการณ์แบบนี้บ้าง? เล่าให้ฟังในคอมเมนต์หน่อย')
  assert.ok(out.includes('ถ้าเป็นคุณ จะทำอย่างไร?') && out.includes('คอมเมนต์หน่อย'))
})

test('กล่องตั้งค่าคลิปมีสวิตช์ชวนคุย · bridge บันทึก script.engage · เขียนบทเองจากแผงข้างส่งค่านี้ไปด้วย', () => {
  const html = readFileSync(join(ROOT, 'extension', 'sidepanel.html'), 'utf8')
  const js = readFileSync(join(ROOT, 'extension', 'sidepanel.js'), 'utf8')
  const ui = readFileSync(join(ROOT, 'bridge', 'ui.js'), 'utf8')
  assert.match(html, /id="clipEngage"/)
  // อยู่ในช่องนักเขียนบท (หัวข้อและบท) ไม่ใช่กล่อง Google Flow — ผู้ใช้หาไม่เจอเมื่ออยู่ที่ Flow
  const at = html.indexOf('id="autoTopicBlock"'), en = html.indexOf('id="clipEngage"'), vo = html.indexOf('id="voiceSettingsBox"')
  assert.ok(at > 0 && at < en && en < vo, 'สวิตช์ชวนคุยต้องอยู่ในช่องนักเขียนบท')
  assert.match(js, /saveClipSettings\(\{ engage: b\.dataset\.value \}\)/)
  assert.match(js, /engage: clip\?\.engage !== 'off'/)
  assert.match(ui, /c\.script\.engage = body\.engage === 'on'/)
  assert.match(ui, /engage: c\.script\.engage === false \? 'off' : 'on'/)
})

console.log(`\nผ่าน ${passed} ข้อ`)
