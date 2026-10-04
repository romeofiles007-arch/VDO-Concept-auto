/**
 * อัปเดตตัวเองเมื่อโค้ดเปลี่ยน — ไม่ต้องปิดเปิดโปรแกรมหรือกด reload extension เอง
 *
 *   โปรแกรมในเครื่อง: โค้ดที่ bridge โหลดไว้ (bridge/, pipeline/lib/, extension/prompts.js) เปลี่ยน
 *                     → รอจนไม่มีงานค้าง → เปิดตัวใหม่แบบ detached แล้วปิดตัวเอง
 *   extension:       ลายนิ้วมือของไฟล์ใน extension/ ส่งให้ background ผ่าน /api/ext-version
 *                     → background เทียบกับตอนโหลด ถ้าต่างและไม่มีงานค้าง → chrome.runtime.reload()
 *
 * งานใน pipeline/*.mjs (ขั้นต่างๆ) ไม่ต้องรีสตาร์ท — รันเป็น process ใหม่ทุกครั้งอยู่แล้ว
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ROOT } from '../pipeline/lib/config.mjs'

const CODE_EXT = /\.(m?js|json|html|css|txt|svg|png)$/i

/** mtime + ขนาดของทุกไฟล์ในโฟลเดอร์ (ไม่ลงโฟลเดอร์ที่ขึ้นต้นด้วย _ หรือ .) */
function fingerprint(dirs, filter = CODE_EXT) {
  const hash = createHash('sha1')
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (filter.test(entry.name)) {
        const st = statSync(p)
        hash.update(`${relative(ROOT, p)}:${st.size}:${st.mtimeMs}\n`)
      }
    }
  }
  for (const d of dirs) {
    const p = join(ROOT, d)
    if (existsSync(p) && statSync(p).isFile()) hash.update(`${d}:${statSync(p).size}:${statSync(p).mtimeMs}\n`)
    else walk(p)
  }
  return hash.digest('hex').slice(0, 16)
}

// โค้ดที่ process ของ bridge โหลดค้างไว้ในหน่วยความจำ
const BRIDGE_CODE = ['bridge', 'pipeline/lib', 'extension/prompts.js']
const BRIDGE_FILTER = /\.m?js$/i
export const extensionVersion = () => fingerprint(['extension'])

/**
 * เปิด bridge ตัวใหม่เป็น process อิสระ (detached) — ตัวใหม่รอจนตัวเก่าปล่อย port เอง (ดู server.js)
 * bridge ถูกเปิดด้วย WMI ไม่ได้อยู่ใน job object ของใคร ลูกที่ detached จึงอยู่ต่อได้หลังตัวเก่าปิด
 */
export function launchReplacement() {
  spawn(process.execPath, [join(ROOT, 'bridge', 'server.js')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

/**
 * เฝ้าดูโค้ดของ bridge ทุก 10 วิ — เปลี่ยนแล้วรอจน busy() เป็น false จึงรีสตาร์ท
 * @param {{ busy: () => boolean, server: import('node:http').Server, log: (s: string) => void }} opts
 */
export function watchBridgeCode({ busy, server, log }) {
  const started = fingerprint(BRIDGE_CODE, BRIDGE_FILTER)
  let announced = false
  const timer = setInterval(() => {
    if (fingerprint(BRIDGE_CODE, BRIDGE_FILTER) === started) return
    if (busy()) {
      if (!announced) log('โค้ดของโปรแกรมเปลี่ยน — รองานที่ค้างเสร็จก่อนแล้วจะรีสตาร์ทเอง')
      announced = true
      return
    }
    clearInterval(timer)
    log('โค้ดของโปรแกรมเปลี่ยน — รีสตาร์ทเป็นรุ่นใหม่')
    launchReplacement()
    server.close()
    setTimeout(() => process.exit(0), 500)
  }, 10_000)
  timer.unref?.()
}
