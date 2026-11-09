/**
 * บีบโฟลเดอร์เป็น zip ที่แตกได้ถูกทั้ง Windows และ Mac — ใช้แทน Compress-Archive
 *
 * Compress-Archive ของ Windows PowerShell 5 (โมดูล 1.0.1.0) สร้าง zip ที่ Mac ใช้ไม่ได้:
 *   - คั่นโฟลเดอร์ด้วย \ → Mac แตกออกมาเป็นไฟล์แบนๆ ชื่อ "CartoonAuto\bridge\server.js" ไม่มีโฟลเดอร์
 *   - ไม่มีสิทธิ์แบบ Unix → ไฟล์ .command ดับเบิลคลิกไม่ได้ ("you do not have appropriate access privileges")
 * ตัวนี้เขียน zip เอง: คั่นด้วย / · ชื่อไฟล์ UTF-8 (ภาษาไทย) · ไฟล์ .command / .sh รันได้ (755) ที่เหลือ 644
 */
import { openSync, writeSync, closeSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync, crc32 } from 'node:zlib'

const EXEC = /\.(command|sh)$/i
const U32 = 0xffffffff

/** วันเวลาแบบ DOS ที่ zip ใช้ (ละเอียด 2 วินาที) */
function dosTime(d) {
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/** รายการทุกไฟล์/โฟลเดอร์ใต้ dir เป็น path แบบ / เรียงตามชื่อ */
function walk(dir, prefix, out) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = `${prefix}${e.name}`
    if (e.isDirectory()) {
      out.push({ rel: `${rel}/`, abs: join(dir, e.name), dir: true })
      walk(join(dir, e.name), `${rel}/`, out)
    } else if (e.isFile()) {
      out.push({ rel, abs: join(dir, e.name), dir: false })
    }
  }
  return out
}

/**
 * zipFolder('dist/CartoonAuto', 'dist/CartoonAuto.zip') → zip ที่มีโฟลเดอร์ CartoonAuto/ อยู่ข้างใน
 * (แบบเดียวกับ Compress-Archive -Path <โฟลเดอร์>) คืนจำนวนรายการ
 */
export function zipFolder(srcDir, zipFile, { root = srcDir.split(/[\\/]/).filter(Boolean).pop() } = {}) {
  const entries = [{ rel: `${root}/`, abs: srcDir, dir: true }, ...walk(srcDir, `${root}/`, [])]
  if (entries.length > 0xffff) throw new Error(`ไฟล์มากเกิน zip แบบธรรมดา (${entries.length} รายการ)`)
  const fd = openSync(zipFile, 'w')
  const central = []
  let offset = 0
  const write = (buf) => {
    writeSync(fd, buf)
    offset += buf.length
  }
  try {
    for (const e of entries) {
      const name = Buffer.from(e.rel, 'utf8')
      const { time, date } = dosTime(statSync(e.abs).mtime)
      let method = 0
      let crc = 0
      let raw = Buffer.alloc(0)
      let data = raw
      if (!e.dir) {
        raw = readFileSync(e.abs)
        crc = crc32(raw)
        const packed = deflateRawSync(raw, { level: 9 })
        if (packed.length < raw.length) {
          method = 8
          data = packed
        } else {
          data = raw
        }
      }
      if (offset + 30 + name.length + data.length > U32) throw new Error('zip ใหญ่เกิน 4 GB')
      const mode = e.dir ? 0o40755 : EXEC.test(e.rel) ? 0o100755 : 0o100644

      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4) // ต้องการ zip 2.0 ขึ้นไป
      local.writeUInt16LE(0x0800, 6) // ชื่อไฟล์เป็น UTF-8
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(crc >>> 0, 14)
      local.writeUInt32LE(data.length, 18)
      local.writeUInt32LE(raw.length, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(0, 28)

      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(0x02014b50, 0)
      cd.writeUInt16LE((3 << 8) | 20, 4) // สร้างบน Unix → Mac/Linux อ่านสิทธิ์จากช่อง external attributes
      cd.writeUInt16LE(20, 6)
      cd.writeUInt16LE(0x0800, 8)
      cd.writeUInt16LE(method, 10)
      cd.writeUInt16LE(time, 12)
      cd.writeUInt16LE(date, 14)
      cd.writeUInt32LE(crc >>> 0, 16)
      cd.writeUInt32LE(data.length, 20)
      cd.writeUInt32LE(raw.length, 24)
      cd.writeUInt16LE(name.length, 28)
      // 30 extra, 32 comment, 34 disk, 36 internal attrs = 0
      cd.writeUInt32LE(((mode << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38) // สิทธิ์ Unix + ป้ายโฟลเดอร์ของ DOS (Windows)
      cd.writeUInt32LE(offset, 42)
      central.push(cd, name)

      write(local)
      write(name)
      if (data.length) write(data)
    }
    const cdStart = offset
    for (const buf of central) write(buf)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(offset - cdStart, 12)
    end.writeUInt32LE(cdStart, 16)
    write(end)
  } finally {
    closeSync(fd)
  }
  return entries.length
}
