// คอมไพล์ native/setup.cs → setup.exe ที่รากโปรเจกต์ (ด้วย csc.exe ที่มากับ Windows — ไม่ต้องลงอะไรเพิ่ม)
// ใช้: node scripts/build-setup.mjs
// setup.exe ขึ้น repo ด้วย เพราะลูกค้าดาวน์โหลดจาก GitHub ตรง ๆ — แก้ setup.cs แล้วต้องรันสคริปต์นี้ใหม่ทุกครั้ง
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const windir = process.env.WINDIR || 'C:\\Windows'
const csc = ['Framework64', 'Framework']
  .map((d) => join(windir, 'Microsoft.NET', d, 'v4.0.30319', 'csc.exe'))
  .find(existsSync)
if (!csc) {
  console.error('ไม่พบ csc.exe (.NET Framework 4) ในเครื่องนี้')
  process.exit(1)
}

const src = join(ROOT, 'native', 'setup.cs')
const head = readFileSync(src).subarray(0, 3)
if (!(head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)) {
  console.error('native/setup.cs ต้องบันทึกเป็น UTF-8 แบบมี BOM (ไม่งั้น csc อ่านภาษาไทยเพี้ยน)')
  process.exit(1)
}

const out = join(ROOT, 'setup.exe')
execFileSync(csc, [
  '/nologo',
  '/target:winexe', // หน้าต่างของตัวเอง (ฟอนต์ไทย) ไม่ใช่ console — เครื่องภาษาอื่นแสดงไทยเป็นกล่อง
  '/platform:anycpu',
  '/optimize+',
  '/codepage:65001',
  `/win32icon:${join(ROOT, 'extension', 'icons', 'icon-128.ico')}`,
  `/win32manifest:${join(ROOT, 'native', 'setup.manifest')}`,
  '/r:System.IO.Compression.dll',
  '/r:System.IO.Compression.FileSystem.dll',
  '/r:System.Windows.Forms.dll',
  '/r:System.Drawing.dll',
  `/out:${out}`,
  src,
], { stdio: 'inherit' })
console.log(`✓ ${out}`)
