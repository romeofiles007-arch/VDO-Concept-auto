#!/usr/bin/env node
/**
 * ทดสอบตัวอัปเดตของเครื่องที่ติดตั้งจากแพ็กเกจ zip (bridge/update-package.js)
 *
 *   node scripts/test-update-package.mjs          จำลอง GitHub (ไม่ใช้เน็ต)
 *   node scripts/test-update-package.mjs --live   ตรวจ + โหลดรุ่นล่าสุดจาก GitHub จริง
 *
 * จำลองเครื่องลูกค้า: แตกโค้ดรุ่นเก่า + ค่าที่ลูกค้าตั้งเอง + .env + งานใน projects + runtime
 * แล้วอัปเดต → ตรวจว่าโค้ดเป็นรุ่นใหม่ และของลูกค้าไม่ถูกแตะ
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT } from '../pipeline/lib/config.mjs'
import { createUpdater } from '../bridge/update.js'
import { shipsToCustomer } from '../bridge/package-rules.js'

const live = process.argv.includes('--live')
const REPO = 'https://github.com/romeofiles007-arch/VDO-Concept-auto'
let failures = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')

/** zip ของ commit แบบที่ GitHub ให้ (โฟลเดอร์บนสุด <repo>-<sha>/) */
function archive(ref, file) {
  const sha = git('rev-parse', ref)
  execFileSync('git', ['archive', '--format=zip', `--prefix=VDO-Concept-auto-${sha}/`, '-o', file, sha], { cwd: ROOT })
  return sha
}

/** เครื่องลูกค้าจำลองที่ติดตั้งจาก commit เก่า */
function fakeInstall(dir, oldRef) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const zip = join(dir, '..', `old-${Date.now()}.zip`)
  const sha = archive(oldRef, zip)
  execFileSync(tar, ['-xf', zip, '-C', dir, '--strip-components', '1'])
  rmSync(zip)
  const all = execFileSync('git', ['ls-tree', '-r', '--name-only', sha], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  for (const f of all) if (!shipsToCustomer(f)) rmSync(join(dir, f), { force: true }) // แพ็กเกจจริงไม่มีไฟล์ของนักพัฒนา
  const files = all.filter((f) => shipsToCustomer(f) && f !== 'config/project.config.json' && !f.startsWith('projects/'))
  rmSync(join(dir, 'config', 'project.config.json'))
  // ของลูกค้า — ห้ามถูกแตะ
  writeFileSync(join(dir, 'config', 'project.config.json'), JSON.stringify({ script: { language: 'zh' } }))
  writeFileSync(join(dir, '.env'), 'ELEVENLABS_API_KEY=customer-secret\n')
  writeFileSync(join(dir, 'projects', 'topics.json'), '[{"title":"งานของลูกค้า"}]')
  mkdirSync(join(dir, 'runtime', 'node'), { recursive: true })
  writeFileSync(join(dir, 'runtime', 'node', 'marker.txt'), 'runtime')
  // ไฟล์ที่รุ่นใหม่ไม่มีแล้ว → ต้องถูกลบ · ไฟล์โค้ดที่ลูกค้าแก้เอง → ต้องถูกทับด้วยของใหม่
  writeFileSync(join(dir, 'bridge', 'old-removed.js'), '// เก่า')
  writeFileSync(join(dir, 'extension', 'content-chatgpt.js'), '// Copilot แก้')
  writeFileSync(join(dir, 'VERSION.json'), JSON.stringify({ commit: sha.slice(0, 7), sha, repo: REPO, branch: 'main', files: [...files, 'bridge/old-removed.js'] }))
  return sha
}

function verifyInstalled(dir, newSha) {
  const v = JSON.parse(readFileSync(join(dir, 'VERSION.json'), 'utf8'))
  ok(v.sha === newSha, `VERSION.json เป็นรุ่นใหม่ (${v.commit})`)
  ok(v.repo === REPO && Array.isArray(v.files) && v.files.length > 50, 'VERSION.json ยังจำ repo + รายชื่อไฟล์')
  ok(existsSync(join(dir, 'bridge', 'keepawake.js')), 'มีไฟล์ใหม่ของรุ่นใหม่ (bridge/keepawake.js)')
  ok(!existsSync(join(dir, 'bridge', 'old-removed.js')), 'ไฟล์ที่รุ่นใหม่ไม่มีแล้วถูกลบ')
  ok(readFileSync(join(dir, 'extension', 'content-chatgpt.js'), 'utf8').length > 1000, 'ไฟล์โค้ดที่ถูกแก้ในเครื่องกลับเป็นของจริง')
  ok(JSON.parse(readFileSync(join(dir, 'config', 'project.config.json'), 'utf8')).script.language === 'zh', 'ค่าที่ลูกค้าตั้งเองไม่ถูกแตะ')
  const defaults = JSON.parse(readFileSync(join(dir, 'config', 'default.config.json'), 'utf8'))
  ok(defaults.tts.engine === 'edge' && defaults.clips.provider === 'off' && !defaults.tts.elevenlabs?.voiceId, 'default.config.json ใช้กฎลูกค้า (Edge · ปิด Kie · ไม่มี Voice ID ของเรา)')
  ok(readFileSync(join(dir, '.env'), 'utf8').includes('customer-secret'), '.env ไม่ถูกแตะ')
  ok(readFileSync(join(dir, 'projects', 'topics.json'), 'utf8').includes('งานของลูกค้า'), 'งานใน projects ไม่ถูกแตะ')
  ok(existsSync(join(dir, 'runtime', 'node', 'marker.txt')), 'runtime ไม่ถูกแตะ')
  ok(!existsSync(join(dir, 'scripts', 'build-package.mjs')) && !existsSync(join(dir, 'DESIGN.md')), 'ไม่ใส่ไฟล์ของนักพัฒนา')
  ok(/\r\n/.test(readFileSync(join(dir, 'เปิดโปรแกรม.bat'), 'latin1')), '.bat ยังเป็น CRLF')
  ok(!existsSync(join(dir, '.update-tmp')), 'ลบโฟลเดอร์ชั่วคราวแล้ว')
}

const base = join(tmpdir(), 'cartoon-update-test')
mkdirSync(base, { recursive: true })
const OLD = '36d23f6' // ก่อนมี keepawake.js

if (!live) {
  console.log('▸ จำลอง GitHub')
  const dir = join(base, 'offline')
  const oldSha = fakeInstall(dir, OLD)
  const zip = join(base, 'new.zip')
  // รุ่นใหม่ = commit ล่าสุดในเครื่อง (ต้องผ่านกฎตัวติดตั้งของรุ่นปัจจุบัน เช่นต้องมี ถอนการติดตั้ง.bat) — รันหลัง commit
  const newSha = archive(process.env.NEW_REF || 'HEAD', zip)
  const calls = []
  const fakeFetch = async (url) => {
    calls.push(url)
    if (url.endsWith('/info/refs?service=git-upload-pack')) {
      return new Response(`001e# service=git-upload-pack\n0000015b${newSha} HEAD\0multi_ack symref=HEAD:refs/heads/main\n003f${newSha} refs/heads/main\n003f${oldSha} refs/heads/old\n0000`)
    }
    if (url.endsWith('/commits/main.atom')) {
      const entry = (sha, title) => `<entry><id>tag:github.com,2008:Grit::Commit/${sha}</id><title>\n  ${title}\n</title><updated>2026-10-31T04:13:18Z</updated><author><name>dev</name></author></entry>`
      return new Response(`<feed>${entry(newSha, 'กันเครื่องหลับ &amp; ทดสอบ')}${entry(oldSha, 'รุ่นเก่า')}</feed>`)
    }
    if (url === `https://codeload.github.com/romeofiles007-arch/VDO-Concept-auto/zip/${newSha}`) return new Response(readFileSync(zip))
    return new Response('not found', { status: 404 })
  }
  const { createPackageUpdater } = await import('../bridge/update-package.js')
  const { followUps } = await import('../bridge/update.js')
  let working = true
  const up = createPackageUpdater({ cwd: dir, schedule: false, fetchFn: fakeFetch, busy: () => working, followUps })
  const s = await up.check()
  ok(s.available && s.behind === 1 && s.commits[0]?.subject === 'กันเครื่องหลับ & ทดสอบ', `ตรวจเจออัปเดต 1 รายการพร้อมชื่อ (${s.error ?? s.commits[0]?.subject})`)
  ok(!calls.some((u) => /api\.github\.com/.test(u)), 'ไม่เรียก GitHub API')
  await up.apply().then(() => ok(false, 'ควรปฏิเสธตอนมีงานค้าง'), (e) => ok(/งานค้าง/.test(e.message), 'ปฏิเสธตอนกำลังทำคลิป'))
  ok(JSON.parse(readFileSync(join(dir, 'VERSION.json'), 'utf8')).sha === oldSha, 'ปฏิเสธแล้วไม่เปลี่ยนอะไร')
  working = false
  const after = await up.apply()
  verifyInstalled(dir, newSha)
  ok(after.behind === 0 && !after.available, 'หลังอัปเดต ตรวจซ้ำแล้วเป็นรุ่นล่าสุด')
  ok(after.applied?.to === newSha.slice(0, 7), 'บันทึกผลอัปเดต')

  console.log('▸ แพ็กเกจรุ่นเก่าที่ไม่มี repo ใน VERSION.json')
  writeFileSync(join(dir, 'VERSION.json'), JSON.stringify({ commit: 'abc1234' }))
  const old = await createUpdater({ cwd: dir, schedule: false, log() {}, busy: () => false }).check()
  ok(!old.available && /แพ็กเกจรุ่นใหม่/.test(old.error ?? ''), 'บอกให้ขอแพ็กเกจรุ่นใหม่ ไม่พัง')
} else {
  console.log('▸ GitHub จริง')
  const dir = join(base, 'live')
  fakeInstall(dir, OLD)
  const logs = []
  const up = createUpdater({ cwd: dir, schedule: false, log: (m) => logs.push(m), busy: () => false })
  const s = await up.check()
  ok(s.available && s.behind >= 1, `ตรวจเจออัปเดต ${s.behind} รายการ${s.error ? ` (${s.error})` : ''}`)
  for (const c of s.commits ?? []) console.log(`      · ${c.subject}`)
  const t = Date.now()
  const after = await up.apply()
  console.log(`    อัปเดตใช้เวลา ${((Date.now() - t) / 1000).toFixed(1)} วิ · ${logs.at(-1)}`)
  verifyInstalled(dir, after.latest)
  ok(!after.available, 'หลังอัปเดตเป็นรุ่นล่าสุด')
}

rmSync(base, { recursive: true, force: true })
console.log(failures ? `\n❌ ผิด ${failures} ข้อ` : '\n✅ ผ่านทั้งหมด')
process.exit(failures ? 1 : 0)
