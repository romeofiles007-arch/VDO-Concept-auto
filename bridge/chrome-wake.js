/**
 * ปลุก Chrome — มีงานรอ ChatGPT / Flow แต่ Chrome ที่ลง extension ไว้ปิดอยู่ → bridge เปิด Chrome โปรไฟล์นั้นให้เอง
 *
 * ผู้ใช้ (25 พ.ย. 2026): "หากเราไม่ได้เปิดหน้าโครมทิ้งไว้ระบบจะไม่ทำงาน ... บางทีเราไม่ได้เปิดหน้าโครมทิ้งไว้กับตัวใดตัวหนึ่ง"
 * เดิม: ผลิตต่อเนื่อง/ตั้งเวลาผลิต/คิวโพสต์ ส่งงานเข้าคิวได้ แต่ไม่มี extension มารับ (service worker อยู่ใน Chrome)
 * งานค้าง "มีงานรอ — extension ยังไม่มารับ" จนหมดเวลา ทั้งคืน
 *
 * ทำงานยังไง
 *   - ทุก 15 วิ ดูว่ามีงาน queued รอเกิน 45 วิ และ extension เงียบ (ไม่มาถามหางาน/ไม่ส่ง heartbeat) เกิน 2 นาที
 *   - หาโปรไฟล์ Chrome ที่โหลด extension จากโฟลเดอร์โปรแกรมนี้ (Default / Profile N) → เปิด chrome --profile-directory=<โปรไฟล์>
 *     ระบบอื่นในเครื่องเดียวกัน (ธรรมะ/ตำนานจีน/Ebook) อาจลงไว้คนละโปรไฟล์ — เปิดเฉพาะโปรไฟล์ของโปรแกรมนี้
 *   - Chrome เปิดแล้ว extension เริ่มเอง (onStartup) → มารับงาน → เปิดแท็บ ChatGPT / Flow เองตามเดิม
 *   - เปิดแล้วยังเงียบ: ลองใหม่ทุก 4 นาที สูงสุด 3 ครั้งต่อรอบ แล้วเลิก (extension อาจถูกปิด/ถอดไป ไม่เปิดหน้าต่างซ้ำทั้งคืน)
 *   - ⏹ หยุดทุกอย่างอยู่ → ไม่ปลุก
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const WAKE = {
  everyMs: 15_000,
  jobWaitMs: 45_000, // งานต้องรออย่างน้อยเท่านี้ (extension ที่เปิดอยู่รับงานภายในไม่กี่วิ)
  silentMs: 120_000, // extension เงียบเกินนี้ = Chrome ปิดอยู่ (alarm ปลุก service worker ทุก 1 นาที)
  retryMs: 4 * 60_000,
  maxTries: 3,
  orphanMs: 90_000, // ตรงกับ ORPHAN_MS ใน server.js — งานที่ไม่มีใครรอแล้วไม่ต้องปลุก Chrome มาทำ
}

/** โฟลเดอร์ข้อมูลผู้ใช้ของ Chrome (null = ระบบนี้ไม่รองรับ) */
export function chromeDataDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : null
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Google', 'Chrome')
  return null
}

/** ที่อยู่ chrome.exe / Google Chrome (ตัวโปรแกรมใน .app) — ชุดเดียวกับ native/install.mjs */
export function chromeExePath(platform = process.platform, env = process.env, exists = existsSync, home = homedir()) {
  const list =
    platform === 'win32'
      ? [
          join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
        ]
      : platform === 'darwin'
        ? ['/Applications', join(home, 'Applications')].map((d) => join(d, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'))
        : []
  return list.find((p) => p && exists(p)) ?? null
}

function samePath(a, b) {
  const norm = (p) => {
    try {
      return realpathSync(p).toLowerCase()
    } catch {
      return resolve(p).toLowerCase()
    }
  }
  return norm(a) === norm(b)
}

/**
 * โปรไฟล์ Chrome ที่โหลด extension นี้จากโฟลเดอร์ของโปรแกรมนี้และเปิดใช้อยู่
 * หลายโปรไฟล์ → เอาโปรไฟล์ที่ใช้ล่าสุด (Preferences แก้ล่าสุด) · ไม่เจอ → null
 */
export function findExtensionProfile({ dataDir, id, extensionDir, fs = { existsSync, readdirSync, readFileSync, statSync }, same = samePath }) {
  if (!dataDir || !id || !fs.existsSync(dataDir)) return null
  let best = null
  let dirs = []
  try {
    dirs = fs.readdirSync(dataDir, { withFileTypes: true }).filter((d) => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
  } catch {
    return null
  }
  for (const d of dirs) {
    for (const file of ['Secure Preferences', 'Preferences']) {
      const path = join(dataDir, d.name, file)
      try {
        const ext = JSON.parse(fs.readFileSync(path, 'utf8'))?.extensions?.settings?.[id]
        if (!ext?.path || !same(ext.path, extensionDir)) continue
        const disabled = Array.isArray(ext.disable_reasons) ? ext.disable_reasons.length > 0 : !!ext.disable_reasons || ext.state === 0
        if (disabled) continue
        // extension เขียนสถานะลง chrome.storage.local ทุกรอบที่ถามหางาน → โฟลเดอร์ที่เก็บค่าของ extension แก้ล่าสุด = โปรไฟล์ที่ทำงานให้โปรแกรมนี้จริง
        // (เครื่องเดียวกันอาจลง extension ไว้หลายโปรไฟล์ เปิดผิดโปรไฟล์ = ไม่มี token / บัญชี Google ผิด)
        const store = join(dataDir, d.name, 'Local Extension Settings', id)
        let ran = 0
        try {
          for (const f of fs.readdirSync(store)) ran = Math.max(ran, fs.statSync(join(store, f)).mtimeMs)
        } catch {}
        let used = 0
        try {
          used = fs.statSync(join(dataDir, d.name, 'Preferences')).mtimeMs
        } catch {}
        if (!best || ran > best.ran || (ran === best.ran && used > best.used)) best = { profile: d.name, ran, used }
        break
      } catch {}
    }
  }
  return best?.profile ?? null
}

/**
 * ตอนนี้ควรปลุก Chrome ไหม → ชื่อ agent ที่มีงานรอ (null = ไม่ต้อง)
 * jobs: Map ของงานใน bridge · lastPoll: agent → เวลาที่ extension มาถามหางานล่าสุด
 */
export function waitingAgent({ jobs, lastPoll, now, since, halted = false }) {
  if (halted) return null
  // extension ยังอยู่ = มาถามหางาน หรือส่ง heartbeat ของงานที่กำลังทำ (ตอนทั้งสองเว็บไม่ว่าง จะไม่มาถามหางานเลย)
  let seen = since
  for (const t of Object.values(lastPoll)) seen = Math.max(seen, t ?? 0)
  for (const j of jobs.values()) if (j.status === 'running') seen = Math.max(seen, j.touchedAt ?? 0)
  if (now - seen < WAKE.silentMs) return null
  for (const j of jobs.values()) {
    if (j.status !== 'queued' || j.cancelled) continue
    if (j.watchedAt != null && now - j.watchedAt > WAKE.orphanMs) continue // ไม่มีใครรองานนี้แล้ว
    if (now - (j.touchedAt ?? j.createdAt) < WAKE.jobWaitMs) continue
    return j.agent
  }
  return null
}

/** เปิด Chrome แบบไม่ผูกกับ bridge (bridge ปิด/รีสตาร์ท Chrome ไม่ปิดตาม) */
function launchChrome(exe, args) {
  return new Promise((done) => {
    try {
      const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
      child.on('error', () => done(false))
      child.unref()
      setTimeout(() => done(true), 300)
    } catch {
      done(false)
    }
  })
}

const AGENT_NAME = { chatgpt: 'ChatGPT', flow: 'Google Flow', meta: 'Meta AI' }

export function createChromeWake({
  jobs,
  lastPoll,
  halted = () => false,
  log = () => {},
  url = null, // หน้าที่เปิดพร้อม Chrome (หน้าโปรแกรม) — ผู้ใช้กลับมาเห็นว่าระบบเปิดให้เพราะอะไร
  id,
  extensionDir,
  now = Date.now,
  exe = () => chromeExePath(),
  profile = () => findExtensionProfile({ dataDir: chromeDataDir(), id, extensionDir }),
  launch = launchChrome,
  everyMs = WAKE.everyMs,
  timer = true,
}) {
  const since = now()
  let tries = 0
  let lastLaunchAt = 0
  let gaveUp = false
  let launching = false

  async function tick() {
    if (launching) return null
    // extension กลับมาแล้วหลังเปิดให้ → นับรอบใหม่
    const seen = Math.max(0, ...Object.values(lastPoll).map((t) => t ?? 0))
    if (lastLaunchAt && seen > lastLaunchAt) {
      if (tries) log(`ปลุก Chrome: extension กลับมารับงานแล้ว`)
      tries = 0
      lastLaunchAt = 0
      gaveUp = false
    }
    const agent = waitingAgent({ jobs, lastPoll, now: now(), since, halted: halted() })
    if (!agent) return null
    if (gaveUp || (lastLaunchAt && now() - lastLaunchAt < WAKE.retryMs)) return null
    if (tries >= WAKE.maxTries) {
      gaveUp = true
      log(`ปลุก Chrome: เปิดให้แล้ว ${tries} ครั้ง extension ยังไม่มารับงาน — เปิด Chrome โปรไฟล์ที่ลง Cartoon Auto Bridge ไว้ แล้วดูที่ chrome://extensions ว่าเปิดสวิตช์อยู่`)
      return null
    }
    const chrome = exe()
    if (!chrome) {
      gaveUp = true
      log('ปลุก Chrome: ไม่พบ Google Chrome ในเครื่อง — เปิด Chrome เองเพื่อให้ระบบทำงานต่อ')
      return null
    }
    const dir = profile()
    const args = [...(dir ? [`--profile-directory=${dir}`] : []), ...(url ? [url] : [])]
    launching = true
    try {
      tries++
      lastLaunchAt = now()
      const ok = await launch(chrome, args)
      log(
        ok
          ? `ปลุก Chrome: มีงาน ${AGENT_NAME[agent] ?? agent} รอแต่ Chrome ปิดอยู่ → เปิด Chrome${dir ? ` โปรไฟล์ "${dir}"` : ' (ไม่พบโปรไฟล์ที่ลง extension — เปิดโปรไฟล์ล่าสุด)'} ให้แล้ว (ครั้งที่ ${tries})`
          : `ปลุก Chrome: เปิด Chrome ไม่สำเร็จ (ครั้งที่ ${tries})`,
      )
      return { agent, args, ok }
    } finally {
      launching = false
    }
  }

  if (timer) setInterval(() => tick().catch(() => {}), everyMs).unref()
  return { tick, state: () => ({ tries, lastLaunchAt, gaveUp }) }
}
