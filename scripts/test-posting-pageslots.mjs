// เทสต์เวลาโพสต์ของแต่ละเพจ (ผู้ใช้ 7 พ.ย. 2026: "เลือกตั้งค่าแต่ละ page แตกต่างกันได้ เช่น ช่วงเวลา")
//   เพจตั้งเวลาเองได้ · ไม่ตั้ง = เวลากลาง · เปลี่ยนเวลาแล้วคลิปที่ตั้งตามช่องเดิมย้ายตาม (ไม่ย้ายข้ามเพจ)
//   node scripts/test-posting-pageslots.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmp = mkdtempSync(join(tmpdir(), 'posting-pageslots-'))
process.env.POSTING_DIR = tmp
const P = await import('../pipeline/lib/posting.mjs')
const { createPosting } = await import('../bridge/posting.js')

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}
const day = (h, m = 0, plus = 1) => { const d = new Date(); d.setDate(d.getDate() + plus); d.setHours(h, m, 0, 0); return d.getTime() }
const hour = (t) => new Date(t).getHours()
const accounts = (bSlots) => ({
  settings: { ...P.DEFAULT_SETTINGS, slots: ['12:00', '19:00'], perPageQueueAt: 1 },
  facebook: [{ id: 'a', name: 'ใจใส ใจสบาย วันหยุด', pageId: '111', token: 'ta' }, { id: 'b', name: 'รู้มั้ย เป็นใคร', pageId: '222', token: 'tb', ...(bSlots && { slots: bSlots }) }],
  youtube: [],
  tiktok: [],
})
const clip = (n, extra = {}) => ({ ...P.newItem({ slug: `c${n}`, file: `c${n}.mp4`, title: `คลิป ${n}`, post: { title: `ชื่อ ${n}` }, targets: [] }), ...extra })

await test('เพจที่ตั้งเวลาเองใช้ของตัวเอง · เพจที่ไม่ได้ตั้งใช้เวลากลาง', () => {
  const data = accounts(['09:00', '21:00'])
  assert.deepEqual(P.slotsFor(data, ['fb:b']), ['09:00', '21:00'])
  assert.deepEqual(P.slotsFor(data, ['fb:a']), ['12:00', '19:00'])
  assert.deepEqual(P.slotsFor(data, []), ['12:00', '19:00'], 'ยังไม่มีปลายทาง = เวลากลาง')
  const now = day(8)
  assert.equal(hour(P.nextSlotForItem(data, [], { id: 'x', targets: ['fb:b'] }, now)), 9)
  assert.equal(hour(P.nextSlotForItem(data, [], { id: 'x', targets: ['fb:a'] }, now)), 12)
})

await test('คลิปหลายปลายทางใช้เวลาของปลายทางแรก และต้องว่างพร้อมกันทุกปลายทาง', () => {
  const data = accounts(['09:00', '21:00'])
  const now = day(8)
  const queue = [clip(1, { status: 'scheduled', scheduleAt: day(9), targets: ['fb:b'] })]
  assert.equal(hour(P.nextSlotForItem(data, queue, { id: 'x', targets: ['fb:b'] }, now)), 21, '09:00 ของเพจ B ถูกจองแล้ว')
})

await test('เปลี่ยนเวลาของเพจ → คลิปที่ตั้งตามช่องเดิมย้ายตาม · เวลาที่เลือกเองไม่แตะ · ไม่ย้ายข้ามเพจ', () => {
  const before = accounts(null)
  const after = accounts(['09:00', '21:00'])
  const queue = [
    clip(1, { status: 'scheduled', scheduleAt: day(12), targets: ['fb:b'] }),
    clip(2, { status: 'scheduled', scheduleAt: day(19), targets: ['fb:b'] }),
    clip(3, { status: 'scheduled', scheduleAt: day(12, 15), targets: ['fb:b'] }), // เลือกเอง 12:15
    clip(4, { status: 'scheduled', scheduleAt: day(12), targets: ['fb:a'] }),
  ]
  const { queue: out, rescheduled, retargeted } = P.reorganizeQueue(queue, after, { retarget: false, before, now: day(8, 0, 0) })
  const by = Object.fromEntries(out.map((q) => [q.slug, q]))
  assert.equal(retargeted, 0, 'ไม่ย้ายคลิปข้ามเพจ')
  assert.deepEqual([hour(by.c1.scheduleAt), hour(by.c2.scheduleAt)].sort((x, y) => x - y), [9, 21], 'ย้ายไปช่องใหม่ของเพจ B')
  assert.equal(by.c3.scheduleAt, day(12, 15))
  assert.equal(hour(by.c4.scheduleAt), 12, 'เพจ A ยังใช้เวลากลาง')
  assert.equal(rescheduled, 2)
})

await test('bridge: ตั้งเวลาของเพจ → บันทึกในบัญชี และย้ายคลิปที่ตั้งไว้ให้เอง · ส่งว่าง = กลับไปใช้เวลากลาง', async () => {
  P.saveAccounts(accounts(null))
  P.saveQueue([clip(1, { status: 'scheduled', scheduleAt: day(12), targets: ['fb:b'] })])
  let body, response
  const posting = createPosting({ jobs: new Map(), enqueue: () => ({}), port: 1, token: 'test', log() {}, scheduler: false, readBody: async () => body, json: (_res, code, data) => { response = { code, data } }, deps: { listVideos: async () => [] } })
  const request = async (path, data) => { body = data; await posting.handle({ method: 'POST', headers: { host: '127.0.0.1:1', 'x-bridge-token': 'test' } }, {}, new URL(path, 'http://127.0.0.1:1')); return response }
  let r = await request('/api/posting/account/slots', { kind: 'facebook', id: 'b', slots: ['21:00', '9:00', 'มั่ว'] })
  assert.equal(r.code, 200)
  assert.deepEqual(P.loadAccounts().facebook[1].slots, ['09:00', '21:00'], 'เรียงเวลาและตัดค่าที่ไม่ใช่เวลา')
  assert.deepEqual(r.data.facebook.find((a) => a.id === 'b').slots, ['09:00', '21:00'], 'หน้าเว็บเห็นเวลาของเพจ')
  const [q] = P.loadQueue()
  assert.ok([9, 21].includes(hour(q.scheduleAt)) && q.scheduleAt <= day(12), 'คลิปที่ตั้ง 12:00 ไว้ย้ายไปช่องว่างถัดไปของเวลาใหม่ (09:00 หรือ 21:00)')
  assert.ok(q.history.some((h) => /เปลี่ยนเวลาของเพจ/.test(h.text)))
  r = await request('/api/posting/account/slots', { kind: 'facebook', id: 'b', slots: [] })
  assert.equal(P.loadAccounts().facebook[1].slots, undefined, 'กลับไปใช้เวลากลาง')
  assert.equal((await request('/api/posting/account/slots', { kind: 'facebook', id: 'zzz', slots: ['10:00'] })).code, 404)
})

console.log(`\nผ่าน ${passed} ข้อ`)
rmSync(tmp, { recursive: true, force: true })
process.exit(0)
