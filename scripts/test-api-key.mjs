// เทสต์การรับ API key ที่ผู้ใช้วางในแผงข้าง (Gemini / ElevenLabs / Kie)
//   node --test scripts/test-api-key.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanKey, validKey } from '../bridge/ui.js'

const AIZA = 'AIzaSyD-1234567890abcdefghijklmnopqrstu' // แบบเดิม 39 ตัว
const AQ = 'AQ.Ab8RN6JxY2k_example-0123456789abcdefghijklmnopqrstuv' // Gemini รุ่นใหม่ มีจุด

test('รับ Gemini key ทั้งแบบเดิม (AIza…) และแบบใหม่ (AQ. มีจุด)', () => {
  assert.ok(validKey(cleanKey(AIZA)))
  assert.ok(validKey(cleanKey(AQ)), 'key ขึ้นต้น AQ. ต้องผ่าน — เดิมขึ้น "รูปแบบ API key ไม่ถูกต้อง"')
})

test('ตัดของที่ติดมากับการคัดลอก: เว้นวรรค ขึ้นบรรทัด อักษรล่องหน เครื่องหมายคำพูด', () => {
  for (const pasted of [`  ${AQ}\n`, `"${AQ}"`, `'${AQ}'`, `﻿${AQ}​`, AQ.replace('.', '.\r\n')]) {
    assert.equal(cleanKey(pasted), AQ)
  }
})

test('ไม่รับของที่ไม่ใช่ key หรือเขียนลง .env แล้วอันตราย', () => {
  for (const bad of ['', 'short', 'x'.repeat(301), `${AIZA}=other`, `${AIZA}#x`, `${AIZA}$HOME`, 'GEMINI_API_KEY=abc', 'คีย์ภาษาไทยยาวๆๆๆๆๆๆๆๆๆๆๆๆๆๆๆๆ']) {
    assert.equal(validKey(cleanKey(bad)), false, bad)
  }
})
