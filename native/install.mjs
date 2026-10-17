#!/usr/bin/env node
/**
 * ลงทะเบียน native host กับ Chrome — รันผ่าน ติดตั้งครั้งแรก.bat
 * (รันซ้ำได้ทุกเมื่อ เช่น หลังย้ายโฟลเดอร์โปรเจกต์ / เปลี่ยนที่ลง Node)
 *
 * เขียนเฉพาะ HKCU ของผู้ใช้คนนี้ ไม่ต้องใช้สิทธิ์ admin
 * จากนั้นตรวจว่า Chrome โหลด extension ไว้แล้วหรือยัง — ถ้ายัง เปิดหน้า chrome://extensions
 * และคัดลอกที่อยู่โฟลเดอร์ extension ไว้ให้วาง (ขั้น Load unpacked ทำแทนผู้ใช้ไม่ได้ Chrome ไม่อนุญาต)
 *
 *   node native/install.mjs                ลงทะเบียน + แนะนำขั้นต่อไปใน Chrome
 *   node native/install.mjs --uninstall    ถอนการลงทะเบียน
 *   node native/install.mjs --no-register  เขียนไฟล์ host แต่ไม่แตะ registry / ไม่เปิด Chrome (ใช้ทดสอบ)
 */
import { writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = 'com.cartoon_auto.bridge'
const DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(DIR, '..')
const EXTENSION_DIR = join(ROOT, 'extension')
const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`
const manifestFile = join(DIR, `${HOST}.json`)
const batFile = join(DIR, 'host.bat')
const noRegister = process.argv.includes('--no-register')

if (process.argv.includes('--uninstall')) {
  try {
    execFileSync('reg', ['delete', REG_KEY, '/f'], { stdio: 'ignore' })
  } catch {}
  rmSync(manifestFile, { force: true })
  rmSync(batFile, { force: true })
  console.log('ถอนการลงทะเบียนแล้ว')
  process.exit(0)
}

const id = readFileSync(join(DIR, 'extension-id.txt'), 'utf8').trim()

// Chrome เรียกได้แค่ไฟล์ .exe/.bat — ใช้ node ที่แถมมากับแพ็กเกจก่อน (อ้างจากที่ตั้งของไฟล์ ย้ายโฟลเดอร์แล้วยังถูก)
// ไม่มีจึงใช้ path เต็มของ node ที่รันตัวติดตั้งนี้ เพราะ PATH ตอน Chrome เปิดอาจไม่มี node
writeFileSync(batFile, [
  '@echo off',
  'if exist "%~dp0..\\runtime\\node\\node.exe" (',
  '  "%~dp0..\\runtime\\node\\node.exe" "%~dp0host.mjs" %*',
  '  exit /b',
  ')',
  `"${process.execPath}" "%~dp0host.mjs" %*`,
  '',
].join('\r\n'))
writeFileSync(
  manifestFile,
  JSON.stringify(
    {
      name: HOST,
      description: 'Cartoon Auto — เปิดโปรแกรมเมื่อกดไอคอน extension',
      path: resolve(batFile),
      type: 'stdio',
      allowed_origins: [`chrome-extension://${id}/`],
    },
    null,
    2,
  ),
)
if (noRegister) {
  console.log('เขียนไฟล์ host แล้ว (ข้ามการลงทะเบียน --no-register)')
  process.exit(0)
}
execFileSync('reg', ['add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', resolve(manifestFile), '/f'], { stdio: 'ignore' })
console.log('✓ ลงทะเบียนกับ Chrome แล้ว')

// ── Chrome โหลด extension นี้ไว้แล้วหรือยัง ──
const chromeData = join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data')

/** หา extension ID นี้ในทุกโปรไฟล์ของ Chrome — คืน path โฟลเดอร์ที่โหลดไว้ หรือ null */
function loadedFrom() {
  if (!existsSync(chromeData)) return null
  const profiles = readdirSync(chromeData, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
  for (const p of profiles) {
    for (const file of ['Secure Preferences', 'Preferences']) {
      try {
        const prefs = JSON.parse(readFileSync(join(chromeData, p.name, file), 'utf8'))
        const ext = prefs?.extensions?.settings?.[id]
        if (ext) return ext.path ?? ''
      } catch {}
    }
  }
  return null
}

function chromeExe() {
  return [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find((p) => existsSync(p)) ?? null
}

/** คัดลอกข้อความลงคลิปบอร์ด — ส่งผ่าน base64 กันชื่อโฟลเดอร์ภาษาไทยเพี้ยน */
function copyToClipboard(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

const chrome = chromeExe()
if (!chrome) {
  console.log('\n⚠️  ไม่พบ Google Chrome ในเครื่องนี้ — ติดตั้งจาก https://www.google.com/chrome แล้วดับเบิลคลิก ติดตั้งครั้งแรก.bat อีกครั้ง')
  process.exit(0)
}

const loaded = loadedFrom()
const samePlace = loaded && resolve(loaded).toLowerCase() === resolve(EXTENSION_DIR).toLowerCase()
if (samePlace) {
  console.log('✓ Chrome โหลด extension ไว้แล้ว — กดไอคอน Cartoon Auto บนแถบ Chrome แล้วใช้งานได้เลย')
  process.exit(0)
}

const copied = copyToClipboard(EXTENSION_DIR)
spawn(chrome, ['chrome://extensions'], { detached: true, stdio: 'ignore' }).unref()
console.log('')
console.log(loaded
  ? `⚠️  Chrome ยังใช้ extension จากโฟลเดอร์เก่า (${loaded}) — ให้กด "Remove" ตัวเก่าก่อน แล้วทำตามขั้นด้านล่าง`
  : 'เหลือขั้นสุดท้าย ทำครั้งเดียว (Chrome ไม่ให้โปรแกรมทำแทน):')
console.log('  เปิดหน้า chrome://extensions ให้แล้ว')
console.log('  1. เปิดสวิตช์ "Developer mode" มุมขวาบน')
console.log('  2. กด "Load unpacked"')
console.log(copied
  ? '  3. ในหน้าต่างเลือกโฟลเดอร์ คลิกช่องที่อยู่ด้านบน กด Ctrl+V (คัดลอกที่อยู่ไว้ให้แล้ว) แล้วกด Enter → Select Folder'
  : `  3. เลือกโฟลเดอร์ ${EXTENSION_DIR}`)
console.log('  4. กดไอคอนจิ๊กซอว์บนแถบ Chrome → ปักหมุด Cartoon Auto → กดไอคอน โปรแกรมเปิดเอง')
