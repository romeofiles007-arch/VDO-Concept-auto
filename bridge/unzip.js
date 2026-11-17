/**
 * แตก zip ด้วย Node ล้วน — ไม่พึ่ง tar.exe / unzip ของเครื่อง
 *
 * ทำไมไม่ใช้ tar.exe (17 พ.ย. 2026): tar รุ่นใหม่ของ Windows (bsdtar 3.7+) แปลงชื่อไฟล์เป็น code page ของเครื่องก่อน
 * แปลงไม่ได้ = ข้ามไฟล์นั้น ("Archive entry has empty or unreadable filename ... skipping") แล้วจบด้วย error
 * → เครื่องที่ภาษาระบบไม่ใช่ไทยแตกไฟล์ชื่อไทย (เปิดโปรแกรม.bat ฯลฯ) ไม่ได้ กดอัปเดตล้มทุกครั้ง
 * (เครื่องไทย cp874 และ tar รุ่นเก่าของ Windows 10 ไม่เป็น จึงไม่เจอตอนทดสอบ)
 * ตรงนี้อ่านชื่อไฟล์เป็น UTF-8 ตรงๆ แบบที่ GitHub/git archive เขียนไว้ ไม่ผ่าน code page ของเครื่องเลย
 *
 * รองรับเท่าที่ zip ของ GitHub ใช้: ไม่บีบอัด (0) กับ deflate (8) · ไม่รองรับ zip64 / เข้ารหัส (เจอ = error ชัดๆ)
 * ทำแบบ sync ทั้งก้อน (zip รุ่นใหม่ ~30 MB ใช้ราว 1 วินาที) — เรียกตอนอัปเดตซึ่งไม่มีงานค้างอยู่แล้ว
 */
import { inflateRawSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

const EOCD = 0x06054b50 // ท้ายไฟล์: สารบัญอยู่ตรงไหน มีกี่รายการ
const CENTRAL = 0x02014b50 // สารบัญ 1 รายการ
const LOCAL = 0x04034b50 // หัวไฟล์ก่อนเนื้อไฟล์

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** แตก zipFile ลง dest (ต้องมีโฟลเดอร์อยู่แล้ว) — คืนจำนวนไฟล์ · ผิดปกติ = throw ก่อนเขียนไฟล์ที่ผิด */
export function extractZip(zipFile, dest) {
  const buf = readFileSync(zipFile)
  // ท้ายไฟล์อาจมี comment ยาวได้ถึง 65535 ไบต์ — ไล่หาจากท้าย
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('ไฟล์ zip ไม่สมบูรณ์ (โหลดมาไม่ครบ)')
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  if (count === 0xffff || at === 0xffffffff) throw new Error('ไฟล์ zip ใหญ่เกินที่รองรับ (zip64)')

  const root = resolve(dest)
  let files = 0
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) throw new Error('ไฟล์ zip เสีย (สารบัญไม่ครบ)')
    const flags = buf.readUInt16LE(at + 8)
    const method = buf.readUInt16LE(at + 10)
    const crc = buf.readUInt32LE(at + 16)
    const packed = buf.readUInt32LE(at + 20)
    const size = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen).replace(/\\/g, '/')
    at += 46 + nameLen + extraLen + commentLen

    // กันชื่อไฟล์ที่ชี้ออกนอกโฟลเดอร์ปลายทาง (../ หรือ path เต็ม)
    const target = resolve(root, name)
    if (!name || /^([a-zA-Z]:|\/)/.test(name) || (target !== root && !target.startsWith(root + sep))) throw new Error(`ชื่อไฟล์ใน zip ไม่ปลอดภัย: ${name}`)
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      continue
    }
    if (flags & 1) throw new Error(`ไฟล์ใน zip ถูกเข้ารหัส: ${name}`)
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new Error(`ไฟล์ zip เสีย (${name})`)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    if (start + packed > buf.length) throw new Error(`ไฟล์ zip ไม่สมบูรณ์ (${name})`)
    const raw = buf.subarray(start, start + packed)
    let data
    if (method === 0) data = raw
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error(`ไฟล์ zip ใช้การบีบอัดที่ไม่รองรับ (${name}: ${method})`)
    if (data.length !== size || crc32(data) !== crc) throw new Error(`ไฟล์ใน zip เสียหาย (${name}) — ลองอัปเดตใหม่อีกครั้ง`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    files++
  }
  return files
}
