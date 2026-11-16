// เทสต์: คลิปที่โพสต์ครบแล้วต้องออกจากคิว + มุมมองคิวแยกทีละปลายทาง — ไม่แตะคิว/โทเค็นจริง ไม่ยิงเครือข่าย
//   node scripts/test-posting-settle.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmp = mkdtempSync(join(tmpdir(), 'posting-settle-'))
process.env.POSTING_DIR = tmp
const P = await import('../pipeline/lib/posting.mjs')
const { createPosting } = await import('../bridge/posting.js')
const { splitQueue, NO_DEST } = await import('../extension/posting.js')
const { cleanSettings } = await import('../bridge/production.js')
const { ROOT } = await import('../pipeline/lib/config.mjs')

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const FB = 'fb:f1', FB2 = 'fb:f2', TK = 'yt:y1' // ปลายทางที่สอง = ช่อง YouTube (Cartoon Auto ไม่มี TikTok)
const ok = (at) => ({ ok: true, at, name: 'x', url: 'https://example.com/p' })
const item = (id, status, targets, results = {}, extra = {}) => ({ id, slug: id, file: `${id}.mp4`, title: id, status, addedAt: 1, targets, results, history: [], ...extra })

// ── settleQueue ──
await test('ขึ้นครบทุกปลายทางที่เหลือแล้วแต่ยังค้าง ตั้งเวลา/รอตรวจ/พลาด → โพสต์แล้ว', () => {
  const q = [
    item('a', 'scheduled', [FB], { [FB]: ok(1000) }, { scheduleAt: 9000, targetAt: { [TK]: 9000 }, finishedAt: 1000 }),
    item('b', 'review', [FB], { [FB]: ok(2000) }),
    item('c', 'failed', [FB], { [FB]: ok(3000), [TK]: { ok: false, needsVerification: true, at: 4000 } }, { error: 'TikTok: คำบรรยายไม่เข้า' }),
    item('d', 'scheduled', [], { [FB]: ok(5000) }), // ปลายทางที่เหลือถูกลบหมด แต่เคยขึ้นแล้ว
  ]
  assert.equal(P.settleQueue(q), 4)
  for (const x of q) assert.equal(x.status, 'posted', x.id)
  assert.equal(q[0].postedAt, 1000, 'เวลาโพสต์ = เวลาที่ขึ้นจริง ไม่ใช่ตอนเก็บคิว')
  assert.equal(q[0].finishedAt, 1000, 'ไม่แตะ finishedAt — ไม่แจ้งเตือนย้อนหลัง')
  assert.equal(q[0].targetAt, null)
  assert.equal(q[2].error, null)
  assert.match(q[1].history.at(-1).text, /โพสต์แล้ว/)
})

await test('ยังมีปลายทางที่รออยู่ / ยังไม่ขึ้นที่ไหนเลย / กำลังโพสต์ / ตีกลับ → ไม่แตะ', () => {
  const q = [
    item('a', 'scheduled', [FB, TK], { [FB]: ok(1000) }), // รอปลายทางที่สองจริง
    item('b', 'review', [FB]),
    item('c', 'failed', [FB], { [FB]: { ok: false, needsVerification: true } }),
    item('d', 'posting', [FB], { [FB]: ok(1000) }),
    item('e', 'rejected', [FB], { [FB]: ok(1000) }),
    item('f', 'removed', [FB], { [FB]: ok(1000) }),
    item('g', 'scheduled', []),
  ]
  const before = JSON.stringify(q)
  assert.equal(P.settleQueue(q), 0)
  assert.equal(JSON.stringify(q), before)
})

// ── splitQueue: มุมมองคิวต่อปลายทาง ──
const queue = [
  item('wait-fb', 'scheduled', [FB, TK], {}, { scheduleAt: 100, targetAt: { [FB]: 300, [TK]: 100 } }),
  item('fb-done', 'scheduled', [FB, TK], { [FB]: ok(50) }, { scheduleAt: 200, targetAt: { [TK]: 200 } }),
  item('fb-early', 'scheduled', [FB], {}, { scheduleAt: 150 }),
  item('page2', 'review', [FB2]),
  item('rev', 'review', [FB, TK]),
  item('done', 'posted', [FB, TK], { [FB]: ok(10), [TK]: ok(20) }, { postedAt: 20 }),
  item('half', 'failed', [FB, TK], { [FB]: ok(30), [TK]: { ok: false, error: 'x' } }),
  item('orphan', 'review', []),
  item('back', 'rejected', [FB]),
]
const ids = (list) => list.map((q) => q.id)

await test('ทุกปลายทาง: แบ่งตามสถานะของคลิป (แบบเดิม)', () => {
  const g = splitQueue(queue)
  assert.deepEqual(ids(g.review), ['page2', 'rev', 'orphan'])
  assert.deepEqual(ids(g.scheduled), ['wait-fb', 'fb-early', 'fb-done'])
  assert.deepEqual(ids(g.posted).sort(), ['done', 'half'])
  assert.deepEqual(ids(g.rejected), ['back'])
  assert.equal(g.failed(queue.find((q) => q.id === 'half')), true)
})

await test('ดูเพจเดียว: คลิปที่ขึ้นเพจนี้แล้วไปอยู่ "โพสต์แล้ว" ของเพจนี้ แม้ยังรอปลายทางอื่น · เรียงตามเวลาของเพจนี้', () => {
  const g = splitQueue(queue, FB)
  assert.deepEqual(ids(g.review), ['rev'])
  assert.deepEqual(ids(g.scheduled), ['fb-early', 'wait-fb'], 'เรียงตามเวลา FB (150, 300) และไม่มี fb-done')
  assert.deepEqual(ids(g.posted), ['fb-done', 'half', 'done'], 'ใหม่สุดก่อน ตามเวลาที่ขึ้นเพจนี้')
  assert.ok(g.posted.every((q) => !g.failed(q)), 'half ขึ้น FB สำเร็จ — ในมุมของ FB ไม่ใช่โพสต์พลาด')
  assert.equal(g.postedAt(queue.find((q) => q.id === 'fb-done')), 50)
  assert.equal(g.scheduleAt(queue.find((q) => q.id === 'wait-fb')), 300)
  assert.deepEqual(ids(g.rejected), ['back'])
})

await test('ดูปลายทางที่สอง: คลิปที่ FB ขึ้นแล้วยังอยู่ในคิวตั้งเวลาของปลายทางนั้น · half เป็นโพสต์พลาดของปลายทางนั้น', () => {
  const g = splitQueue(queue, TK)
  assert.deepEqual(ids(g.scheduled), ['wait-fb', 'fb-done'])
  assert.deepEqual(ids(g.posted).sort(), ['done', 'half'])
  assert.equal(g.failed(queue.find((q) => q.id === 'half')), true)
  assert.equal(g.failed(queue.find((q) => q.id === 'done')), false)
})

await test('เพจอื่นเห็นแต่คลิปของตัวเอง · กลุ่ม "ยังไม่มีปลายทาง"', () => {
  assert.deepEqual(ids(splitQueue(queue, FB2).review), ['page2'])
  assert.equal(splitQueue(queue, FB2).scheduled.length, 0)
  assert.deepEqual(ids(splitQueue(queue, NO_DEST).review), ['orphan'])
})

// ── bridge: เอาบัญชีออก / เปิดโปรแกรม → คลิปที่รอแค่บัญชีนั้นไม่ค้างในคิว ──
const TOKEN = 'test-token'
const logs = []
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const readBody = (req) => new Promise((resolve) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => resolve(raw ? JSON.parse(raw) : {}))
})
const jobs = new Map()
const enqueue = (agent, kind, payload) => {
  const job = { id: `job${jobs.size + 1}`, agent, kind, payload, status: 'queued' }
  jobs.set(job.id, job)
  return job
}
const boot = (port) => createPosting({ jobs, enqueue, json, readBody, port, token: TOKEN, log: (s) => logs.push(s), scheduler: false, deps: { listVideos: async () => [], editQuietMs: 0 } })
let posting
// คลิปจริงบนดิสก์ (ไฟล์เปล่า) — ระบบไม่ตั้งเวลาให้คลิปที่ไฟล์วิดีโอหาย · ลบทิ้งท้ายเทสต์
const SLUGS = ['_test-noreview-a', '_test-noreview-b']
for (const slug of SLUGS) {
  mkdirSync(join(ROOT, 'projects', slug, '06_render'), { recursive: true })
  mkdirSync(join(ROOT, 'projects', slug, '01_script'), { recursive: true })
  writeFileSync(join(ROOT, 'projects', slug, '06_render', `${slug}.mp4`), '')
}

P.saveAccounts({
  settings: { ...P.DEFAULT_SETTINGS, slots: ['12:00'] },
  facebook: [{ id: 'f1', name: 'เพจทดสอบ', pageId: '123456', token: 'x'.repeat(30) }],
  youtube: [{ id: 'y1', name: 'ช่องทดสอบ', channelId: 'UC1', refreshToken: 'rt', privacy: 'public' }],
})
const future = Date.now() + 86_400_000
P.saveQueue([
  item('fbdone', 'scheduled', [FB, TK], { [FB]: ok(1000) }, { scheduleAt: future, targetAt: { [TK]: future } }),
  item('both', 'scheduled', [FB, TK], {}, { scheduleAt: future, targetAt: { [FB]: future, [TK]: future + 3600_000 } }),
  item('stuck', 'review', [FB], { [FB]: ok(2000) }), // ค้างมาจากรุ่นก่อน
])

const server = createServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
try {
  await test('เปิดโปรแกรม: คลิปที่ค้างจากรุ่นก่อน (ขึ้นครบแล้ว) ถูกย้ายไปโพสต์แล้วทันที', () => {
    posting = boot(port)
    server.on('request', async (req, res) => {
      if (!(await posting.handle(req, res, new URL(req.url, `http://127.0.0.1:${port}`)))) json(res, 404, {})
    })
    const q = P.loadQueue()
    assert.equal(q.find((x) => x.id === 'stuck').status, 'posted')
    assert.equal(q.find((x) => x.id === 'fbdone').status, 'scheduled', 'ยังรอปลายทางที่สองจริง — ไม่แตะ')
    assert.ok(logs.some((l) => /ย้าย 1 คลิป/.test(l)))
  })

  await test('เอาช่อง YouTube ออก: คลิปที่ FB ขึ้นแล้ว → โพสต์แล้ว · คลิปที่ยังรอ FB อยู่ต่อตามเวลาเดิม', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/posting/youtube/remove`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN }, body: JSON.stringify({ id: 'y1' }) })
    assert.equal(res.status, 200)
    const view = await res.json()
    const done = view.queue.find((x) => x.id === 'fbdone')
    assert.equal(done.status, 'posted')
    assert.equal(done.postedAt, 1000)
    assert.deepEqual(done.targets, [FB])
    const both = view.queue.find((x) => x.id === 'both')
    assert.equal(both.status, 'scheduled')
    assert.deepEqual(both.targets, [FB])
    assert.equal(both.scheduleAt, future)
    assert.equal(view.youtube.length, 0)
  })

  // ── ไม่มีขั้นตรวจ: เข้าคิวแล้วตั้งเวลาโพสต์เอง (ผู้ใช้ 16 พ.ย. 2026) ──
  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN }, body: JSON.stringify(body) })
    return { status: res.status, data: await res.json() }
  }
  const [A, B] = SLUGS
  const clip = (slug, extra = {}) => item(slug, 'review', [], {}, { file: `${slug}.mp4`, post: { title: 'ชื่อโพสต์', titles: [], description: '', hashtags: [] }, ...extra })
  const get = (id) => P.loadQueue().find((x) => x.id === id)

  await test('คลิปเข้าคิวแล้วได้เวลาโพสต์เองทันที — ไม่ต้องตรวจ ไม่ต้องกดอะไร', async () => {
    P.saveQueue([clip(A), item('nofile', 'review', [], {}, { post: { title: 'ชื่อ' } })])
    await posting.tick()
    const a = get(A)
    assert.equal(a.status, 'scheduled')
    assert.deepEqual(a.targets, [FB])
    assert.ok(a.scheduleAt > Date.now(), 'ลงช่องเวลาถัดไปของเพจ')
    assert.equal(get('nofile').status, 'review', 'ไฟล์วิดีโอหาย = ไม่ตั้งเวลา')
    assert.equal(jobs.size, 0, 'ไม่ส่งคลิปให้ AI ตรวจ (ไม่มีงาน ChatGPT เลย เพราะมีชื่อโพสต์อยู่แล้ว)')
  })

  await test('ยกเลิกเวลา = พักไว้ ไม่ตั้งเวลาเองซ้ำ · กดตั้งเวลา = กลับเข้าคิว', async () => {
    let r = await post('/api/posting/unschedule', { id: A })
    assert.equal(r.status, 200)
    await posting.tick()
    assert.equal(get(A).status, 'review')
    assert.equal(get(A).hold, true)
    r = await post('/api/posting/approve', { id: A, when: 'next' })
    assert.equal(r.status, 200)
    assert.equal(get(A).status, 'scheduled')
    assert.equal(get(A).hold, undefined)
  })

  await test('ไม่มีชื่อโพสต์: ChatGPT เขียนให้เอง → ได้แล้วตั้งเวลาเอง · พลาดแล้วเว้น 30 นาทีค่อยลองใหม่', async () => {
    P.saveQueue([clip(B, { post: { title: '', titles: [], description: '', hashtags: [] } })])
    await posting.tick()
    const job = [...jobs.values()].find((j) => j.agent === 'chatgpt')
    assert.ok(job, 'ขอ ChatGPT เขียนชื่อโพสต์')
    assert.equal(get(B).postJob.status, 'running')
    assert.equal(get(B).status, 'review')
    job.status = 'error'
    job.error = 'แท็บ ChatGPT ปิดอยู่'
    await posting.tick()
    assert.equal(get(B).postJob.status, 'error')
    assert.equal(get(B).postJob.tries, 1)
    assert.equal(jobs.size, 1, 'ยังไม่ครบ 30 นาที — ไม่ขอซ้ำทันที')
    // ครบ 30 นาที → ขอใหม่เอง
    const q = P.loadQueue()
    q[0].postJob.at = Date.now() - 31 * 60_000
    P.saveQueue(q)
    await posting.tick()
    const again = [...jobs.values()].find((j) => j.status === 'queued')
    assert.ok(again, 'ลองใหม่เองหลังเว้น 30 นาที')
    assert.equal(get(B).postJob.tries, 2)
    again.status = 'done'
    again.result = { text: '{"titles": ["ชื่อจาก ChatGPT", "ข", "ค"], "description": "คำบรรยาย", "hashtags": ["#ธรรมะ"]}' }
    await posting.tick()
    assert.equal(get(B).post.title, 'ชื่อจาก ChatGPT')
    assert.equal(get(B).status, 'scheduled')
  })

  await test('ผลิตต่อเนื่อง: ค่าเก่า "ให้ AI ตรวจ" = เข้าคิวโพสต์เลย · ไม่มีสวิตช์ตรวจ/อนุมัติแล้ว', () => {
    assert.equal(cleanSettings({ autoPost: 'ai' }).autoPost, 'now')
    assert.equal(cleanSettings({ autoPost: true }).autoPost, 'now')
    assert.equal(cleanSettings({ autoPost: 'off' }).autoPost, 'off')
    assert.equal(P.STATUS.review, 'รอตั้งเวลา')
    assert.equal(P.DEFAULT_SETTINGS.autoApprove, undefined)
    assert.equal(P.parseQc, undefined)
  })

  console.log(`\nผ่าน ${passed} ข้อ`)
} finally {
  server.close()
  for (const slug of SLUGS) rmSync(join(ROOT, 'projects', slug), { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(0)
