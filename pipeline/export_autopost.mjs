#!/usr/bin/env node
/**
 * ส่งคลิปที่ทำเสร็จแล้วเข้าโฟลเดอร์โพสต์อัตโนมัติของ PagePilot (ใช้กับคลิปเก่า หรือส่งซ้ำ)
 * คลิปใหม่จาก "ทำคลิปอัตโนมัติ" ถูกส่งเองตอนจบอยู่แล้ว
 *
 *   node pipeline/export_autopost.mjs <slug>
 */
import { loadConfig } from './lib/config.mjs'
import { autoPostDir, exportForAutoPost } from './lib/autopost.mjs'

const slug = process.argv[2]
if (!slug) {
  console.error('ใช้: node pipeline/export_autopost.mjs <slug>')
  process.exit(1)
}
const config = loadConfig()
if (!autoPostDir(config)) {
  console.error('ยังไม่ได้ตั้งโฟลเดอร์ — ใส่ autoPost.dir ใน config/project.config.json เช่น "G:\\\\My Drive\\\\PagePilot Auto Post"')
  process.exit(1)
}
try {
  console.log(`ส่งแล้ว: ${exportForAutoPost(slug, config)}`)
} catch (err) {
  console.error(err.message)
  process.exit(2)
}
