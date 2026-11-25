// ปลุก Chrome — มีงานรอแต่ Chrome ที่ลง extension ปิดอยู่ → bridge เปิดให้เอง (ผู้ใช้ 25 พ.ย. 2026)
//   node --test scripts/test-chrome-wake.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createChromeWake, waitingAgent, findExtensionProfile, chromeExePath, WAKE } from '../bridge/chrome-wake.js'

const ID = 'odeogehiomlnlgododiodnoojdaofclp'
const job = (o) => ({ id: Math.random().toString(36), agent: 'chatgpt', status: 'queued', createdAt: 0, touchedAt: 0, ...o })
const mapOf = (...list) => new Map(list.map((j) => [j.id, j]))

test('งานรอ + extension เงียบเกิน 2 นาที → ปลุก · extension ยังมาถามหางาน → ไม่ปลุก', () => {
  const now = 10 * 60_000
  const jobs = mapOf(job({ agent: 'flow', createdAt: now - 60_000, touchedAt: now - 60_000 }))
  assert.equal(waitingAgent({ jobs, lastPoll: {}, now, since: 0 }), 'flow')
  assert.equal(waitingAgent({ jobs, lastPoll: { chatgpt: now - 30_000 } , now, since: 0 }), null, 'Chrome เปิดอยู่ ไม่ต้องปลุก')
  assert.equal(waitingAgent({ jobs, lastPoll: {}, now, since: 0, halted: true }), null, '⏹ หยุดทุกอย่างอยู่')
})

test('ไม่ปลุกเร็วเกิน: งานเพิ่งเข้าคิว / bridge เพิ่งเปิด (extension ยังไม่ทันมาถาม)', () => {
  const now = 10 * 60_000
  assert.equal(waitingAgent({ jobs: mapOf(job({ createdAt: now - 10_000, touchedAt: now - 10_000 })), lastPoll: {}, now, since: 0 }), null)
  assert.equal(waitingAgent({ jobs: mapOf(job()), lastPoll: {}, now, since: now - 60_000 }), null, 'bridge เพิ่งรีสตาร์ท')
})

test('ทั้งสองเว็บไม่ว่าง (ไม่มาถามหางาน) แต่ยังส่ง heartbeat → ถือว่า Chrome เปิดอยู่', () => {
  const now = 10 * 60_000
  const jobs = mapOf(job({ agent: 'flow', status: 'running', touchedAt: now - 20_000 }), job())
  assert.equal(waitingAgent({ jobs, lastPoll: { chatgpt: 0, flow: 0 }, now, since: 0 }), null)
})

test('งานกำพร้า (ไม่มีใครรอ) / งานที่ถูกยกเลิก → ไม่ปลุก Chrome มาทำ', () => {
  const now = 10 * 60_000
  assert.equal(waitingAgent({ jobs: mapOf(job({ watchedAt: now - WAKE.orphanMs - 1000 })), lastPoll: {}, now, since: 0 }), null)
  assert.equal(waitingAgent({ jobs: mapOf(job({ cancelled: true })), lastPoll: {}, now, since: 0 }), null)
  assert.equal(waitingAgent({ jobs: mapOf(job({ watchedAt: now - 1000 })), lastPoll: {}, now, since: 0 }), 'chatgpt', 'pipeline ยังรออยู่')
})

test('เปิด Chrome โปรไฟล์ที่ลง extension + หน้าโปรแกรม · ลองซ้ำทุก 4 นาที สูงสุด 3 ครั้ง · extension กลับมา → นับใหม่', async () => {
  let t = 0
  const lastPoll = {}
  const jobs = mapOf(job())
  const launched = []
  const logs = []
  const wake = createChromeWake({
    jobs,
    lastPoll,
    log: (m) => logs.push(m),
    url: 'http://127.0.0.1:8765/',
    now: () => t,
    exe: () => 'C:\\chrome.exe',
    profile: () => 'Profile 2',
    launch: async (exe, args) => (launched.push([exe, args]), true),
    timer: false,
  })
  t = WAKE.silentMs + 1000
  const r = await wake.tick()
  assert.deepEqual(launched, [['C:\\chrome.exe', ['--profile-directory=Profile 2', 'http://127.0.0.1:8765/']]])
  assert.equal(r.agent, 'chatgpt')
  t += 60_000
  await wake.tick()
  assert.equal(launched.length, 1, 'ยังไม่ครบ 4 นาที ไม่เปิดซ้ำ')
  for (let i = 0; i < 5; i++) {
    t += WAKE.retryMs
    await wake.tick()
  }
  assert.equal(launched.length, WAKE.maxTries, 'เลิกหลังครบจำนวนครั้ง ไม่เปิดหน้าต่างซ้ำทั้งคืน')
  assert.ok(logs.some((m) => /ยังไม่มารับงาน/.test(m)))

  // ผู้ใช้เปิด Chrome เอง extension มาถามหางาน → รอบหน้าที่ Chrome ปิดอีก ปลุกได้ใหม่
  lastPoll.chatgpt = t + 1
  t += 1000
  await wake.tick()
  assert.equal(wake.state().tries, 0)
  t += WAKE.silentMs + 1000
  await wake.tick()
  assert.equal(launched.length, WAKE.maxTries + 1)
})

test('ไม่พบโปรไฟล์ → เปิด Chrome โปรไฟล์ล่าสุด · ไม่พบ Chrome → บอกผู้ใช้ครั้งเดียว ไม่วนลอง', async () => {
  let t = 0
  const launched = []
  const logs = []
  const base = { jobs: mapOf(job()), lastPoll: {}, now: () => t, launch: async (e, a) => (launched.push(a), true), timer: false, log: (m) => logs.push(m) }
  const a = createChromeWake({ ...base, exe: () => 'chrome', profile: () => null })
  t = WAKE.silentMs + 1000
  await a.tick()
  assert.deepEqual(launched, [[]])
  const b = createChromeWake({ ...base, exe: () => null, profile: () => 'Default' })
  await b.tick()
  t += WAKE.retryMs * 2
  await b.tick()
  assert.equal(launched.length, 1)
  assert.equal(logs.filter((m) => /ไม่พบ Google Chrome/.test(m)).length, 1)
})

test('หาโปรไฟล์: เฉพาะ extension ที่โหลดจากโฟลเดอร์โปรแกรมนี้ · ข้ามตัวที่ถูกปิด · หลายโปรไฟล์เอาตัวที่ extension ทำงานล่าสุด', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-'))
  try {
    const mine = join(dir, 'app', 'extension')
    const other = join(dir, 'china', 'extension')
    mkdirSync(mine, { recursive: true })
    mkdirSync(other, { recursive: true })
    const data = join(dir, 'User Data')
    const profile = (name, ext, ranAt) => {
      const p = join(data, name)
      mkdirSync(p, { recursive: true })
      writeFileSync(join(p, 'Secure Preferences'), JSON.stringify({ extensions: { settings: ext ? { [ID]: ext } : {} } }))
      writeFileSync(join(p, 'Preferences'), '{}')
      if (ranAt) {
        const store = join(p, 'Local Extension Settings', ID)
        mkdirSync(store, { recursive: true })
        writeFileSync(join(store, '000003.log'), 'x')
        utimesSync(join(store, '000003.log'), ranAt, ranAt)
      }
    }
    profile('Default', { path: mine }, new Date('2026-09-01'))
    profile('Profile 1', { path: mine }, new Date('2026-11-24'))
    profile('Profile 2', { path: other }, new Date('2026-11-25')) // ระบบอื่น (ID ซ้ำไม่ได้จริง แต่กันไว้)
    profile('Profile 3', { path: mine, disable_reasons: [1] }, new Date('2026-11-25'))
    profile('Profile 4', null)
    profile('System Profile', { path: mine }, new Date('2026-11-26'))
    assert.equal(findExtensionProfile({ dataDir: data, id: ID, extensionDir: mine }), 'Profile 1')
    assert.equal(findExtensionProfile({ dataDir: data, id: ID, extensionDir: join(dir, 'nowhere') }), null)
    assert.equal(findExtensionProfile({ dataDir: join(dir, 'missing'), id: ID, extensionDir: mine }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ที่อยู่ Chrome: Windows / Mac / Linux (ไม่รองรับ)', () => {
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\U\\AppData\\Local' }
  assert.equal(chromeExePath('win32', env, (p) => p.startsWith('C:\\PF86')), join('C:\\PF86', 'Google', 'Chrome', 'Application', 'chrome.exe'))
  assert.equal(chromeExePath('darwin', {}, (p) => !p.includes('Users'), '/Users/a'), join('/Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'))
  assert.equal(chromeExePath('linux', {}, () => true), null)
})

test('bridge ตัวจริงต่อสายตัวปลุก Chrome ไว้ (port 8765 เท่านั้น)', () => {
  const server = readFileSync(new URL('../bridge/server.js', import.meta.url), 'utf8')
  assert.match(server, /if \(PORT === 8765\) \{[^}]*extension-id\.txt[\s\S]*?createChromeWake\(\{ jobs, lastPoll, halted: \(\) => halt\.on\(\)/)
})
