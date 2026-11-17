#!/usr/bin/env node
/**
 * ทดสอบการแตกไฟล์อัปเดต (unpack ใน bridge/update-package.js) — ต้องแตกได้ครบทุกไฟล์ ไม่ว่าเครื่องตั้งภาษาระบบเป็นอะไร
 *
 *   node scripts/test-unzip.mjs
 *
 * ที่มา (17 พ.ย. 2026): tar.exe รุ่นใหม่ของ Windows ข้ามไฟล์ที่ชื่อแปลงเป็น code page ของเครื่องไม่ได้
 * ("Archive entry has empty or unreadable filename ... skipping") → เครื่องที่ภาษาระบบไม่ใช่ไทย
 * แตกไฟล์ชื่อไทย (เปิดโปรแกรม.bat ฯลฯ) ไม่ได้ กดอัปเดตแล้วล้มทุกครั้ง
 * เทสต์นี้ใช้ชื่อไฟล์ไทย + จีน: เครื่องไทย (cp874) แปลงชื่อจีนไม่ได้ เครื่องอังกฤษ (cp1252) แปลงชื่อไทยไม่ได้ — ต้องผ่านทั้งคู่
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unpack } from '../bridge/update-package.js'

let failures = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}
const rejects = async (fn, re, msg) => {
  try {
    await fn()
    ok(false, `${msg} (ไม่ error)`)
  } catch (err) {
    ok(re.test(err.message), `${msg} (${err.message.slice(0, 80)})`)
  }
}

const base = join(tmpdir(), 'cartoon-unzip-test')
rmSync(base, { recursive: true, force: true })
const repo = join(base, 'repo')
mkdirSync(join(repo, 'bridge', 'ลึก', '深'), { recursive: true })
mkdirSync(join(repo, 'zz'), { recursive: true })

// ไฟล์ตัวอย่าง — เนื้อหาเป็นไบต์ตรงๆ (.gitattributes -text กัน git แปลงขึ้นบรรทัด)
const FILES = {
  'เปิดโปรแกรม.bat': Buffer.from('@echo off\r\necho เปิด\r\n'),
  'ติดตั้งครั้งแรก (for Mac).command': Buffer.from('#!/bin/sh\necho hi\n'),
  'กขค.txt': Buffer.from('ก = E0 B8 81 — ไบต์ 0x81 ไม่มีใน cp1252'),
  '测试文件.txt': Buffer.from('ชื่อจีน — ไม่มีใน cp874'),
  'package.json': Buffer.from('{"name":"x"}\n'),
  'empty.txt': Buffer.alloc(0),
  'bridge/server.js': Buffer.from('// server\n'.repeat(500)),
  'bridge/ลึก/深/data.bin': randomBytes(300_000),
  'zz/evil.txt': Buffer.from('evil'),
}
writeFileSync(join(repo, '.gitattributes'), '* -text\n')
for (const [rel, buf] of Object.entries(FILES)) writeFileSync(join(repo, rel), buf)
const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' })
git('init', '-q')
git('add', '-A')
git('commit', '-qm', 'test')

function check(dir, label) {
  for (const [rel, buf] of Object.entries(FILES)) {
    const p = join(dir, 'top', rel)
    ok(existsSync(p) && readFileSync(p).equals(buf), `${label}: ${rel}`)
  }
}

console.log('▸ zip แบบที่ GitHub ให้ (บีบอัด)')
const zip = join(base, 'deflate.zip')
git('archive', '--format=zip', '--prefix=top/', '-o', zip, 'HEAD')
mkdirSync(join(base, 'a'), { recursive: true })
await unpack(zip, join(base, 'a')).then(() => check(join(base, 'a'), 'บีบอัด'), (err) => ok(false, `แตกไม่ได้: ${err.message.split('\n')[0]}`))

console.log('▸ zip แบบไม่บีบอัด (stored)')
const stored = join(base, 'stored.zip')
git('archive', '--format=zip', '-0', '--prefix=top/', '-o', stored, 'HEAD')
mkdirSync(join(base, 'b'), { recursive: true })
await unpack(stored, join(base, 'b')).then(() => check(join(base, 'b'), 'ไม่บีบอัด'), (err) => ok(false, `แตกไม่ได้: ${err.message.split('\n')[0]}`))

console.log('▸ ไฟล์เสีย / ไฟล์อันตราย → ต้อง error ไม่เขียนอะไรนอกโฟลเดอร์')
// โหลดมาไม่ครบ
const cut = join(base, 'cut.zip')
writeFileSync(cut, readFileSync(zip).subarray(0, 4000))
mkdirSync(join(base, 'c'), { recursive: true })
await rejects(() => unpack(cut, join(base, 'c')), /แตกไฟล์อัปเดตไม่ได้/, 'zip ขาดครึ่ง')
// เนื้อไฟล์เพี้ยน 1 ไบต์ (ในไฟล์ที่ไม่บีบอัด หาเจอง่าย)
const bad = readFileSync(stored)
const at = bad.indexOf(Buffer.from('// server\n// server\n'))
bad[at + 3] ^= 0xff
const corrupt = join(base, 'corrupt.zip')
writeFileSync(corrupt, bad)
mkdirSync(join(base, 'd'), { recursive: true })
await rejects(() => unpack(corrupt, join(base, 'd')), /แตกไฟล์อัปเดตไม่ได้/, 'เนื้อไฟล์เพี้ยน (CRC ไม่ตรง)')
// ชื่อไฟล์ชี้ออกนอกโฟลเดอร์ (zip slip): top/zz/evil.txt → ../../evil1.txt (ยาวเท่ากัน แก้ทั้งหัวไฟล์และสารบัญ)
const slip = readFileSync(stored)
for (let i = slip.indexOf('top/zz/evil.txt'); i >= 0; i = slip.indexOf('top/zz/evil.txt', i + 1)) slip.write('../../evil1.txt', i)
const slipZip = join(base, 'slip.zip')
writeFileSync(slipZip, slip)
mkdirSync(join(base, 'e', 'in'), { recursive: true })
await rejects(() => unpack(slipZip, join(base, 'e', 'in')), /แตกไฟล์อัปเดตไม่ได้/, 'ชื่อไฟล์ชี้ออกนอกโฟลเดอร์')
ok(!existsSync(join(base, 'evil1.txt')), 'ไม่มีไฟล์หลุดออกนอกโฟลเดอร์ปลายทาง')

rmSync(base, { recursive: true, force: true })
console.log(failures ? `\n❌ ผิด ${failures} ข้อ` : '\n✅ ผ่านทั้งหมด')
process.exit(failures ? 1 : 0)
