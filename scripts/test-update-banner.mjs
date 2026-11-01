// เทสต์: อัปเดตแล้วแผงยังเปิดค้าง แล้ว GitHub มีรุ่นใหม่อีก → แผงต้องเลิกบอก "อัปเดตแล้ว" และขึ้นปุ่มอัปเดต
//   node scripts/test-update-banner.mjs
// เคยค้างข้อความ "อัปเดตแล้ว" จนกดตรวจอัปเดตกี่ครั้งก็ไม่เห็นรุ่นที่ออกทีหลัง
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const js = readFileSync(join(ROOT, 'extension', 'sidepanel.js'), 'utf8')
const render = js.slice(js.indexOf('function renderUpdate()'), js.indexOf('async function loadUpdate('))
assert.ok(render.length > 0, 'หา renderUpdate ไม่เจอ')
const guard = render.indexOf('if (updateApplied && gitUpdate?.available) updateApplied = null')
assert.ok(guard > 0, 'ต้องล้างข้อความ "อัปเดตแล้ว" เมื่อมีรุ่นใหม่กว่า')
assert.ok(guard < render.indexOf('if (updateApplied) {'), 'ต้องล้างก่อนเช็คว่าจะแสดงข้อความ "อัปเดตแล้ว"')
console.log('PASS: แผงไม่ค้างข้อความ "อัปเดตแล้ว" เมื่อมีรุ่นใหม่กว่า')
