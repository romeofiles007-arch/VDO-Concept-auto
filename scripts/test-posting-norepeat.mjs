// เทสต์กฎห้ามโพสต์ซ้ำ (ผู้ใช้ 7 พ.ย. 2026):
//   1 คลิปลงได้ 1 เพจ/ช่องต่อแพลตฟอร์ม · ลงแพลตฟอร์มไหนแล้วห้ามลงแพลตฟอร์มนั้นอีกตลอดไป · แพลตฟอร์มอื่นยังลงได้
// ไม่ยิง Facebook/YouTube จริง ไม่แตะคิว/โทเค็นจริง
//   node scripts/test-posting-norepeat.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmp = mkdtempSync(join(tmpdir(), 'posting-norepeat-'))
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
const reset = () => rmSync(join(tmp, 'posted.json'), { force: true })

// ── ตรรกะล้วน ──
await test('แพลตฟอร์มละ 1 ปลายทาง · หลายเพจ Facebook เหลือเพจเดียว', () => {
  reset()
  assert.deepEqual(P.onePerPlatform(['fb:a', 'fb:b', 'yt:c', 'yt:d']), ['fb:a', 'yt:c'])
  const data = { facebook: [{ id: 'a' }, { id: 'b' }], youtube: [{ id: 'c', refreshToken: 'r' }] }
  assert.deepEqual(P.targetsFor(data, null), ['fb:a', 'yt:c'])
})

await test('คลิปที่ลงแพลตฟอร์มไหนแล้ว → ตัดแพลตฟอร์มนั้นออก ลงได้เฉพาะแพลตฟอร์มที่ยังไม่เคยลง', () => {
  reset()
  P.recordPosted('clip1', 'fb:a', { name: 'เพจ A' })
  const data = { facebook: [{ id: 'a' }, { id: 'b' }], youtube: [{ id: 'c', refreshToken: 'r' }] }
  assert.deepEqual(P.targetsFor(data, null, { clip: 'clip1' }), ['yt:c'], 'ห้ามลง Facebook เพจอื่นด้วย')
  assert.deepEqual(P.targetsFor(data, null, { clip: 'clip2' }), ['fb:b', 'yt:c'], 'คลิปอื่นไม่โดน · เพจ A ได้ไปแล้ว 1 คลิป จึงกระจายไปเพจ B')
})

await test('สมุดบันทึกเก็บครั้งแรกไว้ ไม่ทับ', () => {
  reset()
  P.recordPosted('clip1', 'fb:a', { name: 'เพจ A', at: 1 })
  P.recordPosted('clip1', 'fb:b', { name: 'เพจ B', at: 2 })
  assert.equal(P.loadPosted().clip1.fb.key, 'fb:a')
})

await test('คลิปที่โพสต์ไปก่อนมีกฎ → เติมเข้าสมุดบันทึกจากคิว', () => {
  reset()
  const added = P.backfillPosted([
    { slug: 'old', file: 'old.mp4', title: 'เก่า', postedAt: 10, results: { 'fb:a': { ok: true, name: 'เพจ A', at: 10 }, 'yt:c': { ok: false } } },
  ])
  assert.equal(added, 1)
  assert.deepEqual(Object.keys(P.loadPosted()['old/old.mp4']), ['fb'], 'ระบุคลิปด้วยโปรเจกต์ + ไฟล์ แบบเดียวกับคิว')
  assert.equal(P.backfillPosted([{ slug: 'old', file: 'old.mp4', results: { 'fb:a': { ok: true } } }]), 0, 'เติมซ้ำไม่ได้')
})

// ── bridge โพสต์จริง (อัปโหลดปลอม) ──
const SLUG = `_norepeat_test_${Date.now()}`
const projectDir = join(ROOT, 'projects', SLUG)
mkdirSync(join(projectDir, '06_render'), { recursive: true })
writeFileSync(join(projectDir, '06_render', `${SLUG}.mp4`), Buffer.alloc(1024, 1))
const uploads = []
const posting = createPosting({
  jobs: new Map(), enqueue: () => ({}), json: () => {}, readBody: async () => ({}), log: () => {}, port: 1, token: 'x', scheduler: false,
  deps: {
    listVideos: async () => [],
    facebookUpload: async (args) => (uploads.push({ kind: 'fb', pageId: args.pageId }), { postId: 'p', url: `https://www.facebook.com/${args.pageId}/videos/1` }),
    youtubeUpload: async () => (uploads.push({ kind: 'yt' }), { postId: 'v', url: 'https://www.youtube.com/watch?v=1' }),
  },
})
const accounts = P.loadAccounts()
P.saveAccounts({
  ...accounts,
  settings: { ...accounts.settings, google: { clientId: 'x.apps.googleusercontent.com', clientSecret: 's' } },
  facebook: [{ id: 'a', name: 'ใจใส ใจสบาย วันหยุด', pageId: '111', token: 'tok-a' }, { id: 'b', name: 'รู้มั้ย เป็นใคร', pageId: '222', token: 'tok-b' }],
  youtube: [{ id: 'c', name: 'ช่อง', refreshToken: 'rt' }],
})
const longAgo = () => {
  // ข้ามช่วงเว้น 30 นาทีระหว่างโพสต์ (คนละกฎ)
  const q = P.loadQueue()
  for (const it of q) for (const r of Object.values(it.results ?? {})) r.at = Date.now() - 3600_000
  P.saveQueue(q.map((it) => ({ ...it, postedAt: it.postedAt ? Date.now() - 3600_000 : it.postedAt })))
}

try {
  await test('คิวเก่าที่ติ๊กไว้ 2 เพจ Facebook → ขึ้นเพจแรกเพจเดียว เพจที่สองถูกข้าม · YouTube ยังขึ้น', async () => {
    reset()
    const item = { ...P.newItem({ slug: SLUG, file: `${SLUG}.mp4`, title: 'คลิปทดสอบ', post: { title: 'ชื่อ' }, targets: ['fb:a', 'fb:b', 'yt:c'] }), status: 'scheduled', scheduleAt: Date.now() - 1000 }
    P.saveQueue([item])
    await posting.tick()
    const it = P.loadQueue()[0]
    assert.deepEqual(uploads.map((u) => u.pageId ?? u.kind), ['111', 'yt'], 'ห้ามอัปโหลดเพจที่สอง')
    assert.equal(it.status, 'posted')
    assert.deepEqual(it.targets, ['fb:a', 'yt:c'])
    assert.ok(it.history.some((h) => /ห้ามโพสต์คลิปเดิมซ้ำในแพลตฟอร์มเดิม/.test(h.text)))
    assert.deepEqual(Object.keys(P.loadPosted()[`${SLUG}/${SLUG}.mp4`]).sort(), ['fb', 'yt'])
  })

  await test('เอาคลิปเดิมเข้าคิวใหม่ ติ๊กเพจ Facebook อื่น → ไม่อัปโหลดเด็ดขาด', async () => {
    longAgo()
    const again = { ...P.newItem({ slug: SLUG, file: `${SLUG}.mp4`, title: 'คลิปทดสอบ', post: { title: 'ชื่อ' }, targets: ['fb:b'] }), status: 'scheduled', scheduleAt: Date.now() - 1000 }
    P.saveQueue([...P.loadQueue().map((q) => ({ ...q, status: 'removed' })), again])
    const before = uploads.length
    await posting.tick()
    const it = P.loadQueue().find((q) => q.id === again.id)
    assert.equal(uploads.length, before, 'ต้องไม่มีการอัปโหลด')
    assert.equal(it.status, 'failed')
    assert.match(it.error, /ลง Facebook ไปแล้ว.*ห้ามโพสต์คลิปเดิมซ้ำ/)
  })

  await test('สมุดบันทึกอยู่ถาวรแม้ล้างคิว — คลิปเดิมไม่ได้ปลายทางในแพลตฟอร์มที่เคยลง', () => {
    P.saveQueue([])
    assert.deepEqual(P.targetsFor(P.loadAccounts(), null, { clip: P.clipKey({ slug: SLUG, file: `${SLUG}.mp4` }) }), [], 'ลงครบทั้ง Facebook และ YouTube แล้ว')
    assert.ok(JSON.parse(readFileSync(join(tmp, 'posted.json'), 'utf8'))[`${SLUG}/${SLUG}.mp4`].fb.url)
  })

  console.log(`\nผ่าน ${passed} ข้อ`)
} finally {
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(0)
