// เทสต์โหมดโพสต์อัตโนมัติ (แผนกนกนางนวล) — ไม่ยิง Facebook/YouTube จริง ไม่แตะคิว/โทเค็นจริง
//   node scripts/test-posting.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const tmp = mkdtempSync(join(tmpdir(), 'posting-test-'))
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

// ── ตรรกะล้วน ──
await test('ช่องเวลา: ทำความสะอาด เรียง ไม่ซ้ำ', () => {
  assert.deepEqual(P.cleanSlots('19:00, 9:05 12:00 25:00 aa 19:00'), ['09:05', '12:00', '19:00'])
})

await test('ช่องเวลาถัดไป: ข้ามช่องที่ผ่านแล้ว/ใกล้เกินไป/ถูกจอง', () => {
  const now = new Date(2026, 9, 28, 11, 58).getTime() // 11:58
  const noon = new Date(2026, 9, 28, 12, 0).getTime()
  const seven = new Date(2026, 9, 28, 19, 0).getTime()
  assert.equal(P.nextFreeSlot(['12:00', '19:00'], [], now), seven, '12:00 ห่างแค่ 2 นาที ต้องข้าม')
  assert.equal(P.nextFreeSlot(['12:00', '19:00'], [], now - 60 * 60_000), noon)
  assert.equal(P.nextFreeSlot(['12:00', '19:00'], [seven], now), new Date(2026, 9, 29, 12, 0).getTime())
  assert.equal(P.nextFreeSlot([], [], now), null)
})

await test('แฮชแท็ก + ข้อความโพสต์', () => {
  assert.deepEqual(P.cleanHashtags('ยุง #ScienceFacts ยุง  #'), ['#ยุง', '#ScienceFacts'])
  assert.equal(P.caption({ description: 'บรรยาย', hashtags: ['#a', 'b'] }), 'บรรยาย\n\n#a #b')
})

await test('อ่านผลตรวจ AI: มี ```json``` / ขึ้นบรรทัดใหม่ในสตริง / ไม่มี verdict', () => {
  const r = P.parseQc('ผลตรวจ:\n```json\n{"score": 72, "verdict": "fix", "summary": "ภาพ 3\nสะกดผิด", "issues": ["ภาพ 3 สะกดผิด", ""]}\n```')
  assert.equal(r.score, 72)
  assert.equal(r.verdict, 'fix')
  assert.deepEqual(r.issues, ['ภาพ 3 สะกดผิด'])
  assert.equal(P.parseQc('{"score": 91}').verdict, 'pass')
  assert.throws(() => P.parseQc('ไม่มี json'), /อ่านผลตรวจ/)
})

await test('เวลาตัดเฟรม กระจายทั้งคลิป', () => {
  assert.deepEqual(P.frameTimes(80, 4), [10, 30, 50, 70])
})

await test('เข้าคิวเอง: เฉพาะคลิปหลักที่เสร็จหลังเปิดโหมด และยังไม่อยู่ในคิว', () => {
  const videos = [
    { slug: 'new', title: 'ใหม่', files: [{ name: 'new.mp4', createdAt: 2000 }] },
    { slug: 'old', title: 'เก่า', files: [{ name: 'old.mp4', createdAt: 500 }] },
    { slug: 'done', title: 'อยู่ในคิวแล้ว', files: [{ name: 'done.mp4', createdAt: 3000 }] },
  ]
  const out = P.videosToEnroll(videos, [{ slug: 'done', file: 'done.mp4' }], 1000)
  assert.deepEqual(out.map((v) => v.slug), ['new'])
  assert.deepEqual(P.videosToEnroll(videos, [], null), [], 'ปิดโหมด = ไม่ดึงอะไรเลย')
})

await test('ปลายทางตามหมวด: ไม่เลือกหมวด = รับทุกหมวด · คลิปไม่รู้หมวดไปเฉพาะบัญชีที่รับทุกหมวด', () => {
  const data = {
    facebook: [{ id: 'all' }, { id: 'space', categories: ['อวกาศ & จักรวาล'] }],
    youtube: [{ id: 'dino', refreshToken: 'r', categories: ['ไดโนเสาร์ & โลกดึกดำบรรพ์'] }, { id: 'off', categories: [] }],
  }
  // 2 เพจรับหมวดนี้ แต่กฎห้ามโพสต์ซ้ำให้ลงได้เพจเดียวต่อแพลตฟอร์ม (ยังไม่มีประวัติ = เพจแรก)
  assert.deepEqual(P.targetsFor(data, 'อวกาศ & จักรวาล'), ['fb:all'])
  assert.deepEqual(P.targetsFor(data, 'ไดโนเสาร์ & โลกดึกดำบรรพ์'), ['fb:all', 'yt:dino'])
  assert.deepEqual(P.targetsFor(data, null), ['fb:all'], 'ช่องที่ไม่ได้เชื่อมต่อ (ไม่มี refreshToken) ไม่นับ')
  assert.deepEqual(P.cleanCategories(['อวกาศ & จักรวาล', 'มั่ว', 'อวกาศ & จักรวาล']), ['อวกาศ & จักรวาล'])
})

await test('ข้อมูลบัญชีที่ส่งให้แผงข้าง ไม่มีโทเค็นเต็ม', () => {
  const view = P.publicAccounts({
    settings: { ...P.DEFAULT_SETTINGS, google: { clientId: 'x.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret1234' } },
    facebook: [{ id: 'a', name: 'เพจ', pageId: '123456', token: 'EAAB-very-secret-token-9876' }],
    youtube: [{ id: 'b', name: 'ช่อง', refreshToken: '1//refresh-secret' }],
  })
  const text = JSON.stringify(view)
  assert.ok(!text.includes('very-secret') && !text.includes('refresh-secret') && !text.includes('GOCSPX-secret'))
  assert.equal(view.facebook[0].token, '••••9876')
  assert.equal(view.youtube[0].connected, true)
})

// ── คำขอที่ส่งไป Facebook / YouTube (fetch ปลอม) ──
const S = await import('../pipeline/lib/social.mjs')
const sample = join(tmp, 'sample.mp4')
writeFileSync(sample, Buffer.alloc(2048, 1))
const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

await test('Facebook: อัปโหลดไป graph-video ของเพจ พร้อมไฟล์ + คำบรรยาย', async () => {
  const calls = []
  const out = await S.facebookUpload({ pageId: '42', token: 'tok', file: sample, title: 'ชื่อ', description: 'บรรยาย' }, {
    fetchImpl: async (url, init) => (calls.push({ url, init }), reply(200, { id: '777' })),
  })
  assert.match(calls[0].url, /^https:\/\/graph-video\.facebook\.com\/v\d+\.0\/42\/videos$/)
  assert.equal(calls[0].init.body.get('description'), 'บรรยาย')
  assert.equal(calls[0].init.body.get('source').size, 2048)
  assert.equal(out.url, 'https://www.facebook.com/42/videos/777')
})

await test('Facebook: โทเค็นหมดอายุ → error ภาษาไทยบอกวิธีแก้', async () => {
  await assert.rejects(
    S.facebookPageInfo({ pageId: '42', token: 'x' }, { fetchImpl: async () => reply(400, { error: { message: 'Error validating access token', code: 190 } }) }),
    /โทเค็นหมดอายุ/,
  )
})

await test('YouTube: ขอ token ใหม่ → เปิด resumable upload → ส่งไฟล์', async () => {
  const calls = []
  const out = await S.youtubeUpload({ clientId: 'c', clientSecret: 's', refreshToken: 'r', file: sample, title: 'ชื่อ <ทดสอบ>', description: 'd', tags: ['#ยุง'], privacy: 'unlisted' }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url.includes('oauth2')) return reply(200, { access_token: 'at' })
      if (url.includes('uploadType=resumable')) return reply(200, {}, { location: 'https://upload.example/session1' })
      return reply(200, { id: 'abc', status: { privacyStatus: 'unlisted' } })
    },
  })
  assert.equal(calls.length, 3)
  const meta = JSON.parse(calls[1].init.body)
  assert.equal(meta.snippet.title, 'ชื่อ ทดสอบ', 'YouTube ไม่รับ < >')
  assert.deepEqual(meta.snippet.tags, ['ยุง'])
  assert.equal(meta.status.privacyStatus, 'unlisted')
  assert.equal(calls[1].init.headers['x-upload-content-length'], '2048')
  assert.equal(calls[2].url, 'https://upload.example/session1')
  assert.equal(calls[2].init.method, 'PUT')
  assert.equal(out.url, 'https://www.youtube.com/watch?v=abc')
})

await test('YouTube: โควตาหมด → บอกว่าลองพรุ่งนี้', async () => {
  await assert.rejects(
    S.youtubeUpload({ clientId: 'c', clientSecret: 's', refreshToken: 'r', file: sample, title: 't' }, {
      fetchImpl: async (url) => (url.includes('oauth2') ? reply(200, { access_token: 'at' }) : reply(403, { error: { message: 'The request cannot be completed because you have exceeded your quota.' } })),
    }),
    /ลองใหม่พรุ่งนี้/,
  )
})

await test('Drive: โฟลเดอร์เดิมถูกลบ → สร้างใหม่ แล้วอัปแบบ resumable เข้าโฟลเดอร์นั้น', async () => {
  const calls = []
  const out = await S.driveUpload({ clientId: 'c', clientSecret: 's', refreshToken: 'r', folderId: 'oldFolder', file: sample, name: 'คลิป.mp4' }, {
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init })
      if (url.includes('oauth2')) return reply(200, { access_token: 'at' })
      if (url.includes('/files/oldFolder')) return reply(200, { id: 'oldFolder', trashed: true })
      if (url.endsWith('/files?fields=id')) return reply(200, { id: 'newFolder' })
      if (url.includes('uploadType=resumable')) return reply(200, {}, { location: 'https://upload.example/drive1' })
      return reply(200, { id: 'file9', webViewLink: 'https://drive.google.com/file/d/file9/view' })
    },
  })
  const create = calls.find((c) => c.url.endsWith('/files?fields=id'))
  assert.equal(JSON.parse(create.init.body).mimeType, 'application/vnd.google-apps.folder')
  const meta = JSON.parse(calls.find((c) => c.url.includes('uploadType=resumable')).init.body)
  assert.deepEqual(meta.parents, ['newFolder'])
  assert.equal(out.fileId, 'file9')
  assert.equal(out.folderId, 'newFolder')
})

await test('Drive: ลบ = ย้ายไปถังขยะ · ไฟล์หายไปแล้ว (404) ไม่นับว่าพลาด', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => (calls.push({ url, init }), url.includes('oauth2') ? reply(200, { access_token: 'at' }) : url.includes('gone') ? reply(404, { error: { message: 'File not found' } }) : reply(200, { id: 'x' }))
  await S.driveTrash({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fileId: 'x' }, { fetchImpl })
  const patch = calls.find((c) => c.init.method === 'PATCH')
  assert.deepEqual(JSON.parse(patch.init.body), { trashed: true }, 'ต้องย้ายลงถังขยะ ไม่ลบถาวร')
  assert.deepEqual(await S.driveTrash({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fileId: 'gone' }, { fetchImpl }), { gone: true })
})

// ── bridge + คิวจริง (Facebook/YouTube ปลอม) ──
const SLUG = '_posttest'
const projectDir = join(ROOT, 'projects', SLUG)
rmSync(projectDir, { recursive: true, force: true })
mkdirSync(join(projectDir, '06_render'), { recursive: true })
mkdirSync(join(projectDir, '01_script'), { recursive: true })
const video = join(projectDir, '06_render', `${SLUG}.mp4`)
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=320x568:d=4', '-pix_fmt', 'yuv420p', video])
writeFileSync(join(projectDir, '01_script', 'post.json'), JSON.stringify({ titles: ['ชื่อหนึ่ง', 'ชื่อสอง'], description: 'คำบรรยาย', hashtags: ['#ยุง', '#สาระ'] }))
writeFileSync(join(projectDir, '01_script', 'script_test.txt'), 'บทพากย์ทดสอบ')

const TOKEN = 'test-token'
const jobs = new Map()
const enqueued = []
const uploads = []
let youtubeFails = true
const driveCalls = []
const fakeVideos = async () => [{ slug: SLUG, title: 'คลิปทดสอบ', thumb: null, post: null, updatedAt: Date.now(), files: [{ name: `${SLUG}.mp4`, main: true, url: '/files/x', seconds: 4, createdAt: Date.now() }] }]
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
const server = createServer()
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const posting = createPosting({
  jobs, json, readBody, port, token: TOKEN, log: (s) => logs.push(s),
  enqueue: (agent, kind, payload) => {
    const job = { id: `job${enqueued.length + 1}`, agent, kind, payload, status: 'queued' }
    jobs.set(job.id, job)
    enqueued.push(job)
    return job
  },
  deps: {
    listVideos: fakeVideos,
    facebookPageInfo: async ({ pageId, token }) => {
      if (token === 'bad-token-xxxxxxxxxxxxxxxx') throw new Error('Facebook: Invalid OAuth access token')
      return { id: pageId, name: 'เพจทดสอบ' }
    },
    facebookUpload: async (args) => {
      uploads.push({ kind: 'fb', ...args })
      return { postId: '999', url: `https://www.facebook.com/${args.pageId}/videos/999` }
    },
    youtubeConnect: async ({ code }) => ({ refreshToken: `rt-${code}`, channelId: 'UC123', name: 'ช่องทดสอบ' }),
    driveConnect: async ({ code, clientId }) => (assert.equal(clientId, '999-drive.apps.googleusercontent.com'), { refreshToken: `drt-${code}`, email: 'me@example.com', name: 'ฉัน' }),
    driveUpload: async (args) => {
      driveCalls.push({ op: 'upload', ...args })
      return { fileId: `f${driveCalls.length}`, link: `https://drive.google.com/file/d/f${driveCalls.length}/view`, folderId: 'fold1' }
    },
    driveTrash: async (args) => {
      driveCalls.push({ op: 'trash', ...args })
      return { trashed: true }
    },
    youtubeUpload: async (args) => {
      uploads.push({ kind: 'yt', ...args })
      if (youtubeFails) throw new Error('YouTube: quota exceeded')
      return { postId: 'vid1', url: 'https://www.youtube.com/watch?v=vid1' }
    },
  },
})
server.on('request', async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`)
  if (!(await posting.handle(req, res, url))) json(res, 404, { error: 'ไม่ใช่ของโหมดโพสต์' })
})

const base = `http://127.0.0.1:${port}`
async function call(path, body, { token = TOKEN, expect = 200 } = {}) {
  const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-bridge-token': token }, body: body && JSON.stringify(body) })
  const data = await res.json()
  assert.equal(res.status, expect, `${path} ควรได้ ${expect} แต่ได้ ${res.status}: ${data.error ?? ''}`)
  return data
}

try {
  await test('ไม่มี token = เข้าไม่ได้ · endpoint อื่นของ bridge ไม่ถูกแย่ง', async () => {
    await call('/api/posting', null, { token: 'wrong', expect: 401 })
    const res = await fetch(`${base}/api/state`, { headers: { 'x-bridge-token': TOKEN } })
    assert.equal(res.status, 404, 'path ที่ไม่ใช่ /api/posting ต้องปล่อยให้ ui.js ตอบ')
  })

  await test('เปิดโหมด + ช่องเวลา', async () => {
    const v = await call('/api/posting/settings', { enabled: true, slots: '19:00,12:00', autoCheck: false })
    assert.ok(v.settings.enabledAt)
    assert.deepEqual(v.settings.slots, ['12:00', '19:00'])
  })

  await test('เพิ่มเพจ: โทเค็นเสียไม่บันทึก · โทเค็นดีบันทึก (ไม่ส่งโทเค็นกลับ)', async () => {
    await call('/api/posting/facebook', { pageId: '1234567', token: 'bad-token-xxxxxxxxxxxxxxxx' }, { expect: 500 })
    const v = await call('/api/posting/facebook', { pageId: '1234567', token: 'good-token-abcdefghij1234' })
    assert.equal(v.facebook.length, 1)
    assert.equal(v.facebook[0].name, 'เพจทดสอบ')
    assert.equal(v.facebook[0].token, '••••1234')
    await call('/api/posting/facebook', { pageId: 'abc', token: 'good-token-abcdefghij1234' }, { expect: 400 })
  })

  await test('เชื่อมช่อง YouTube: ต้องมี client ก่อน · state ผิดไม่รับ · state ถูกได้ช่อง', async () => {
    await call('/api/posting/youtube/connect', {}, { expect: 400 })
    await call('/api/posting/google', { clientId: 'abc', clientSecret: 's' }, { expect: 400 })
    await call('/api/posting/google', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-zzzz' })
    const { url } = await call('/api/posting/youtube/connect', {})
    const state = new URL(url).searchParams.get('state')
    assert.equal(new URL(url).searchParams.get('redirect_uri'), base)
    const wrong = await fetch(`${base}/?state=nope&code=x`)
    assert.equal(wrong.status, 404, 'state ที่ไม่ได้ขอไว้ ต้องไม่ถูกรับ (ปล่อยให้หน้า UI ปกติ)')
    const ok = await fetch(`${base}/?state=${state}&code=abc`)
    assert.equal(ok.status, 200)
    const again = await fetch(`${base}/?state=${state}&code=abc`)
    assert.equal(again.status, 404, 'state ใช้ได้ครั้งเดียว')
    const v = await call('/api/posting')
    assert.equal(v.youtube[0].name, 'ช่องทดสอบ')
    assert.equal(v.youtube[0].connected, true)
    assert.ok(!JSON.stringify(v).includes('rt-abc'), 'ห้ามส่ง refresh token ให้แผงข้าง')
  })

  let id
  await test('คลิปที่เสร็จหลังเปิดโหมดเข้าคิวเอง พร้อมข้อความโพสต์และติ๊กทุกปลายทาง', async () => {
    const v = await call('/api/posting')
    assert.equal(v.queue.length, 1)
    const item = v.queue[0]
    id = item.id
    assert.equal(item.status, 'review')
    assert.equal(item.post.title, 'ชื่อหนึ่ง')
    assert.deepEqual(item.post.hashtags, ['#ยุง', '#สาระ'])
    assert.equal(item.targets.length, 2, 'ติ๊กทั้งเพจและช่อง')
    assert.equal(v.library.length, 0, 'คลิปที่อยู่ในคิวแล้วไม่ขึ้นในรายการเพิ่มจากคลัง')
  })

  await test('AI ตรวจ: ส่ง ChatGPT แชตใหม่พร้อมเฟรม 8 ภาพ แล้วอ่านผลกลับ', async () => {
    await call('/api/posting/check', { id })
    assert.equal(enqueued.length, 1)
    const job = enqueued[0]
    assert.equal(job.agent, 'chatgpt')
    assert.equal(job.payload.newChat, true)
    assert.equal(job.payload.attachments.length, 8)
    assert.ok(job.payload.prompt.includes('บทพากย์ทดสอบ'))
    job.status = 'done'
    job.result = { text: '{"score": 88, "verdict": "pass", "summary": "ดี", "issues": []}' }
    const v = await call('/api/posting')
    assert.equal(v.queue[0].ai.status, 'done')
    assert.equal(v.queue[0].ai.score, 88)
  })

  await test('แก้ข้อความโพสต์ + เลือกปลายทาง (ปลายทางมั่วถูกตัดทิ้ง)', async () => {
    const v0 = await call('/api/posting')
    const fbKey = v0.queue[0].targets.find((k) => k.startsWith('fb:'))
    const ytKey = v0.queue[0].targets.find((k) => k.startsWith('yt:'))
    const v = await call('/api/posting/item', { id, post: { title: 'ชื่อใหม่', description: 'บรรยายใหม่', hashtags: 'a #b' }, targets: [fbKey, ytKey, 'fb:fake'] })
    assert.equal(v.queue[0].post.title, 'ชื่อใหม่')
    assert.deepEqual(v.queue[0].post.hashtags, ['#a', '#b'])
    assert.deepEqual(v.queue[0].targets, [fbKey, ytKey])
  })

  await test('อนุมัติแบบช่องเวลาถัดไป → ยกเลิกเวลา → กลับไปรอตรวจ', async () => {
    let v = await call('/api/posting/approve', { id, when: 'next' })
    assert.equal(v.queue[0].status, 'scheduled')
    assert.ok(v.queue[0].scheduleAt > Date.now())
    v = await call('/api/posting/unschedule', { id })
    assert.equal(v.queue[0].status, 'review')
    await call('/api/posting/approve', { id, when: Date.now() - 3600_000 }, { expect: 400 })
  })

  await test('โพสต์ทันที: Facebook ได้ · YouTube พลาด → สถานะโพสต์ไม่สำเร็จ พร้อมเหตุผล', async () => {
    await call('/api/posting/approve', { id, when: 'now' })
    await posting.tick()
    const v = await call('/api/posting')
    const item = v.queue[0]
    assert.equal(item.status, 'failed')
    assert.match(item.error, /quota/)
    const fb = uploads.find((u) => u.kind === 'fb')
    assert.equal(fb.title, 'ชื่อใหม่')
    assert.equal(fb.description, 'บรรยายใหม่\n\n#a #b')
    assert.ok(existsSync(fb.file))
    const yt = uploads.find((u) => u.kind === 'yt')
    assert.equal(yt.refreshToken, 'rt-abc', 'bridge ใช้ refresh token ตัวจริงตอนอัปโหลด')
    assert.equal(Object.values(item.results).filter((r) => r.ok).length, 1)
  })

  await test('ลองใหม่: โพสต์เฉพาะที่พลาด ไม่โพสต์ Facebook ซ้ำ', async () => {
    youtubeFails = false
    const before = uploads.filter((u) => u.kind === 'fb').length
    await call('/api/posting/retry', { id })
    await posting.tick()
    let v = await call('/api/posting')
    assert.equal(v.queue[0].status, 'scheduled', 'เพิ่งโพสต์ Facebook ไป → รอให้ครบ 30 นาทีก่อน ไม่โพสต์รัว')
    // จำลองว่าโพสต์ล่าสุดผ่านไป 31 นาทีแล้ว
    const queue = P.loadQueue()
    for (const q of queue) for (const r of Object.values(q.results ?? {})) if (r?.ok) r.at = Date.now() - 31 * 60_000
    P.saveQueue(queue)
    await posting.tick()
    v = await call('/api/posting')
    assert.equal(v.queue[0].status, 'posted')
    assert.equal(uploads.filter((u) => u.kind === 'fb').length, before, 'Facebook ต้องไม่ถูกโพสต์ซ้ำ')
    assert.ok(Object.values(v.queue[0].results).every((r) => r.ok && r.url))
    await call('/api/posting/item', { id, post: { title: 'แก้หลังโพสต์' } }, { expect: 500 })
  })

  await test('ตีกลับ / ดึงกลับ / ลบออกจากคิว · เพิ่มคืนจากคลังได้', async () => {
    let v = await call('/api/posting/remove', { id })
    assert.equal(v.queue.length, 0)
    assert.equal(v.library.length, 1)
    v = await call('/api/posting/add', { slug: SLUG, file: `${SLUG}.mp4` })
    const again = v.queue[0].id
    v = await call('/api/posting/reject', { id: again, reason: 'ภาพเพี้ยน' })
    assert.equal(v.queue[0].status, 'rejected')
    v = await call('/api/posting/restore', { id: again })
    assert.equal(v.queue[0].status, 'review')
    await call('/api/posting/add', { slug: '../etc', file: 'x.mp4' }, { expect: 400 })
  })

  await test('ลบบัญชี → ปลายทางนั้นหายจากคิวที่ยังไม่โพสต์', async () => {
    const v0 = await call('/api/posting')
    const v = await call('/api/posting/facebook/remove', { id: v0.facebook[0].id })
    assert.equal(v.facebook.length, 0)
    assert.ok(v.queue[0].targets.every((k) => k.startsWith('yt:')))
  })

  await test('Drive: เชื่อมต่อ → คลิปในคิวขึ้น Drive เอง → ตีกลับแล้วย้ายลงถังขยะ', async () => {
    let v = await call('/api/posting')
    assert.equal(v.settings.drive.connected, false)
    // Drive ใช้ client ของตัวเอง — มี client ของ YouTube แล้วก็ยังเชื่อม Drive ไม่ได้จนกว่าจะใส่ของ Drive
    await call('/api/posting/drive/connect', {}, { expect: 400 })
    v = await call('/api/posting/drive/client', { clientId: '999-drive.apps.googleusercontent.com', clientSecret: 'GOCSPX-drive-secret' })
    assert.equal(v.settings.driveClient.ready, true)
    assert.equal(v.settings.driveClient.clientSecret, '••••cret')
    assert.equal(v.settings.google.clientId, '123-abc.apps.googleusercontent.com', 'client ของ YouTube ต้องไม่ถูกเปลี่ยน')
    const { url } = await call('/api/posting/drive/connect', {})
    assert.equal(new URL(url).searchParams.get('client_id'), '999-drive.apps.googleusercontent.com', 'หน้าเชื่อมต่อ Drive ต้องใช้ client ของ Drive')
    assert.match(new URL(url).searchParams.get('scope'), /drive.file/)
    const ok = await fetch(`${base}/?state=${new URL(url).searchParams.get('state')}&code=x1`)
    assert.equal(ok.status, 200)
    v = await call('/api/posting')
    assert.equal(v.settings.drive.connected, true)
    assert.equal(v.settings.drive.email, 'me@example.com')
    assert.ok(!JSON.stringify(v).includes('drt-x1'), 'ห้ามส่ง refresh token ของ Drive ให้แผงข้าง')

    await posting.syncDrive()
    const up = driveCalls.find((c) => c.op === 'upload')
    assert.ok(up, 'คลิปที่รอตรวจต้องขึ้น Drive')
    assert.equal(up.refreshToken, 'drt-x1')
    assert.equal(up.clientId, '999-drive.apps.googleusercontent.com', 'อัป Drive ด้วย client ของ Drive')
    v = await call('/api/posting')
    const item = v.queue[0]
    assert.ok(item.drive.fileId)
    assert.equal(v.settings.drive.folderLink, 'https://drive.google.com/drive/folders/fold1', 'จำโฟลเดอร์ไว้ใช้ครั้งต่อไป')

    await posting.syncDrive()
    assert.equal(driveCalls.filter((c) => c.op === 'upload').length, 1, 'ขึ้นแล้วไม่อัปซ้ำ')

    await call('/api/posting/reject', { id: item.id, reason: 'ทดสอบ' })
    await posting.syncDrive()
    const trash = driveCalls.find((c) => c.op === 'trash')
    assert.equal(trash.fileId, item.drive.fileId)
    v = await call('/api/posting')
    assert.ok(v.queue[0].drive.removedAt)
    assert.ok(!v.queue[0].drive.fileId)
  })

  await test('Drive: โพสต์ครบแล้วลบจาก Drive · เลิกเชื่อมต่อแล้วไม่แตะ Drive อีก', async () => {
    let v = await call('/api/posting/restore', { id: (await call('/api/posting')).queue[0].id })
    const id = v.queue[0].id
    await posting.syncDrive() // ขึ้น Drive ใหม่อีกรอบ (เพราะกลับมารอโพสต์)
    v = await call('/api/posting')
    assert.ok(v.queue[0].drive.fileId)
    const fileId = v.queue[0].drive.fileId
    youtubeFails = false
    // คลิปทดสอบนี้เคยโพสต์ไปแล้วในข้อก่อน — ข้อนี้ทดสอบ Drive ไม่ใช่กฎห้ามโพสต์ซ้ำ จึงล้างสมุดบันทึกและผลเดิมก่อน
    rmSync(join(tmp, 'posted.json'), { force: true })
    P.saveQueue(P.loadQueue().map((q) => (q.id === id ? { ...q, results: {} } : q)))
    await call('/api/posting/item', { id, resetTargets: true })
    await call('/api/posting/approve', { id, when: 'now' })
    await posting.tick()
    v = await call('/api/posting')
    assert.equal(v.queue[0].status, 'posted')
    assert.ok(driveCalls.some((c) => c.op === 'trash' && c.fileId === fileId), 'โพสต์ครบต้องลบจาก Drive')
    // เปลี่ยน client ของ Drive → การเชื่อมต่อเดิมใช้ไม่ได้ ต้องเชื่อมต่อใหม่
    v = await call('/api/posting/drive/client', { clientId: '888-other.apps.googleusercontent.com', clientSecret: '••••cret' })
    assert.equal(v.settings.drive.connected, false)
    v = await call('/api/posting/drive/remove', {})
    assert.equal(v.settings.drive.connected, false)
    const before = driveCalls.length
    await posting.syncDrive()
    assert.equal(driveCalls.length, before)
  })

  await test('หมวด: AI ระบุหมวด → เลือกเพจตามหมวด · เลือกหมวดเอง · ติ๊กเองแล้วไม่ถูกเปลี่ยน · กลับไปเลือกตามหมวด', async () => {
    const SPACE = 'อวกาศ & จักรวาล'
    const DINO = 'ไดโนเสาร์ & โลกดึกดำบรรพ์'
    await call('/api/posting/facebook', { pageId: '7000001', token: 'good-token-dino-page-0001', name: 'เพจไดโนเสาร์' })
    let v = await call('/api/posting/facebook', { pageId: '7000002', token: 'good-token-space-page-002', name: 'เพจอวกาศ' })
    const dinoPage = v.facebook.find((a) => a.pageId === '7000001').id
    const spacePage = v.facebook.find((a) => a.pageId === '7000002').id
    const yt = v.youtube[0].id
    await call('/api/posting/account/categories', { kind: 'facebook', id: dinoPage, categories: [DINO, 'มั่ว'] })
    v = await call('/api/posting/account/categories', { kind: 'facebook', id: spacePage, categories: [SPACE] })
    assert.deepEqual(v.facebook.find((a) => a.id === dinoPage).categories, [DINO], 'หมวดมั่วถูกตัดทิ้ง')
    assert.equal(v.categories.length > 20, true, 'ส่งรายการหมวดให้หน้าจอ')

    // คลิปใหม่ ยังไม่รู้หมวด → ลงเฉพาะช่องที่รับทุกหมวด
    // (ใช้คลิปทดสอบตัวเดิมที่โพสต์ไปแล้วในข้อก่อน — ข้อนี้ทดสอบหมวด จึงล้างสมุดบันทึกห้ามโพสต์ซ้ำก่อน)
    rmSync(join(tmp, 'posted.json'), { force: true })
    await call('/api/posting/remove', { id: v.queue[0].id })
    v = await call('/api/posting/add', { slug: SLUG, file: `${SLUG}.mp4` })
    const id = v.queue.find((q) => q.status === 'review').id
    let item = v.queue.find((q) => q.id === id)
    assert.deepEqual(item.targets, [`yt:${yt}`])

    // AI ระบุหมวดอวกาศ → เพจอวกาศ + ช่องที่รับทุกหมวด
    await call('/api/posting/check', { id })
    const job = enqueued.at(-1)
    assert.match(job.payload.prompt, /category/)
    job.status = 'done'
    job.result = { text: `{"score": 90, "verdict": "pass", "summary": "ดี", "issues": [], "category": "${SPACE}"}` }
    v = await call('/api/posting')
    item = v.queue.find((q) => q.id === id)
    assert.equal(item.category, SPACE)
    assert.equal(item.categoryBy, 'ai')
    assert.deepEqual(item.targets.sort(), [`fb:${spacePage}`, `yt:${yt}`].sort())

    // เลือกหมวดเอง → เพจไดโนเสาร์แทน
    v = await call('/api/posting/item', { id, category: DINO })
    item = v.queue.find((q) => q.id === id)
    assert.equal(item.categoryBy, 'manual')
    assert.deepEqual(item.targets.sort(), [`fb:${dinoPage}`, `yt:${yt}`].sort())

    // ติ๊กเอง → เปลี่ยนหมวดแล้วปลายทางไม่ถูกเปลี่ยน
    await call('/api/posting/item', { id, targets: [`fb:${spacePage}`] })
    v = await call('/api/posting/item', { id, category: SPACE })
    item = v.queue.find((q) => q.id === id)
    assert.equal(item.targetsEdited, true)
    assert.deepEqual(item.targets, [`fb:${spacePage}`])
    // เปลี่ยนหมวดของบัญชี → คลิปที่ติ๊กเองไม่ถูกแตะ
    v = await call('/api/posting/account/categories', { kind: 'facebook', id: dinoPage, categories: [] })
    assert.deepEqual(v.queue.find((q) => q.id === id).targets, [`fb:${spacePage}`])

    // กลับไปเลือกตามหมวด → เพจไดโนเสาร์ตอนนี้รับทุกหมวดแล้ว รับคลิปอวกาศได้ทั้ง 2 เพจ
    // แต่กฎห้ามโพสต์ซ้ำ: Facebook ได้เพจเดียว (1 ใน 2 เพจนี้) + YouTube 1 ช่อง
    v = await call('/api/posting/item', { id, resetTargets: true })
    item = v.queue.find((q) => q.id === id)
    assert.equal(item.targetsEdited, false)
    const fbTargets = item.targets.filter((k) => k.startsWith('fb:'))
    assert.equal(fbTargets.length, 1, 'Facebook ได้เพจเดียวต่อคลิป')
    assert.ok([`fb:${dinoPage}`, `fb:${spacePage}`].includes(fbTargets[0]))
    assert.ok(item.targets.includes(`yt:${yt}`))
    // ติ๊กเองสองเพจ Facebook พร้อมกัน → ไม่ยอม
    await call('/api/posting/item', { id, targets: [`fb:${dinoPage}`, `fb:${spacePage}`] }, { expect: 500 })
  })

  await test('ปิดโปรแกรมกลางการโพสต์ → เปิดใหม่ไม่โพสต์ซ้ำเอง (เป็นโพสต์ไม่สำเร็จ)', async () => {
    const q = P.loadQueue()
    q[0].status = 'posting'
    P.saveQueue(q)
    createPosting({ jobs, enqueue: () => {}, json, readBody, log: () => {}, port: 1, token: 'x', deps: { listVideos: fakeVideos } })
    assert.equal(P.loadQueue()[0].status, 'failed')
    assert.match(P.loadQueue()[0].error, /ปิดระหว่างโพสต์/)
  })

  console.log(`\nผ่าน ${passed} ข้อ`)
} finally {
  server.close()
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(0)
