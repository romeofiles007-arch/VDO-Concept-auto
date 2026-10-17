#!/usr/bin/env node
/**
 * สร้างแพ็กเกจส่งลูกค้า — ลูกค้าคัดลอกโฟลเดอร์ไปวาง ดับเบิลคลิก ติดตั้งครั้งแรก.bat แล้วใช้ได้เลย
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

const OUT_NAME = 'CartoonAuto'
const DIST = join(ROOT, 'dist')
const OUT = join(DIST, OUT_NAME)
const zip = process.argv.includes('--zip')

/** ไฟล์ที่ git ติดตาม แต่ไม่ควรไปถึงลูกค้า */
const EXCLUDE = [
  /^\.impeccable\//,
  /^docs\/design\//,
  /^scripts\/(test-|preview-|selftest|build-icons|build-package)/,
  /^\.claude\//,
  /^Ex sample audio/,
  /^DESIGN\.md$/,
  /^PRODUCT\.md$/,
  /^extension\/agents\/.*PROMPT.*\.md$/,
]

/** ไฟล์ข้อมูลที่ git ติดตาม แต่เป็นของเรา — ลูกค้าได้ค่าว่างแทน */
const RESET = {
  'projects/topics.json': '[]\n',
  'projects/_topic_history.json': '[]\n',
}

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

// ── เริ่มจากโฟลเดอร์ว่าง ──
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ── 1. โค้ด ──
// --others --exclude-standard: รวมไฟล์ใหม่ที่ยังไม่ commit ด้วย (ไม่งั้นโค้ดที่เพิ่งเขียนหาย โปรแกรมลูกค้าเปิดไม่ขึ้น) แต่ยังเคารพ .gitignore
step('คัดลอกโค้ด (ไฟล์ที่ git ติดตาม + ไฟล์ใหม่ที่ไม่ได้ ignore)')
const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
let copied = 0
for (const rel of tracked) {
  if (EXCLUDE.some((re) => re.test(rel))) continue
  const src = join(ROOT, rel)
  if (!existsSync(src)) continue // ลบในเครื่องแล้วแต่ยังไม่ commit
  const dest = join(OUT, rel)
  mkdirSync(dirname(dest), { recursive: true })
  if (RESET[rel] !== undefined) writeFileSync(dest, RESET[rel])
  else copyFileSync(src, dest)
  copied++
}
console.log(`  ${copied} ไฟล์`)

// การตั้งค่า: ส่งเป็น default.config.json เท่านั้น — ไม่ส่ง project.config.json (ไฟล์ค่าของลูกค้า)
// ลูกค้าวางแพ็กเกจรุ่นใหม่ทับโฟลเดอร์เดิม ค่าที่ตั้งไว้จึงไม่ถูกทับ (ดู loadConfig ใน pipeline/lib/config.mjs)
// ใช้ค่าปัจจุบันของเราเป็นค่าเริ่มต้น แต่ล้างสิ่งที่ผูกกับบัญชี/เครื่องของเรา
{
  const userFile = join(OUT, 'config', 'project.config.json')
  const config = JSON.parse(readFileSync(userFile, 'utf8'))
  rmSync(userFile)
  if (config.tts?.elevenlabs) Object.assign(config.tts.elevenlabs, { voiceId: '', voiceName: '' })
  // เสียงที่โคลนไว้ไม่ได้ติดไปด้วย → ลูกค้าเริ่มที่เสียง Edge ซึ่งใช้ได้ทันที
  if (config.tts?.engine !== 'edge') config.tts.engine = 'edge'
  if (config.clips) config.clips.provider = 'off' // Kie มีค่าใช้จ่าย — ให้ลูกค้าเปิดเองเมื่อมี key
  writeFileSync(join(OUT, 'config', 'default.config.json'), JSON.stringify(config, null, 2) + '\n')
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
writeFileSync(join(OUT, 'VERSION.json'), JSON.stringify({ commit, dirty, builtAt: new Date().toISOString() }, null, 2) + '\n')

writeFileSync(join(OUT, 'อ่านก่อนใช้งาน.txt'), [
  'Cartoon Auto — ระบบทำคลิปการ์ตูนอัตโนมัติ',
  '',
  'สิ่งที่ต้องมี: Windows 10/11 · Google Chrome ที่ล็อกอิน ChatGPT และ Google Flow ไว้',
  '(ไม่ต้องติดตั้ง Node.js / ffmpeg / Python — แถมมาในโฟลเดอร์ runtime แล้ว)',
  '',
  'วิธีติดตั้ง (ครั้งเดียว)',
  '  1. วางโฟลเดอร์นี้ไว้ที่ไหนก็ได้ เช่น D:\\CartoonAuto (อย่าวางใน Downloads ที่อาจถูกลบ)',
  '  2. ดับเบิลคลิก ติดตั้งครั้งแรก.bat — Chrome จะเปิดหน้า extensions ให้เอง',
  '  3. ทำตามขั้นที่ขึ้นในหน้าต่างดำ (เปิด Developer mode → Load unpacked → วางที่อยู่ที่คัดลอกไว้ให้)',
  '  4. กดไอคอน Cartoon Auto บนแถบ Chrome — โปรแกรมเปิดเอง',
  '',
  'ย้ายโฟลเดอร์ทีหลัง → ดับเบิลคลิก ติดตั้งครั้งแรก.bat อีกครั้ง',
  'อัปเดตเป็นรุ่นใหม่ → ดับเบิลคลิก ปิดโปรแกรม.bat ก่อน แล้วแตกไฟล์รุ่นใหม่วางทับโฟลเดอร์เดิม (เลือก "แทนที่ไฟล์")',
  '                    การตั้งค่า งานคลิป และเสียงที่ทำไว้ไม่หาย',
  '',
  `รุ่น ${commit}${dirty ? ' (+ งานที่ยังไม่ commit)' : ''} · สร้างเมื่อ ${new Date().toLocaleString('th-TH')}`,
  '',
].join('\r\n'))

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
console.log(`\nส่งให้ลูกค้า: ${zip ? `${OUT_NAME}.zip` : `โฟลเดอร์ ${basename(OUT)}`} — ลูกค้าแตกไฟล์/วาง แล้วดับเบิลคลิก ติดตั้งครั้งแรก.bat`)
