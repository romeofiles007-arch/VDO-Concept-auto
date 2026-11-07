// เทสต์: ช่องเวลาโพสต์ประจำวันเป็นตาราง (เลือกเวลา · ลบ · ＋ เพิ่มเวลา) แทนการพิมพ์คั่นด้วยจุลภาค
//        และโพสต์อัตโนมัติห่างกันอย่างน้อย 30 นาที (ยกมาจากธรรมะ Auto)
//   node scripts/test-posting-slots.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { suggestSlot } from '../extension/posting.js'
import { lastPostAt } from '../bridge/posting.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
let passed = 0
const test = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

test('＋ เพิ่มเวลา: ยังไม่มีเลย → เที่ยงวัน', () => {
  assert.equal(suggestSlot([]), '12:00')
})

test('＋ เพิ่มเวลา: ต่อจากเวลาสุดท้าย 3 ชั่วโมง', () => {
  assert.equal(suggestSlot(['12:00', '19:00']), '22:00')
  assert.equal(suggestSlot(['09:30']), '12:30')
})

test('＋ เพิ่มเวลา: เลยเที่ยงคืนวนกลับ และไม่ซ้ำเวลาที่มีอยู่', () => {
  assert.equal(suggestSlot(['22:00']), '01:00')
  assert.equal(suggestSlot(['01:00', '22:00']), '04:00') // 22+3 = 01 ซ้ำ → ขยับต่อ
})

test('แผง: ไม่มีช่องพิมพ์คั่นจุลภาคแล้ว · มีตารางเวลา ลบได้ เพิ่มได้ · ห้ามลบช่องสุดท้าย', () => {
  const js = readFileSync(join(ROOT, 'extension', 'posting.js'), 'utf8')
  assert.ok(!js.includes("placeholder: '12:00, 19:00'"), 'ต้องเลิกใช้ช่องพิมพ์คั่นจุลภาค')
  assert.match(js, /type: 'time'/)
  assert.match(js, /＋ เพิ่มเวลา/)
  assert.match(js, /disabled: list\.length <= 1/)
})

test('เว้น 30 นาที: เวลาโพสต์ล่าสุดนับเฉพาะปลายทางที่ขึ้นสำเร็จ', () => {
  assert.equal(lastPostAt([]), 0)
  const queue = [
    { results: { 'fb:1': { ok: true, at: 1000 }, 'yt:1': { ok: false, at: 9000 } } },
    { postedAt: 5000, results: {} },
  ]
  assert.equal(lastPostAt(queue), 5000)
})

test('bridge: postDue เว้น 30 นาทีหลังโพสต์ล่าสุด — นับทีละเพจ (ช่องเวลาต่อเพจ)', () => {
  const js = readFileSync(join(ROOT, 'bridge', 'posting.js'), 'utf8')
  assert.match(js, /MIN_POST_GAP_MS = 30 \* 60_000/)
  assert.match(js, /readyItems\(queue, MIN_POST_GAP_MS\)/)
})

console.log(`\nผ่าน ${passed} ข้อ`)
