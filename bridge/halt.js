/**
 * ⏹ หยุดทุกอย่าง — สวิตช์ฉุกเฉินของทั้งโปรแกรม
 *
 * ผู้ใช้ (21 พ.ย. 2026): "บางทีปุ่มหยุดใช้ไม่ได้ มันยังทำงานเอง"
 * (พบในโปรแกรมตำนานจีนที่โครงเดียวกัน แล้วนำมาใช้ที่นี่ด้วย) ปุ่มหยุดเดิมแต่ละปุ่มหยุดแค่ส่วนของตัวเอง —
 *   หยุดผลิตต่อเนื่อง: ไม่ยกเลิกงานที่แท็บ ChatGPT/Flow ทำค้าง · ไม่แตะโพสต์อัตโนมัติ
 *   โพสต์อัตโนมัติ: มีตัวจับเวลาของตัวเอง ทำต่อไม่สนปุ่มหยุดผลิต
 *
 * สวิตช์นี้เก็บลงไฟล์ (รอดการรีสตาร์ทโปรแกรม) — ตราบที่ยังเปิดอยู่:
 *   ผลิตต่อเนื่อง/โพสต์อัตโนมัติไม่เริ่มเอง · ไม่เริ่มขั้นใหม่ของ pipeline · ไม่ส่งงานให้แท็บ · งานใหม่ถูกปฏิเสธทันที
 * ปลดได้ทางเดียวคือกด "ทำงานต่อ" — และปลดแล้วก็ไม่เริ่มอะไรเอง ผู้ใช้กดเริ่มเองทีละส่วน
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

export const HALTED_MESSAGE = 'หยุดทุกอย่างไว้อยู่ — กด "ทำงานต่อ" ในแผงข้างก่อน'

export function createHalt(file) {
  let state = { on: false, at: null }
  try {
    if (existsSync(file)) state = { on: false, at: null, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch {}
  const save = () => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state, null, 2))
  }
  return {
    on: () => state.on === true,
    view: () => ({ halted: state.on === true, at: state.at }),
    set(on) {
      state = { on: !!on, at: on ? Date.now() : null }
      save()
      return this.view()
    },
  }
}

/**
 * process ของโปรแกรมนี้ที่หลุดการควบคุม (bridge ไม่รู้จัก เช่น autopilot ที่เริ่มก่อนรีสตาร์ท หรือขั้นที่สั่งปิดแล้วไม่ตาย)
 * = node / python / ffmpeg ที่บรรทัดคำสั่งชี้เข้าโฟลเดอร์ pipeline/ tts/ หรือ projects/ ของโปรแกรมนี้ — ไม่แตะ bridge เอง และไม่แตะโปรแกรมอื่น
 * เทียบแบบไม่สน \ กับ / — path ของ Windows (C:\app) และ Linux ใน Docker (/app) ใช้ตัวเดียวกัน
 */
export function strayProcesses(root, list, { selfPid = process.pid } = {}) {
  const slash = (s) => s.replaceAll('\\', '/').toLowerCase()
  // root แบบ Linux (/app) ใช้ตรง ๆ — resolve บน Windows จะเติมชื่อไดรฟ์ให้ผิด
  const base = slash(root.startsWith('/') ? root : resolve(root)).replace(/\/+$/, '')
  const inside = ['pipeline', 'tts', 'projects'].map((d) => `${base}/${d}/`)
  return list.filter((p) => {
    if (!p?.pid || p.pid === selfPid || !p.cmd) return false
    // Linux (Docker) เรียก python เป็น python3 / python3.11
    if (!/^(node|python[\d.]*|pythonw|ffmpeg)(\.exe)?$/i.test(p.name ?? '')) return false
    const cmd = slash(p.cmd)
    return inside.some((d) => cmd.includes(d))
  })
}

/** แยกผลของ `ps -eo pid=,comm=,args=` เป็น { pid, name, cmd } */
export function parsePs(out) {
  return String(out ?? '')
    .split('\n').map((l) => l.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, name, cmd]) => ({ pid: Number(pid), name: name.split('/').pop(), cmd }))
}

/** Linux ที่ไม่มีคำสั่ง ps (image Docker แบบ slim ไม่มี procps) — อ่านจาก /proc ตรง ๆ */
function procProcesses() {
  const rows = []
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
      const name = readFileSync(`/proc/${d}/comm`, 'utf8').trim()
      if (cmd) rows.push({ pid: Number(d), name, cmd })
    } catch {}
  }
  return rows
}

/** รายการ process ของเครื่อง (Windows / Linux / Mac) — อ่านไม่ได้ก็คืนว่าง ไม่ให้ปุ่มหยุดพังเพราะเรื่องนี้ */
export function listProcesses() {
  if (process.platform !== 'win32') {
    // Linux/Mac (เช่น container Docker): ps บอก pid ชื่อ และบรรทัดคำสั่งเต็ม
    try {
      return parsePs(execFileSync('ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8', timeout: 10_000 }))
    } catch {
      try {
        return process.platform === 'linux' ? procProcesses() : []
      } catch {
        return []
      }
    }
  }
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='python.exe' or Name='pythonw.exe' or Name='ffmpeg.exe'\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
    { windowsHide: true, encoding: 'utf8', timeout: 20_000 })
    const rows = JSON.parse(out || '[]')
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, name: r.Name, cmd: r.CommandLine ?? '' }))
  } catch {
    return []
  }
}

/** ปิด process ที่หลุดการควบคุมทั้งต้นไม้ — คืนจำนวนที่สั่งปิด */
export function killStray(root, log = () => {}) {
  const stray = strayProcesses(root, listProcesses())
  for (const p of stray) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 })
      else process.kill(p.pid, 'SIGKILL')
      log(`หยุดทุกอย่าง: ปิด ${p.name} (PID ${p.pid}) ที่ยังทำงานอยู่`)
    } catch {}
  }
  return stray.length
}
