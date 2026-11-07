// เทสต์ช่องเวลาต่อเพจ (ผู้ใช้ 7 พ.ย. 2026: "โพสต์พร้อมกันได้แต่คนละคลิป และไปจัดคิวให้ใหม่เลย")
//   ช่องเวลาเดียวกัน ทุกเพจลงคลิปของตัวเองได้ · คลิปที่เข้าคิวพร้อมกันกระจายไปคนละเพจ · เว้น 30 นาทีทีละเพจ · จัดคิวเดิมใหม่
//   node scripts/test-posting-perpage.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmp = mkdtempSync(join(tmpdir(), 'posting-perpage-'))
process.env.POSTING_DIR = tmp
const P = await import('../pipeline/lib/posting.mjs')
const { createPosting } = await import('../bridge/posting.js')
const { ROOT } = await import('../pipeline/lib/config.mjs')

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}
const data = { settings: { ...P.DEFAULT_SETTINGS, slots: ['12:00', '19:00'] }, facebook: [{ id: 'a', name: 'ใจใส', pageId: '111', token: 'ta' }, { id: 'b', name: 'รู้มั้ย', pageId: '222', token: 'tb' }], youtube: [] }
const now = new Date(2026, 10, 8, 9, 0).getTime()
const noon = new Date(2026, 10, 8, 12, 0).getTime()
const seven = new Date(2026, 10, 8, 19, 0).getTime()
const clip = (n, extra = {}) => ({ ...P.newItem({ slug: `c${n}`, file: `c${n}.mp4`, title: `คลิป ${n}`, post: { title: `ชื่อ ${n}` }, targets: [] }), ...extra })

await test('ช่องเวลาเดียวกัน: เพจ A จองแล้ว เพจ B ยังใช้ 12:00 ได้ · เพจ A ไป 19:00', () => {
  const queue = [clip(1, { status: 'scheduled', scheduleAt: noon, targets: ['fb:a'] })]
  assert.equal(P.nextSlotFor(data.settings.slots, queue, { id: 'x', targets: ['fb:b'] }, now), noon)
  assert.equal(P.nextSlotFor(data.settings.slots, queue, { id: 'x', targets: ['fb:a'] }, now), seven)
})

await test('คลิปที่เข้าคิวพร้อมกันกระจายไปคนละเพจทันที (นับคลิปที่รอในคิวด้วย)', () => {
  rmSync(join(tmp, 'posted.json'), { force: true })
  const queue = [clip(1, { status: 'review', targets: ['fb:a'] })]
  assert.deepEqual(P.targetsFor(data, null, { clip: 'c2/c2.mp4', queue }), ['fb:b'])
  assert.deepEqual(P.targetsFor(data, null, { clip: 'c1/c1.mp4', queue }), ['fb:a'], 'คลิปเดิมไม่นับตัวเอง')
})

await test('เว้น 30 นาทีทีละเพจ: เพจ A เพิ่งโพสต์ → คลิปของเพจ B ยังออกได้', () => {
  const t = Date.now()
  const queue = [
    clip(1, { status: 'posted', targets: ['fb:a'], results: { 'fb:a': { ok: true, at: t - 60_000 } } }),
    clip(2, { status: 'scheduled', scheduleAt: t - 1000, targets: ['fb:a'] }),
    clip(3, { status: 'scheduled', scheduleAt: t - 1000, targets: ['fb:b'] }),
  ]
  assert.deepEqual(P.readyItems(queue, 30 * 60_000, t).map((q) => q.slug), ['c3'])
})

await test('จัดคิวใหม่: คลิปที่ตั้งไว้เพจเดียวกันทั้งหมด → กระจายสองเพจ และลง 12:00 พร้อมกันคนละคลิป', () => {
  rmSync(join(tmp, 'posted.json'), { force: true })
  const queue = [
    clip(1, { status: 'scheduled', scheduleAt: noon, targets: ['fb:a'] }),
    clip(2, { status: 'scheduled', scheduleAt: seven, targets: ['fb:a'] }),
    clip(3, { status: 'scheduled', scheduleAt: seven + 86_400_000 - 7 * 3600_000, targets: ['fb:a'] }), // พรุ่งนี้ 12:00
    clip(4, { status: 'review', targets: ['fb:a'] }),
  ]
  const { queue: out, retargeted, rescheduled } = P.reorganizeQueue(queue, data, { now })
  const by = Object.fromEntries(out.map((q) => [q.slug, q]))
  assert.deepEqual([by.c1.targets, by.c2.targets, by.c3.targets], [['fb:a'], ['fb:b'], ['fb:a']])
  assert.equal(by.c1.scheduleAt, noon)
  assert.equal(by.c2.scheduleAt, noon, 'คลิป 2 ย้ายไปเพจ B และขึ้น 12:00 พร้อมคลิป 1')
  assert.equal(by.c3.scheduleAt, seven, 'คลิป 3 ของเพจ A ขยับมา 19:00 วันนี้')
  assert.deepEqual(by.c4.targets, ['fb:b'], 'คลิปรอตรวจก็กระจายเพจด้วย')
  assert.equal(retargeted, 2)
  assert.equal(rescheduled, 2)
})

await test('จัดคิวใหม่ไม่แตะคลิปที่ติ๊กเพจเอง และเวลาที่เลือกเอง (ไม่ตรงช่องประจำวัน) · แต่นับว่าเพจนั้นมีคลิปแล้ว', () => {
  rmSync(join(tmp, 'posted.json'), { force: true })
  const queue = [
    clip(5, { status: 'scheduled', scheduleAt: noon + 15 * 60_000, targets: ['fb:b'], targetsEdited: true }), // 12:15 เลือกเอง
    clip(6, { status: 'scheduled', scheduleAt: seven, targets: ['fb:b'] }),
  ]
  const { queue: out } = P.reorganizeQueue(queue, data, { now })
  const by = Object.fromEntries(out.map((q) => [q.slug, q]))
  assert.equal(by.c5.scheduleAt, noon + 15 * 60_000)
  assert.deepEqual(by.c5.targets, ['fb:b'])
  assert.deepEqual(by.c6.targets, ['fb:a'], 'เพจ B มีคลิปที่ติ๊กเองแล้ว คลิปที่ระบบเลือกจึงไปเพจ A')
  assert.equal(by.c6.scheduleAt, noon)
})

await test('จัดคิวใหม่ไม่ย้ายไปแพลตฟอร์มที่คลิปเคยลงแล้ว', () => {
  rmSync(join(tmp, 'posted.json'), { force: true })
  P.recordPosted('c1/c1.mp4', 'fb:a', { name: 'ใจใส' })
  const { queue: out } = P.reorganizeQueue([clip(1, { status: 'review', targets: ['fb:b'] })], data, { now })
  assert.deepEqual(out[0].targets, [], 'ลง Facebook ไปแล้ว ห้ามไปเพจอื่น')
})

// ── bridge: จัดคิวใหม่ครั้งเดียวตอนเปิด + ปุ่ม ──
const SLUG = `_perpage_test_${Date.now()}`
const projectDir = join(ROOT, 'projects', SLUG)
mkdirSync(join(projectDir, '06_render'), { recursive: true })
writeFileSync(join(projectDir, '06_render', `${SLUG}.mp4`), Buffer.alloc(512, 1))
try {
  await test('เปิดโปรแกรมรุ่นนี้ครั้งแรก → จัดคิวเดิมใหม่ให้เองครั้งเดียว', () => {
    rmSync(join(tmp, 'posted.json'), { force: true })
    P.saveAccounts(data)
    const tomorrowNoon = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return d.getTime() })()
    const tomorrowSeven = tomorrowNoon + 7 * 3600_000
    P.saveQueue([
      clip(1, { status: 'scheduled', scheduleAt: tomorrowNoon, targets: ['fb:a'] }),
      clip(2, { status: 'scheduled', scheduleAt: tomorrowSeven, targets: ['fb:a'] }),
    ])
    createPosting({ jobs: new Map(), enqueue: () => ({}), json: () => {}, readBody: async () => ({}), log: () => {}, port: 1, token: 'x', scheduler: false, deps: { listVideos: async () => [] } })
    const q = P.loadQueue()
    assert.deepEqual(q.map((x) => x.targets[0]).sort(), ['fb:a', 'fb:b'])
    assert.ok(q.every((x) => x.scheduleAt <= tomorrowNoon), 'ทั้งสองคลิปลงช่องแรกที่ว่างของเพจตัวเอง')
    assert.ok(q.some((x) => x.history.some((h) => /จัดคิวใหม่/.test(h.text))))
    assert.ok(P.loadAccounts().settings.perPageQueueAt, 'จดไว้ว่าจัดแล้ว ไม่จัดซ้ำทุกครั้งที่เปิด')
    const before = JSON.stringify(P.loadQueue())
    createPosting({ jobs: new Map(), enqueue: () => ({}), json: () => {}, readBody: async () => ({}), log: () => {}, port: 1, token: 'x', scheduler: false, deps: { listVideos: async () => [] } })
    assert.equal(JSON.stringify(P.loadQueue()), before)
  })
  console.log(`\nผ่าน ${passed} ข้อ`)
} finally {
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(0)
