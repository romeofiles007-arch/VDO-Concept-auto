// เทสต์: ป้ายเจ้าของแท็บ ChatGPT/Flow กันสองระบบในโปรไฟล์ Chrome เดียวกันใช้แท็บเดียวกัน
//   node scripts/test-tab-claim.mjs
// 23 พ.ย. 2026: ธรรมะ Auto กับ Cartoon Auto อยู่โปรไฟล์ Default ด้วยกัน ส่ง prompt ลงแท็บ ChatGPT แท็บเดียวกัน
//   → ธรรมะได้บท/shot list เรื่องนักบินอวกาศของ Cartoon ไปทั้งก้อน
import assert from 'node:assert/strict'
import { createTabClaims, CLAIM_KEY, CLAIM_TTL_MS } from '../extension/tab-claim.js'

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/** หน้าเว็บจำลอง: sessionStorage แยกต่อแท็บ ใช้ร่วมกันทุก extension (แบบหน้าเว็บจริง) */
function makeBrowser({ unreadable = [] } = {}) {
  const pages = new Map()
  const storage = (tabId) => {
    if (!pages.has(tabId)) pages.set(tabId, new Map())
    const m = pages.get(tabId)
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
  }
  const scripting = {
    executeScript: async ({ target: { tabId }, func, args = [] }) => {
      await new Promise((r) => setImmediate(r)) // ข้ามไปมาระหว่างสอง extension เหมือนของจริง
      if (unreadable.includes(tabId)) throw new Error('Cannot access contents of the page')
      const saved = globalThis.sessionStorage
      globalThis.sessionStorage = storage(tabId)
      try {
        return [{ result: func(...args) }]
      } finally {
        globalThis.sessionStorage = saved
      }
    },
  }
  return { scripting, raw: (tabId) => pages.get(tabId)?.get(CLAIM_KEY) ?? null }
}

let clock = 1_000_000
const now = () => clock
const ext = (browser, id) => createTabClaims({ scripting: browser.scripting, id, name: id, now, settleMs: 5 })

await test('แท็บที่ระบบอื่นถืออยู่ → ไม่ถูกเลือก และติดป้ายแย่งไม่ได้', async () => {
  const b = makeBrowser()
  const dhamma = ext(b, 'dhamma')
  const cartoon = ext(b, 'cartoon')
  assert.equal(await cartoon.claim(5), true)
  assert.deepEqual((await dhamma.free([{ id: 5 }, { id: 6 }])).map((t) => t.id), [6])
  assert.equal(await dhamma.claim(5), false)
  assert.equal(JSON.parse(b.raw(5)).id, 'cartoon', 'ป้ายเดิมต้องไม่ถูกทับ')
})

await test('แท็บของตัวเอง (ป้ายของเรา) ยังใช้ซ้ำได้ทุกงาน', async () => {
  const b = makeBrowser()
  const dhamma = ext(b, 'dhamma')
  assert.equal(await dhamma.claim(5), true)
  assert.deepEqual((await dhamma.free([{ id: 5 }])).map((t) => t.id), [5])
  assert.equal(await dhamma.claim(5), true)
})

await test('ป้ายที่ไม่ต่ออายุเกินกำหนด (ระบบนั้นปิด/ค้าง) = ว่าง ใช้ต่อได้', async () => {
  const b = makeBrowser()
  const cartoon = ext(b, 'cartoon')
  const dhamma = ext(b, 'dhamma')
  await cartoon.claim(5)
  clock += CLAIM_TTL_MS + 1
  assert.equal(await dhamma.claim(5), true)
  assert.equal(JSON.parse(b.raw(5)).id, 'dhamma')
})

await test('ต่ออายุป้ายระหว่างงานยาว → ระบบอื่นยังเข้าไม่ได้แม้เลยเวลาเดิม', async () => {
  const b = makeBrowser()
  const cartoon = ext(b, 'cartoon')
  const dhamma = ext(b, 'dhamma')
  await cartoon.claim(5)
  clock += CLAIM_TTL_MS - 1000
  await cartoon.touch(5)
  clock += 2000
  assert.equal(await dhamma.claim(5), false)
  // touch ของคนอื่นไม่ทับป้ายเจ้าของ
  await dhamma.touch(5)
  assert.equal(JSON.parse(b.raw(5)).id, 'cartoon')
})

await test('งานจบ → ถอดป้ายของตัวเอง · ถอดป้ายของคนอื่นไม่ได้', async () => {
  const b = makeBrowser()
  const cartoon = ext(b, 'cartoon')
  const dhamma = ext(b, 'dhamma')
  await cartoon.claim(5)
  await dhamma.release(5)
  assert.equal(JSON.parse(b.raw(5)).id, 'cartoon')
  await cartoon.release(5)
  assert.equal(b.raw(5), null)
  assert.equal(await dhamma.claim(5), true)
})

await test('สองระบบติดป้ายแท็บเดียวกันพร้อมกัน → ได้ไประบบเดียวเท่านั้น', async () => {
  for (let round = 0; round < 20; round++) {
    const b = makeBrowser()
    const results = await Promise.all([ext(b, 'dhamma').claim(5), ext(b, 'cartoon').claim(5)])
    assert.equal(results.filter(Boolean).length, 1, `รอบ ${round}: ${results}`)
  }
})

await test('อ่านหน้าไม่ได้ (หน้ากำลังโหลด/ถูกพักไว้) → ไม่ให้งานล้ม ถือว่าว่าง', async () => {
  const b = makeBrowser({ unreadable: [9] })
  const dhamma = ext(b, 'dhamma')
  assert.deepEqual((await dhamma.free([{ id: 9 }])).map((t) => t.id), [9])
  assert.equal(await dhamma.claim(9), true)
})

console.log(`\nผ่าน ${passed} ข้อ`)
