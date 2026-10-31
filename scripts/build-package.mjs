#!/usr/bin/env node
/**
 * สร้างแพ็กเกจส่งลูกค้า — ลูกค้าแตก zip ดับเบิลคลิก setup.exe แล้วใช้ได้เลย
 *
 *   node scripts/build-package.mjs            → dist/CartoonAuto/
 *   node scripts/build-package.mjs --zip      → dist/CartoonAuto/ + dist/CartoonAuto.zip
 *
 * ใส่อะไรบ้าง
 *   โค้ด: เฉพาะไฟล์ที่ git ติดตาม (ไฟล์ที่ .gitignore กันไว้ — .env, เสียงที่โคลน, งานในโปรเจกต์ — ไม่ติดไปเอง)
 *   runtime/node     node.exe ตัวที่รันสคริปต์นี้
 *   runtime/ffmpeg   ffmpeg.exe + ffprobe.exe จาก PATH ของเครื่องนี้
 *   runtime/python   Python + edge-tts จาก tts/.venv-edge → เสียง Edge ใช้ได้ทันทีโดยไม่ต้องลง Python
 *
 * ไม่ใส่
 *   ข้อมูลของเรา: API key, BRIDGE_TOKEN, เสียงที่โคลน, ประวัติหัวข้อ, Voice ID ของ ElevenLabs
 *   ของนักพัฒนา: เทสต์, ไฟล์ออกแบบ (.impeccable, docs/design), .git
 *
 * ก่อนจบ สแกนทุกไฟล์ในแพ็กเกจหา key/token ของเครื่องนี้ — เจอแม้ตัวเดียวจะลบแพ็กเกจทิ้งแล้วหยุด
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { ROOT } from '../pipeline/lib/config.mjs'
// ไฟล์ที่ไปถึงลูกค้า / ค่าเริ่มต้นของลูกค้า — กฎชุดเดียวกับตัวอัปเดตในเครื่องลูกค้า (bridge/update-package.js)
import { RESET, USER_CONFIG, DEFAULT_CONFIG, shipsToCustomer, isCustomerData, customerDefaults, installerProblems, githubRepoUrl } from '../bridge/package-rules.js'

const OUT_NAME = 'CartoonAuto'
const DIST = join(ROOT, 'dist')
const OUT = join(DIST, OUT_NAME)
const zip = process.argv.includes('--zip')

const step = (msg) => console.log(`▸ ${msg}`)
const mb = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`

function dirSize(dir) {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? dirSize(p) : statSync(p).size
  }
  return total
}

function which(bin) {
  try {
    return execFileSync('where', [bin], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith('.exe'))?.trim() ?? null
  } catch {
    return null
  }
}

// ── setup.exe ต้องตรงกับ native/setup.cs เสมอ — คอมไพล์ใหม่ก่อนคัดลอก ──
step('คอมไพล์ setup.exe')
execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-setup.mjs')], { stdio: 'inherit' })

// ── เริ่มจากโฟลเดอร์ว่าง ──
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ── 1. โค้ด ──
// --others --exclude-standard: รวมไฟล์ใหม่ที่ยังไม่ commit ด้วย (ไม่งั้นโค้ดที่เพิ่งเขียนหาย โปรแกรมลูกค้าเปิดไม่ขึ้น) แต่ยังเคารพ .gitignore
step('คัดลอกโค้ด (ไฟล์ที่ git ติดตาม + ไฟล์ใหม่ที่ไม่ได้ ignore)')
const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
let copied = 0
const shipped = [] // รายชื่อไฟล์โค้ดในแพ็กเกจ → VERSION.json ให้ตัวอัปเดตรู้ว่าไฟล์ไหนถูกลบออกในรุ่นใหม่
for (const rel of tracked) {
  if (!shipsToCustomer(rel)) continue
  const src = join(ROOT, rel)
  if (!existsSync(src)) continue // ลบในเครื่องแล้วแต่ยังไม่ commit
  const dest = join(OUT, rel)
  mkdirSync(dirname(dest), { recursive: true })
  if (RESET[rel] !== undefined) writeFileSync(dest, RESET[rel])
  else copyFileSync(src, dest)
  if (rel !== USER_CONFIG && !isCustomerData(rel)) shipped.push(rel)
  copied++
}
console.log(`  ${copied} ไฟล์`)

// การตั้งค่า: ส่งเป็น default.config.json เท่านั้น — ไม่ส่ง project.config.json (ไฟล์ค่าของลูกค้า)
// ลูกค้าวางแพ็กเกจรุ่นใหม่ทับโฟลเดอร์เดิม ค่าที่ตั้งไว้จึงไม่ถูกทับ (ดู loadConfig ใน pipeline/lib/config.mjs)
// ใช้ค่าปัจจุบันของเราเป็นค่าเริ่มต้น แต่ล้างสิ่งที่ผูกกับบัญชี/เครื่องของเรา
{
  const userFile = join(OUT, USER_CONFIG)
  const config = JSON.parse(readFileSync(userFile, 'utf8'))
  rmSync(userFile)
  writeFileSync(join(OUT, DEFAULT_CONFIG), JSON.stringify(customerDefaults(config), null, 2) + '\n')
}

// ── 2. runtime ──
step('แถม node')
mkdirSync(join(OUT, 'runtime', 'node'), { recursive: true })
copyFileSync(process.execPath, join(OUT, 'runtime', 'node', 'node.exe'))

step('แถม ffmpeg + ffprobe')
const ffmpeg = which('ffmpeg')
const ffprobe = which('ffprobe')
if (!ffmpeg || !ffprobe) throw new Error('ไม่พบ ffmpeg/ffprobe ใน PATH ของเครื่องนี้ — winget install Gyan.FFmpeg ก่อนสร้างแพ็กเกจ')
mkdirSync(join(OUT, 'runtime', 'ffmpeg'), { recursive: true })
copyFileSync(ffmpeg, join(OUT, 'runtime', 'ffmpeg', 'ffmpeg.exe'))
copyFileSync(ffprobe, join(OUT, 'runtime', 'ffmpeg', 'ffprobe.exe'))

step('แถม Python + edge-tts (เสียง Edge)')
const edgeVenv = join(ROOT, 'tts', '.venv-edge')
const cfg = join(edgeVenv, 'pyvenv.cfg')
if (!existsSync(cfg)) throw new Error('ไม่พบ tts/.venv-edge — สร้างด้วย: py -3.10 -m venv tts\\.venv-edge && tts\\.venv-edge\\Scripts\\pip install edge-tts')
const home = /^home\s*=\s*(.+)$/m.exec(readFileSync(cfg, 'utf8'))?.[1]?.trim()
if (!home || !existsSync(join(home, 'python.exe'))) throw new Error(`ไม่พบ Python ต้นทางของ .venv-edge (${home})`)
const py = join(OUT, 'runtime', 'python')
// Python ที่ติดตั้งปกติบน Windows ย้ายที่ได้ (ไม่ผูก path) — ตัดส่วนที่ไม่ใช้ออกให้เล็กลง
cpSync(home, py, {
  recursive: true,
  filter: (src) => !/[\\/](Lib[\\/](test|idlelib|tkinter|turtledemo|ensurepip|lib2to3)|tcl|Doc|Tools|include|libs|__pycache__)([\\/]|$)/i.test(src.slice(home.length)),
})
// แพ็กเกจของ venv (edge-tts + aiohttp …) วางลง site-packages ของ Python ตัวนี้
cpSync(join(edgeVenv, 'Lib', 'site-packages'), join(py, 'Lib', 'site-packages'), {
  recursive: true,
  filter: (src) => !/__pycache__/.test(src),
})
const check = execFileSync(join(py, 'python.exe'), ['-c', 'import edge_tts, sys; print(edge_tts.__version__, sys.version.split()[0])'], {
  encoding: 'utf8',
  env: { ...process.env, PYTHONHOME: '', PYTHONPATH: '' },
}).trim()
console.log(`  edge-tts ${check.split(' ')[0]} · Python ${check.split(' ')[1]}`)

// ใบอนุญาตของโปรแกรมที่แถม — ffmpeg (GPL) ต้องบอกที่มาของซอร์สโค้ดเมื่อแจกต่อ
writeFileSync(join(OUT, 'runtime', 'LICENSES.txt'), [
  'โปรแกรมที่แถมมาในโฟลเดอร์ runtime — แจกต่อได้ตามใบอนุญาตของแต่ละตัว',
  '',
  `node/      Node.js ${process.version} — MIT License · https://github.com/nodejs/node/blob/main/LICENSE`,
  `ffmpeg/    ${execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split(/\r?\n/)[0]}`,
  '           GPL v3 · ซอร์สโค้ด: https://ffmpeg.org/download.html · build: https://www.gyan.dev/ffmpeg/builds/',
  '           ffmpeg.exe และ ffprobe.exe ไม่ได้ถูกแก้ไข — ขอซอร์สโค้ดฉบับตรงรุ่นได้จากลิงก์ด้านบน',
  `python/    Python ${check.split(' ')[1]} — PSF License · https://docs.python.org/3/license.html`,
  '           พร้อม edge-tts (LGPL-3.0) และแพ็กเกจที่ใช้ร่วม (aiohttp ฯลฯ) ใน python/Lib/site-packages',
  '',
].join('\r\n'))

// รุ่นของแพ็กเกจ — บอกลูกค้าและผู้ดูแลว่ามาจาก commit ไหน
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
// ลูกค้าอัปเดตเองจาก GitHub (bridge/update-package.js) — ต้องรู้ repo และสาขาที่ push ขึ้นไป
const upstream = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'origin/main'
  }
})()
const [remoteName, ...branchParts] = upstream.split('/')
const repo = githubRepoUrl(execFileSync('git', ['remote', 'get-url', remoteName], { cwd: ROOT, encoding: 'utf8' }))
if (!repo) console.warn('  ⚠️ remote ไม่ใช่ GitHub — แพ็กเกจนี้อัปเดตเองไม่ได้')
if (dirty) console.warn('  ⚠️ มีงานที่ยังไม่ commit — ลูกค้าอัปเดตเองได้เฉพาะของที่ push ขึ้น GitHub แล้ว')
writeFileSync(join(OUT, 'VERSION.json'), JSON.stringify({ commit, sha, dirty, builtAt: new Date().toISOString(), repo, branch: branchParts.join('/') || 'main', files: shipped.sort() }, null, 2) + '\n')

writeFileSync(join(OUT, 'อ่านก่อนใช้งาน.txt'), [
  'Cartoon Auto — ระบบทำคลิปการ์ตูนอัตโนมัติ',
  '',
  'สิ่งที่ต้องมี: Windows 10/11 · Google Chrome ที่ล็อกอิน ChatGPT และ Google Flow ไว้',
  '(ไม่ต้องติดตั้ง Node.js / ffmpeg / Python เอง — แถมมาในโฟลเดอร์ runtime แล้ว)',
  '',
  'วิธีติดตั้ง (ครั้งเดียว)',
  '  1. แตกไฟล์ zip ก่อน (คลิกขวา → แตกไฟล์ทั้งหมด / Extract All) วางไว้ที่ไหนก็ได้ เช่น D:\\CartoonAuto',
  '     อย่าเปิดจากในไฟล์ zip โดยตรง และอย่าวางใน Downloads ที่อาจถูกลบ',
  '  2. ดับเบิลคลิก setup.exe — ทุกอย่างลงเอง ไม่ต้องกด next รอจนขึ้นหน้าต่างสรุป',
  '     (ถ้า Windows ขึ้น "Windows protected your PC" ให้กด More info → Run anyway)',
  '  3. ขั้นเดียวที่ต้องทำเองใน Chrome (Chrome ไม่ยอมให้โปรแกรมทำแทน) — ตัวติดตั้งเปิดหน้าให้และบอกทีละขั้น:',
  '     เปิด Developer mode → Load unpacked → กด Ctrl+V (คัดลอกที่อยู่ไว้ให้แล้ว) → Select Folder',
  '     ถ้าเคยโหลด Cartoon Auto จากโฟลเดอร์นี้ไว้แล้ว ขั้นนี้ข้ามไปเอง',
  '  4. กดไอคอน Cartoon Auto บนแถบ Chrome — โปรแกรมเปิดเอง → ในแผงข้างกด "ตรวจความพร้อม"',
  '',
  'ย้ายโฟลเดอร์ทีหลัง / มีอะไรพัง → ดับเบิลคลิก setup.exe อีกครั้ง (รันซ้ำได้ งานไม่หาย)',
  'ถ้าโปรแกรมป้องกันไวรัสบล็อก setup.exe → ดับเบิลคลิก ติดตั้งครั้งแรก.bat แทน (ทำงานเหมือนกัน)',
  'อัปเดตเป็นรุ่นใหม่ → โปรแกรมตรวจเองทุก 30 นาที มีรุ่นใหม่จะขึ้นแถบ "มีอัปเดตใหม่" ในแผงข้าง กด "อัปเดต" ได้เลย',
  '                    (การตั้งค่า งานคลิป และเสียงที่ทำไว้ไม่หาย · อัปเดตได้เมื่อไม่ได้ทำคลิปอยู่)',
  '',
  `รุ่น ${commit}${dirty ? ' (+ งานที่ยังไม่ commit)' : ''} · สร้างเมื่อ ${new Date().toLocaleString('th-TH')}`,
  '',
].join('\r\n'))

// ── ตัวติดตั้งต้องอยู่ครบและอ่านได้บนเครื่องลูกค้า ──
step('ตรวจไฟล์ตัวติดตั้ง')
{
  const bad = installerProblems((f) => (existsSync(join(OUT, f)) ? readFileSync(join(OUT, f)) : null))
  // ชื่อ "setup" ทำให้ Windows ขอสิทธิ์ admin เองถ้าไม่มี manifest asInvoker — ลงทะเบียนจะไปผิดบัญชีผู้ใช้
  if (existsSync(join(OUT, 'setup.exe')) && !readFileSync(join(OUT, 'setup.exe'), 'latin1').includes('asInvoker')) bad.push('setup.exe ไม่มี manifest asInvoker')
  if (existsSync(join(OUT, 'native', 'host.bat')) || readdirSync(join(OUT, 'native')).some((f) => f.endsWith('.json'))) bad.push('native/ มีไฟล์ลงทะเบียนของเครื่องนี้ติดไป')
  if (bad.length) {
    rmSync(OUT, { recursive: true, force: true })
    console.error(`\n❌ หยุด — ตัวติดตั้งในแพ็กเกจไม่พร้อม (ลบแพ็กเกจทิ้งแล้ว):\n  ${bad.join('\n  ')}`)
    process.exit(1)
  }
  console.log('  ตัวติดตั้งครบ')
}

// ── 3. สแกนหาความลับของเครื่องนี้ในแพ็กเกจ ──
step('ตรวจว่าไม่มี API key / token ของเราติดไป')
const secrets = []
const envFile = join(ROOT, '.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]+)"?\s*$/.exec(line)
    if (m && m[2].trim().length >= 12) secrets.push({ name: m[1], value: m[2].trim() })
  }
}
const leaks = []
const scan = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (p === join(OUT, 'runtime')) continue // ไบนารีของ node/ffmpeg/python ไม่ได้มาจากเรา
      scan(p)
      continue
    }
    if (statSync(p).size > 5 * 1048576) continue
    const text = readFileSync(p, 'latin1')
    for (const s of secrets) if (text.includes(Buffer.from(s.value, 'utf8').toString('latin1'))) leaks.push(`${p.slice(OUT.length + 1)} มีค่า ${s.name}`)
  }
}
scan(OUT)
for (const bad of ['.env', join('tts', 'voices'), 'projects' + '/' + '_autopilot_last.json', join('bridge', 'jobs.json')]) {
  const p = join(OUT, bad)
  if (existsSync(p) && (bad !== join('tts', 'voices') || readdirSync(p).some((f) => statSync(join(p, f)).isDirectory()))) leaks.push(`${bad} ไม่ควรอยู่ในแพ็กเกจ`)
}
if (leaks.length) {
  rmSync(OUT, { recursive: true, force: true })
  console.error(`\n❌ หยุด — พบข้อมูลส่วนตัวในแพ็กเกจ (ลบแพ็กเกจทิ้งแล้ว):\n  ${leaks.join('\n  ')}`)
  process.exit(1)
}
console.log(`  ตรวจ ${secrets.length} ค่าจาก .env — ไม่พบในแพ็กเกจ`)

const size = dirSize(OUT)
console.log(`\n✅ แพ็กเกจพร้อม: ${OUT} (${mb(size)})`)

if (zip) {
  step('บีบอัดเป็น zip (ใช้เวลาสักครู่)')
  const zipFile = join(DIST, `${OUT_NAME}.zip`)
  rmSync(zipFile, { force: true })
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${OUT.replace(/'/g, "''")}' -DestinationPath '${zipFile.replace(/'/g, "''")}' -CompressionLevel Optimal`], { stdio: 'inherit' })
  console.log(`✅ ${zipFile} (${mb(statSync(zipFile).size)})`)
}
console.log(`\nส่งให้ลูกค้า: ${zip ? `${OUT_NAME}.zip` : `โฟลเดอร์ ${basename(OUT)}`} — ลูกค้าแตกไฟล์/วาง แล้วดับเบิลคลิก setup.exe`)
