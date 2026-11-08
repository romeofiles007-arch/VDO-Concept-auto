// เทสต์: กด "อัปเดตเลย" ตอนมีงานค้าง → แผงต้องเห็นเหตุผลจริง ไม่ใช่ "โปรแกรมในเครื่องตอบ 409"
//   node scripts/test-update-busy.mjs
// เคยเป็น: bridge ใส่ error แล้วเอาสถานะตัวอัปเดต (error: null) ทับ → แผงไม่รู้ว่าทำไมอัปเดตไม่ได้
// ไม่ต่อ GitHub จริง — ตัวอัปเดตแบบแพ็กเกจใช้ fetch ปลอมในโฟลเดอร์ temp
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createPackageUpdater } from '../bridge/update-package.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const fetchFn = async (url) => {
  if (url.includes('/info/refs')) return new Response(`001e# service=git-upload-pack\n0000${'0'.repeat(4)}${NEW} refs/heads/main\0 side-band\n`, { status: 200 })
  return new Response('<feed></feed>', { status: 200 })
}

await test('มีงานค้าง → ข้อความบอกว่างานอะไรค้าง (ไม่ใช่แค่ "มีงานค้าง")', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'update-busy-'))
  try {
    writeFileSync(join(dir, 'VERSION.json'), JSON.stringify({ commit: OLD.slice(0, 7), sha: OLD, repo: 'https://github.com/x/y', branch: 'main' }))
    const u = createPackageUpdater({ cwd: dir, schedule: false, fetchFn, busy: () => 'AI กำลังตรวจคลิปในคิวโพสต์' })
    await assert.rejects(u.apply(), /AI กำลังตรวจคลิปในคิวโพสต์/)
    const plain = createPackageUpdater({ cwd: dir, schedule: false, fetchFn, busy: () => true })
    await assert.rejects(plain.apply(), /มีงานค้าง/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await test('bridge: ตอบ 409 แล้วเหตุผลต้องไม่ถูกสถานะตัวอัปเดตทับ', () => {
  const ui = readFileSync(join(ROOT, 'bridge', 'ui.js'), 'utf8')
  assert.match(ui, /json\(res, 409, \{ \.\.\.updater\.snapshot\(\), error: err\.message \}\)/)
})

await test('bridge: บอกตัวอัปเดตว่างานอะไรค้าง (ทำคลิป / AI ตรวจ / โพสต์)', () => {
  const server = readFileSync(join(ROOT, 'bridge', 'server.js'), 'utf8')
  assert.match(server, /createUpdater\(\{ log, busy: \(\) => busyReason\(\) \}\)/)
  assert.match(server, /AI กำลังตรวจคลิปในคิวโพสต์/)
})

console.log(`\nผ่าน ${passed} ข้อ`)
