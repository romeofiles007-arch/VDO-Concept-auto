// เทสต์ ↻ จัดคิวใหม่ให้เพจใหม่เข้าคิว (ผู้ใช้ 8 พ.ย. 2026: "นำเพจใหม่ไปเข้าคิวด้วย โดยยังคงใช้กฎเดิม ... ให้สลักคลิปนั้นไว้เลย")
//   เพจใหม่ได้คลิปเท่าๆ กัน · รวมคลิปที่ติ๊กเพจเอง · แพลตฟอร์มที่คลิปลงแล้วไม่เลือกให้อีก · คลิปที่ขึ้นบางที่แล้วไม่ย้าย · ป้าย 🔒 บนการ์ด
//   node scripts/test-posting-newpage.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const tmp = mkdtempSync(join(tmpdir(), 'posting-newpage-'))
process.env.POSTING_DIR = tmp
const P = await import('../pipeline/lib/posting.mjs')
const ROOT = fileURLToPath(new URL('..', import.meta.url))

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`) }
const now = new Date(2026, 10, 8, 9, 0).getTime()
const at = (d, h) => new Date(2026, 10, 8 + d, h, 0).getTime()
// เพจเดิม a · เพจใหม่ b (เพิ่งเพิ่ม ยังไม่มีคลิป)
const data = { settings: { ...P.DEFAULT_SETTINGS, slots: ['12:00', '19:00'] }, facebook: [{ id: 'a', name: 'ใจใส', pageId: '111', token: 'ta' }, { id: 'b', name: 'เพจใหม่', pageId: '222', token: 'tb' }], youtube: [] }
const clip = (n, extra = {}) => ({ ...P.newItem({ slug: `c${n}`, file: `c${n}.mp4`, title: `คลิป ${n}`, post: { title: `ชื่อ ${n}` }, targets: [] }), ...extra })
// คลิปทั้งหมดติ๊กเพจ a ไว้เอง (เช่น ผลิตต่อเนื่องกำหนดเพจให้)
const queue = () => [
  clip(1, { status: 'scheduled', scheduleAt: at(0, 12), targets: ['fb:a'], targetsEdited: true }),
  clip(2, { status: 'scheduled', scheduleAt: at(0, 19), targets: ['fb:a'], targetsEdited: true }),
  clip(3, { status: 'scheduled', scheduleAt: at(1, 12), targets: ['fb:a'], targetsEdited: true }),
  clip(4, { status: 'review', targets: ['fb:a'], targetsEdited: true }),
]
const count = (out, k) => out.filter((q) => q.targets.includes(k)).length

test('จัดคิวใหม่ปกติ (ตอนเปิดโปรแกรม) ไม่แตะคลิปที่ติ๊กเพจเอง', () => {
  const { queue: out } = P.reorganizeQueue(queue(), data, { now, posted: {} })
  assert.equal(count(out, 'fb:b'), 0)
})

test('กดปุ่ม (resetEdited): เพจใหม่ได้คลิปเท่าๆ กัน และกลับมาเลือกเพจตามหมวด', () => {
  const { queue: out } = P.reorganizeQueue(queue(), data, { now, posted: {}, resetEdited: true })
  assert.equal(count(out, 'fb:a'), 2)
  assert.equal(count(out, 'fb:b'), 2)
  assert.ok(out.every((q) => q.targets.length === 1), 'แพลตฟอร์มละ 1 เพจ')
  assert.ok(out.every((q) => !q.targetsEdited))
})

test('กฎเดิม: คลิปที่ลง Facebook แล้ว (ที่เพจไหนก็ตาม) ไม่ถูกส่งไปลง Facebook อีก', () => {
  const posted = { 'c2/c2.mp4': { fb: { key: 'fb:old', name: 'เพจเก่า', at: now - 86_400_000 } } }
  const { queue: out } = P.reorganizeQueue(queue(), data, { now, posted, resetEdited: true })
  assert.deepEqual(out.find((q) => q.slug === 'c2').targets, [])
  assert.equal(out.filter((q) => q.slug !== 'c2').length, 3)
})

test('คลิปที่ขึ้นบางปลายทางแล้วไม่ย้ายเพจ แม้กดปุ่ม', () => {
  const q = queue()
  q[0].results = { 'fb:a': { ok: true, at: now - 1000 } }
  const { queue: out } = P.reorganizeQueue(q, data, { now, posted: {}, resetEdited: true })
  assert.deepEqual(out.find((x) => x.slug === 'c1').targets, ['fb:a'])
})

test('แผง: ปุ่มส่ง all · สรุปจำนวนคลิปต่อเพจ · ป้าย 🔒 บนหัวการ์ด', () => {
  const ui = readFileSync(join(ROOT, 'extension', 'posting.js'), 'utf8')
  const bridge = readFileSync(join(ROOT, 'bridge', 'posting.js'), 'utf8')
  assert.match(ui, /call\('\/api\/posting\/reorganize', \{ all: true \}/)
  assert.match(ui, /\.\.\.lockBadges\(q\)/)
  assert.match(ui, /if \(list\.length && targetList\(\)\.length\) wrap\.append\(reorgTools\(\)\)/)
  assert.match(bridge, /reorganize\('กดจัดคิวใหม่', \{ all: body\.all === true \}\)/)
  assert.match(bridge, /resetEdited: all/)
  assert.match(bridge, /return \{ retargeted, rescheduled, pages, locked \}/)
})

console.log(`\nผ่าน ${passed} ข้อ`)
