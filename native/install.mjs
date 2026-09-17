#!/usr/bin/env node
/**
 * ลงทะเบียน native host กับ Chrome — รันครั้งเดียวผ่าน ติดตั้งครั้งแรก.bat
 * (หรือรันใหม่เมื่อย้ายโฟลเดอร์โปรเจกต์ / เปลี่ยนที่ลง Node)
 *
 * เขียนเฉพาะ HKCU ของผู้ใช้คนนี้ ไม่ต้องใช้สิทธิ์ admin
 * ลบออก: node native/install.mjs --uninstall
 */
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = 'com.cartoon_auto.bridge'
const DIR = dirname(fileURLToPath(import.meta.url))
const REG_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`
const manifestFile = join(DIR, `${HOST}.json`)
const batFile = join(DIR, 'host.bat')

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

// Chrome เรียกได้แค่ไฟล์ .exe/.bat — ใส่ path ของ node เต็มๆ เพราะ PATH ตอน Chrome เปิดอาจไม่มี node
writeFileSync(batFile, `@echo off\r\n"${process.execPath}" "%~dp0host.mjs" %*\r\n`)
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
execFileSync('reg', ['add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', resolve(manifestFile), '/f'], { stdio: 'ignore' })

console.log('ลงทะเบียนกับ Chrome แล้ว')
console.log(`extension ID: ${id}`)
