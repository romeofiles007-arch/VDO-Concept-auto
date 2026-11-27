// เทสต์: คิวพากย์ข้ามเครื่อง (24hrs ฝากงาน → เครื่อง 4070 ดึงไปพากย์ ส่งกลับ)
//   node scripts/test-tts-queue.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { heartbeat, enqueueJob, claimNext, writeProgress, finishJob, failJob, jobState, workerStatus, waitForJob, narrateRemote, describeWait, CLIENT_STALE_MS, CLAIM_STALE_MS } from '../pipeline/lib/tts_queue.mjs'

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const base = mkdtempSync(join(tmpdir(), 'ttsq-'))
const fresh = (name) => join(base, name)
const ref = join(base, 'ref.wav')
writeFileSync(ref, Buffer.alloc(2000, 1))
const segsIn = (dir) => [0, 1].map((i) => ({ index: i, text: `ประโยค ${i}`, out: join(dir, `${i}.wav`) }))
const age = (file, ms) => {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  for (const k of ['seen', 'at']) if (k in data) data[k] -= ms
  writeFileSync(file, JSON.stringify(data))
}

await test('ฝากงาน → เครื่องพากย์รับ → ส่งเสียงกลับ → เครื่องผลิตได้ไฟล์ครบ แล้วงานหายจากคิว', async () => {
  const root = fresh('a')
  const segs = segsIn(base)
  const id = enqueueJob({ refWav: ref, refText: 'ข้อความต้นแบบ', settings: { cfg: 2, steps: 25 }, segments: segs, label: 'x' }, root)
  assert.equal(jobState(id, root).state, 'waiting')
  const got = claimNext('PC4070', { gpu: 'RTX 4070' }, root)
  assert.equal(got.id, id)
  assert.deepEqual(got.job.segments, [{ index: 0, text: 'ประโยค 0' }, { index: 1, text: 'ประโยค 1' }])
  assert.equal(got.job.refText, 'ข้อความต้นแบบ')
  assert.equal(got.job.settings.steps, 25)
  assert.ok(existsSync(got.refWav))
  assert.equal(claimNext('OTHER', {}, root), null, 'งานที่รับแล้วไม่แจกให้เครื่องอื่น ระหว่างกำลังพากย์')
  writeProgress(id, 1, 2, root)
  assert.match(describeWait(jobState(id, root), workerStatus(root)), /PC4070 กำลังพากย์ 1\/2/)
  finishJob(id, { '0000.wav': Buffer.alloc(500, 7), '0001.wav': Buffer.alloc(600, 8) }, { worker: 'PC4070', seconds: 12 }, root)
  const done = await waitForJob(id, segs, { root, pollMs: 10 })
  assert.equal(done.worker, 'PC4070')
  assert.equal(readFileSync(segs[1].out).length, 600)
  assert.ok(!existsSync(join(root, id)))
})

await test('เครื่องพากย์ปิดอยู่ → ข้อความบอกว่ารอเปิด และยังรออยู่ (ไม่พัง)', async () => {
  const root = fresh('b')
  claimNext('PC4070', {}, root) // เคยออนไลน์
  age(join(root, 'worker.json'), 3 * 3_600_000)
  const id = enqueueJob({ refWav: ref, refText: 't', segments: segsIn(base) }, root)
  const st = workerStatus(root)
  assert.equal(st.online, false)
  assert.match(describeWait(jobState(id, root), st), /รอเครื่องพากย์ \(PC4070\) เปิด — ออนไลน์ล่าสุด 3 ชม.ที่แล้ว/)
  const seen = []
  await assert.rejects(waitForJob(id, segsIn(base), { root, pollMs: 10, timeoutMs: 60, onStatus: (t) => seen.push(t) }), /เครื่องพากย์ปิดอยู่/)
  assert.equal(seen.length, 1, 'สถานะเดิมไม่พิมพ์ซ้ำทุกรอบ')
})

await test('พากย์ไม่สำเร็จ → เครื่องผลิตได้ error พร้อมชื่อเครื่อง', async () => {
  const root = fresh('c')
  const id = enqueueJob({ refWav: ref, refText: 't', segments: segsIn(base) }, root)
  claimNext('PC4070', {}, root)
  failJob(id, 'CUDA out of memory', 'PC4070', root)
  await assert.rejects(waitForJob(id, segsIn(base), { root, pollMs: 10 }), /เครื่องพากย์ PC4070: CUDA out of memory/)
})

await test('ส่งเสียงกลับไม่ครบ → error ไม่เอาเสียงครึ่งๆ ไปทำคลิป', async () => {
  const root = fresh('d')
  const id = enqueueJob({ refWav: ref, refText: 't', segments: segsIn(base) }, root)
  claimNext('PC4070', {}, root)
  finishJob(id, { '0000.wav': Buffer.alloc(500) }, {}, root)
  await assert.rejects(waitForJob(id, segsIn(base), { root, pollMs: 10 }), /ประโยค 2 มาไม่ครบ/)
})

await test('คลิปถูกหยุด (เครื่องผลิตเลิกรอ) → เครื่องพากย์ไม่ต้องทำ ลบทิ้ง', async () => {
  const root = fresh('e')
  const id = enqueueJob({ refWav: ref, refText: 't', segments: segsIn(base) }, root)
  age(join(root, id, 'client.json'), CLIENT_STALE_MS + 1000)
  assert.equal(claimNext('PC4070', {}, root), null)
  assert.ok(!existsSync(join(root, id)))
})

await test('เครื่องพากย์ดับกลางงาน → เปิดใหม่รับงานเดิมต่อ · เครื่องอื่นรับต่อได้เมื่อเงียบเกิน 10 นาที', async () => {
  const root = fresh('f')
  const id = enqueueJob({ refWav: ref, refText: 't', segments: segsIn(base) }, root)
  claimNext('PC4070', {}, root)
  assert.equal(claimNext('PC4070', {}, root)?.id, id, 'เครื่องเดิมเปิดใหม่ → รับต่อ')
  assert.equal(claimNext('OTHER', {}, root), null, 'อีกเครื่องไม่แย่ง ระหว่างที่ยังทำอยู่')
  age(join(root, id, 'claim.json'), CLAIM_STALE_MS + 1000)
  assert.equal(claimNext('OTHER', {}, root)?.id, id)
})

await test('งานเก่าสุดก่อน', async () => {
  const root = fresh('g')
  const first = enqueueJob({ refWav: ref, refText: 't', segments: segsIn(base) }, root)
  await new Promise((r) => setTimeout(r, 1100))
  enqueueJob({ refWav: ref, refText: 't', segments: segsIn(base) }, root)
  assert.equal(claimNext('PC4070', {}, root).id, first)
})

await test('รหัสงาน/ชื่อไฟล์แปลกๆ (path traversal) ถูกปฏิเสธ', async () => {
  const root = fresh('h')
  assert.throws(() => jobState('../x', root), /รหัสงานไม่ถูกต้อง/)
  const id = enqueueJob({ refWav: ref, refText: 't', segments: segsIn(base) }, root)
  assert.throws(() => finishJob(id, { '../evil.wav': Buffer.alloc(1) }, {}, root), /ชื่อไฟล์ไม่ถูกต้อง/)
})

await test('heartbeat ระหว่างพากย์ไม่ลบชื่อการ์ดจอ', async () => {
  const root = fresh('i')
  claimNext('PC4070', { gpu: 'RTX 4070' }, root)
  heartbeat('PC4070', { busy: 'x' }, root)
  assert.equal(workerStatus(root).gpu, 'RTX 4070')
  const id = enqueueJob({ refWav: ref, refText: 't', segments: segsIn(base) }, root)
  assert.match(describeWait(jobState(id, root), workerStatus(root)), /กำลังพากย์งานอื่นอยู่/, 'พากย์งานของโปรแกรมอื่นอยู่ ไม่ใช่ปิด')
  claimNext('PC4070', {}, root)
  assert.equal(workerStatus(root).busy, null, 'เช็กคิวใหม่ = ว่างแล้ว')
})

await test('เครื่องพากย์ทำพัง / งานหายจากคิว → ฝากงานใหม่แล้วรอต่อ ไม่เลิกรอ (ห้ามส่งไปพากย์ที่อื่น)', async () => {
  const root = fresh('j')
  const segs = segsIn(base)
  const queued = []
  const statuses = []
  // เครื่องพากย์จำลอง: งานแรกพัง · งานที่สองหายจากคิว · งานที่สามสำเร็จ
  const worker = setInterval(() => {
    const got = claimNext('PC4070', {}, root)
    if (!got) return
    const n = queued.indexOf(got.job.id) + 1
    if (n === 1) failJob(got.job.id, 'CUDA out of memory', 'PC4070', root)
    else if (n === 2) rmSync(join(root, got.job.id), { recursive: true, force: true })
    else finishJob(got.job.id, { '0000.wav': Buffer.alloc(500, 7), '0001.wav': Buffer.alloc(500, 8) }, { worker: 'PC4070', seconds: 1 }, root)
  }, 5)
  try {
    const done = await narrateRemote({ refWav: ref, refText: 't', settings: {} }, segs, {
      root, pollMs: 5, retryMs: 5,
      onQueued: (id) => queued.push(id),
      onStatus: (text, state) => statuses.push(state.state),
    })
    assert.equal(done.attempts, 3)
    assert.equal(queued.length, 3, 'ฝากงานใหม่ทุกครั้งที่พัง')
    assert.equal(statuses.filter((s) => s === 'retry').length, 2)
    assert.equal(readFileSync(segs[1].out)[0], 8)
    assert.ok(queued.every((id) => !existsSync(join(root, id))), 'ไม่มีงานค้างในคิว')
  } finally {
    clearInterval(worker)
  }
})

rmSync(base, { recursive: true, force: true })
console.log(`\nผ่าน ${passed} ข้อ`)
