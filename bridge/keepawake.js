/**
 * กันเครื่องหลับระหว่างมีงาน — เครื่องลูกค้าหลับกลางงาน ทุกอย่างหยุดค้างทั้งคืน แล้วตื่นมาเจอ error พร้อมกันหมด (เจอจริง ต.ค. 2026)
 *
 * มีงาน → เปิด PowerShell ซ่อนไว้หนึ่งตัว เรียก SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
 *   = บอก Windows ว่า "มีงานอยู่ ห้ามหลับเอง" · จอยังดับได้ตามปกติ · ไม่ต้องใช้สิทธิ์ admin ไม่แก้การตั้งค่า Power
 * ว่างแล้ว → ปิดตัวนั้น Windows คืนค่าเดิมเอง
 * bridge ถูกปิด/ตาย → ตัวนั้นเห็นว่า bridge หายไปแล้วปิดตัวเอง เครื่องไม่ค้างโหมดห้ามหลับ
 *
 * กันไม่ได้: พับฝาโน้ตบุ๊ก หรือกด Sleep เองจากเมนู Start
 */
import { spawn } from 'node:child_process'

const CHECK_EVERY_MS = 15_000
const RETRY_AFTER_FAIL_MS = 5 * 60_000

function script(parentPid) {
  return [
    `Add-Type -Namespace CartoonAuto -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'`,
    // 0x80000001 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED · คืน 0 = Windows ไม่รับ
    `if ([CartoonAuto.Power]::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 3 }`,
    `Wait-Process -Id ${parentPid} -ErrorAction SilentlyContinue`,
  ].join('\n')
}

/** busy() คืนจริงเมื่อควรกันเครื่องหลับ · spawnFn / platform ให้เทสต์แทนที่ได้ */
export function createKeepAwake({ busy, log = () => {}, platform = process.platform, spawnFn = spawn, everyMs = CHECK_EVERY_MS, now = Date.now }) {
  let proc = null
  let retryAt = 0

  function start() {
    const encoded = Buffer.from(script(process.pid), 'utf16le').toString('base64')
    let child
    try {
      // Mac: caffeinate ที่มากับ macOS — -i ห้ามหลับเองระหว่างมีงาน (จอดับได้) · -w ปิดตัวเองเมื่อ bridge หายไป
      child = platform === 'darwin'
        ? spawnFn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
        : spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore' })
    } catch (err) {
      retryAt = now() + RETRY_AFTER_FAIL_MS
      return log(`กันเครื่องหลับไม่ได้: ${err.message}`)
    }
    proc = child
    child.on('error', (err) => {
      if (proc === child) proc = null
      retryAt = now() + RETRY_AFTER_FAIL_MS
      log(`กันเครื่องหลับไม่ได้: ${err.message}`)
    })
    child.on('exit', (code) => {
      if (proc !== child) return // เราปิดเอง
      proc = null
      retryAt = now() + RETRY_AFTER_FAIL_MS
      log(`ตัวกันเครื่องหลับปิดไปเอง (code ${code}) — ลองใหม่ใน 5 นาที`)
    })
    log('กันเครื่องหลับ: เปิด (มีงานทำคลิปอยู่ — เครื่องจะไม่หลับเอง จอดับได้ตามปกติ)')
  }

  function stop(reason = 'ไม่มีงานแล้ว') {
    if (!proc) return
    const child = proc
    proc = null
    child.kill()
    log(`กันเครื่องหลับ: ปิด (${reason})`)
  }

  function tick() {
    let want = false
    try {
      want = !!busy()
    } catch {}
    if (want && !proc && now() >= retryAt) start()
    else if (!want && proc) stop()
  }

  if (platform !== 'win32' && platform !== 'darwin') return { tick() {}, stop() {}, active: () => false }
  const timer = setInterval(tick, everyMs)
  timer.unref?.()
  tick()
  return {
    tick,
    stop: (reason) => {
      clearInterval(timer)
      stop(reason)
    },
    active: () => !!proc,
  }
}
