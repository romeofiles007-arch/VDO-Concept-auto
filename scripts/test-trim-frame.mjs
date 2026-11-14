/**
 * ทดสอบตัวตัดกรอบภาพ (pipeline/lib/trim_frame.mjs) — สร้างภาพทดสอบด้วย ffmpeg ไม่ต้องใช้ภาพจริง
 *   node scripts/test-trim-frame.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectFrame, trimFrames, cropBox, ORIGINAL_DIR } from '../pipeline/lib/trim_frame.mjs'

const dir = mkdtempSync(join(tmpdir(), 'trim-frame-'))
const W = 768
const H = 1376
const ffmpeg = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' })
/** ภาพ "เนื้อภาพ" เต็มเฟรม — ลายสีไม่ซ้ำ ไม่มีแถวไหนสีเดียว */
const scene = `testsrc2=s=${W}x${H}`
const make = (name, filter) => {
  ffmpeg(['-f', 'lavfi', '-i', scene, '-frames:v', '1', '-vf', filter, join(dir, name)])
  return join(dir, name)
}

try {
  // ภาพเต็มเฟรมปกติ — ห้ามแตะ
  const clean = make('00_00_00.png', 'null')
  assert.equal(await detectFrame(clean), null, 'ภาพเต็มเฟรมต้องไม่ถูกมองว่ามีกรอบ')

  // กรอบขาวแบบที่ลูกค้าแจ้ง: ซ้าย-ขวา 13% บน-ล่าง 3%
  const wide = make('00_00_03.png', `scale=568:1294,pad=${W}:${H}:100:41:color=white`)
  const wideFrame = await detectFrame(wide)
  assert.ok(wideFrame, 'กรอบขาวหนา 4 ด้านต้องตรวจเจอ')
  assert.ok(Math.abs(wideFrame.left - 100 / W) < 0.03 && Math.abs(wideFrame.right - 100 / W) < 0.03, 'ระยะกรอบซ้าย-ขวาต้องใกล้ 13%')

  // กรอบกระดาษครีมบางๆ 3%
  const thin = make('00_00_06.png', `scale=720:1290,pad=${W}:${H}:24:43:color=0xF4EFE2`)
  assert.ok(await detectFrame(thin), 'กรอบครีมบางต้องตรวจเจอ')

  // การ์ตูนพื้นหลังสีเรียบ ตัวละครกลางภาพ — ไม่ใช่กรอบ
  const flat = make('00_00_09.png', `scale=300:500,pad=${W}:${H}:234:438:color=0x7FD3F7`)
  assert.equal(await detectFrame(flat), null, 'พื้นหลังสีเรียบกับของกลางภาพต้องไม่ถูกมองว่าเป็นกรอบ')

  // แถบสีด้านบน-ล่างอย่างเดียว (ไม่ครบ 3 ด้าน) — ไม่แตะ
  const bars = make('00_00_12.png', `scale=${W}:1100,pad=${W}:${H}:0:138:color=white`)
  assert.equal(await detectFrame(bars), null, 'แถบบน-ล่างอย่างเดียวไม่นับเป็นกรอบ')

  // กรอบตัด: สัดส่วนต้องเท่าภาพเดิม
  const box = cropBox(wideFrame, W, H)
  assert.ok(Math.abs(box.w / box.h - W / H) < 0.01, 'กรอบตัดต้องได้สัดส่วนเดิม')

  // ตัดทั้งโฟลเดอร์: ตัดเฉพาะใบที่มีกรอบ ขนาดเท่าเดิม เก็บต้นฉบับ และรันซ้ำไม่ตัดอีก
  const trimmed = await trimFrames(dir)
  assert.deepEqual(trimmed, ['00_00_03.png', '00_00_06.png'])
  for (const name of trimmed) {
    assert.ok(existsSync(join(dir, ORIGINAL_DIR, name)), `ต้องเก็บต้นฉบับของ ${name}`)
    const size = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(dir, name)]).toString().trim()
    assert.equal(size, `${W},${H}`, 'ภาพที่ตัดแล้วต้องขนาดเท่าเดิม')
    assert.equal(await detectFrame(join(dir, name)), null, `${name} ตัดแล้วต้องไม่เหลือกรอบ`)
  }
  assert.deepEqual(await trimFrames(dir), [], 'รันซ้ำต้องไม่ตัดอีก')

  console.log('ผ่าน: ตรวจกรอบ 5 แบบ, สัดส่วนกรอบตัด, ตัดทั้งโฟลเดอร์ + เก็บต้นฉบับ + รันซ้ำ')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
