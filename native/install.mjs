#!/usr/bin/env node
/**
 * ตัวติดตั้ง Cartoon Auto — setup.exe (native/setup.cs) หรือ ติดตั้งครั้งแรก.bat → native/bootstrap.ps1 หา/ลง Node.js → ไฟล์นี้
 * ลูกค้าดับเบิลคลิกครั้งเดียว ไม่ต้องกด next — ทุกขั้นเงียบ รันซ้ำได้ทุกเมื่อ (ย้ายโฟลเดอร์ / อัปเดต / ซ่อม)
 *
 *   1. ของที่โปรแกรมต้องใช้: ffmpeg + ffprobe, Python + edge-tts (เสียง Edge)
 *      ใช้ตัวที่แถมมาใน runtime/ ก่อน → ตัวที่ลงไว้ในเครื่อง → ไม่มีจึงดาวน์โหลดมาวางใน runtime/ (ไม่แตะ PATH ของระบบ)
 *   2. ลงทะเบียน native host กับ Chrome (และ Edge) — HKCU ของผู้ใช้คนนี้ ไม่ต้องใช้ admin
 *   3. ทดสอบจริงแบบเดียวกับที่ Chrome เรียก: อ่าน registry → manifest → cmd /c host.bat → ส่ง { type: 'ensure' }
 *      → bridge ต้องเปิดขึ้นและตอบ แล้วถาม /api/checklist ว่าเครื่องยังขาดอะไรที่จำเป็น
 *   4. สร้าง shortcut "Cartoon Auto" บนเดสก์ท็อปและ Start menu
 *   5. ตรวจว่า Chrome โหลด extension ไว้แล้วหรือยัง — ขั้น Load unpacked เป็นขั้นเดียวที่ Chrome ไม่ยอมให้โปรแกรมทำแทน
 *      ถ้ายัง: เปิดหน้า chrome://extensions + คัดลอกที่อยู่โฟลเดอร์ไว้ให้ แล้วรอจนโหลดเสร็จ
 *   6. สรุปเป็นภาษาไทยในหน้าต่างป๊อปอัป: พร้อมแล้ว หรือพังตรงไหน ต้องทำอะไรต่อ
 *
 *   node native/install.mjs                  ติดตั้งเต็ม
 *   node native/install.mjs --uninstall      ถอนการลงทะเบียน + ลบ shortcut
 *   node native/install.mjs --no-register    เขียนไฟล์ host อย่างเดียว ไม่แตะ registry / Chrome (ใช้ทดสอบ)
 *   --quiet            ไม่มีป๊อปอัป ไม่รอ extension (ใช้ทดสอบ / สคริปต์)
 *   --no-wait          เปิดหน้า chrome://extensions + คัดลอกที่อยู่ให้ แต่ไม่รอและไม่มีป๊อปอัป (ให้ตัวติดตั้ง Inno Setup เรียกแบบซ่อนหน้าต่าง)
 *   --no-download      ไม่ดาวน์โหลดอะไร (ขาดก็รายงานว่าขาด)
 *   --no-shortcut      ไม่สร้าง shortcut
 *   --shortcut-dir=X   สร้าง shortcut ไว้ที่โฟลเดอร์ X แทนเดสก์ท็อป/Start menu (ใช้ทดสอบ)
 *   env CARTOON_AUTO_HOST=ชื่อ   ลงทะเบียนเป็นชื่อ host อื่น (ใช้ทดสอบโดยไม่ทับตัวจริงของเครื่องนักพัฒนา)
 */
import { writeFileSync, readFileSync, rmSync, existsSync, readdirSync, mkdirSync, copyFileSync, rmdirSync, symlinkSync, realpathSync, createWriteStream, lstatSync, chmodSync, renameSync, readlinkSync, cpSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { join, dirname, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/**
 * Mac ใช้ตัวติดตั้งไฟล์นี้ตัวเดียวกัน — ติดตั้งครั้งแรก (for Mac).command → native/bootstrap.sh หา/ลง Node.js → ไฟล์นี้
 * ขั้นเหมือน Windows ทุกข้อ ต่างแค่วิธีทำ: ลงทะเบียน Chrome ด้วยไฟล์ JSON แทน registry · shortcut เป็น .app แทน .lnk
 * ป๊อปอัปด้วย osascript แทน PowerShell · ffmpeg / Python รุ่น macOS (Apple Silicon หรือ Intel ตามเครื่อง)
 */
const MAC = process.platform === 'darwin'
const SETUP = MAC ? 'ติดตั้งครั้งแรก (for Mac).command' : 'setup.exe'

const HOST = process.env.CARTOON_AUTO_HOST || 'com.cartoon_auto.bridge'
const DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(DIR, '..')
const RUNTIME = join(ROOT, 'runtime')
const EXTENSION_DIR = join(ROOT, 'extension')
const REG_KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST}`,
]
// Mac: Chrome / Edge หา native host จากไฟล์ JSON ในโฟลเดอร์เหล่านี้ (ของผู้ใช้คนนี้ ไม่ต้องใช้ admin)
const APP_SUPPORT = join(homedir(), 'Library', 'Application Support')
const MAC_HOST_DIRS = [
  { name: 'Chrome', app: join(APP_SUPPORT, 'Google', 'Chrome'), dir: join(APP_SUPPORT, 'Google', 'Chrome', 'NativeMessagingHosts') },
  { name: 'Edge', app: join(APP_SUPPORT, 'Microsoft Edge'), dir: join(APP_SUPPORT, 'Microsoft Edge', 'NativeMessagingHosts') },
]
const manifestFile = join(DIR, `${HOST}.json`)
const batFile = join(DIR, MAC ? 'host.sh' : 'host.bat')
const SHORTCUT_NAME = 'Cartoon Auto.lnk'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
const quiet = flag('--quiet')
const noWait = flag('--no-wait')
const noDownload = flag('--no-download')

const id = readFileSync(join(DIR, 'extension-id.txt'), 'utf8').trim()

// ── ผลแต่ละขั้น → สรุปตอนจบ ──
const results = [] // { label, ok, detail, fix? }
const report = (label, ok, detail = '', fix = '') => {
  results.push({ label, ok, detail, fix })
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok && fix) console.log(`    → ${fix}`)
}
const step = (msg) => console.log(`\n▸ ${msg}`)

/** รัน PowerShell 5 (มีทุกเครื่อง) — ส่งข้อความภาษาไทยเข้า-ออกผ่าน base64 กันเพี้ยนตาม code page */
function powershell(script, { timeout = 60_000 } = {}) {
  const wrapped = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped], { encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const psText = (text) => `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(text)}')))`

// ════════════════════════ ดาวน์โหลด ════════════════════════
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`

/** ดาวน์โหลดลงไฟล์ พร้อมบอกความคืบหน้า — คืน sha256 ของไฟล์ */
async function download(url, dest, label) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) })
  if (!res.ok) throw new Error(`ดาวน์โหลด${label}ไม่ได้ (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  const hash = createHash('sha256')
  let got = 0
  let shown = -1
  const meter = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk)
      got += chunk.length
      const pct = total ? Math.floor((got / total) * 10) : -1
      if (total && pct !== shown) {
        shown = pct
        process.stdout.write(`\r    ${label} ${mb(got)} / ${mb(total)}   `)
      }
      done(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(dest))
  if (total) process.stdout.write('\n')
  return hash.digest('hex')
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.text()
}

/** แตก zip — tar.exe มีใน Windows 10 1803 ขึ้นไป ไม่มีจึงใช้ PowerShell */
function unzip(zip, dest) {
  mkdirSync(dest, { recursive: true })
  if (MAC) return execFileSync('/usr/bin/unzip', ['-q', '-o', zip, '-d', dest], { stdio: 'ignore' })
  try {
    execFileSync('tar.exe', ['-xf', zip, '-C', dest], { stdio: 'ignore', windowsHide: true })
  } catch {
    powershell(`Expand-Archive -LiteralPath ${psText(zip)} -DestinationPath ${psText(dest)} -Force`, { timeout: 10 * 60_000 })
  }
}

function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    } else if (e.name.toLowerCase() === name.toLowerCase()) return p
  }
  return null
}

async function withTemp(fn) {
  const dir = join(tmpdir(), `cartoon-auto-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** คำสั่งนี้รันได้ไหม (หาใน PATH หรือ path เต็ม) → บรรทัดแรกของผลลัพธ์ หรือ null */
function probe(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).split(/\r?\n/)[0].trim()
  } catch {
    return null
  }
}

// ════════════════════════ 1. ffmpeg ════════════════════════
/**
 * แหล่ง ffmpeg + SHA256 ที่ผู้สร้างประกาศไว้ เรียงตามที่ควรลองก่อน
 * GitHub (BtbN — build แบบ static รุ่น release ล่าสุด) เร็ว · gyan.dev ช้ามาก (~40 KB/s) ใช้เป็นทางสำรอง
 * ชื่อไฟล์ของ BtbN เคยเปลี่ยนแบบ (ffmpeg-n8.0-latest-win64-gpl-8.0.zip → ffmpeg-n9.0.2-39-g7adfbe40dc-win64-gpl-9.0.zip)
 * จึงรับทั้งสองแบบ และไม่เอารุ่น -shared (ต้องพก DLL)
 */
async function* ffmpegSources() {
  try {
    const base = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/'
    const sums = (await fetchText(`${base}checksums.sha256`)).split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter(([h, n]) => /^[0-9a-f]{64}$/i.test(h) && n)
    const version = (n) => (/^ffmpeg-n([\d.]+)(?:-latest|-\d+-g[0-9a-f]+)?-win64-gpl-[\d.]+\.zip$/.exec(n)?.[1] ?? '').split('.').filter(Boolean).map(Number)
    const newer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); return false }
    const pick = sums.filter(([, n]) => version(n).length).sort(([, a], [, b]) => (newer(version(a), version(b)) ? -1 : 1))[0]
    if (pick) yield { url: base + pick[1], sha256: pick[0].toLowerCase() }
  } catch {}
  const url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
  const sha256 = (await fetchText(`${url}.sha256`)).trim().split(/\s+/)[0].toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('หาไฟล์ ffmpeg สำหรับดาวน์โหลดไม่เจอ')
  yield { url, sha256 }
}

// ── Mac ──
// Chrome เปิด bridge ด้วย PATH แบบสั้น (/usr/bin:/bin:…) ที่ไม่มี Homebrew — pipeline/lib/config.mjs ใส่โฟลเดอร์ Homebrew ให้
const MAC_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const BREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
const brewBin = (name) => BREW_DIRS.map((d) => join(d, name)).find((p) => existsSync(p)) ?? null

/** ไฟล์ที่ดาวน์โหลดมาเองต้องรันได้: chmod +x · Apple Silicon ไม่ยอมรันโปรแกรมที่ไม่มีลายเซ็น → เซ็นแบบ ad-hoc ให้ */
function makeRunnable(file) {
  chmodSync(file, 0o755)
  try { execFileSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', file], { stdio: 'ignore' }) } catch {}
  if (probe(file, ['-version'])) return true
  try { execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', file], { stdio: 'ignore', timeout: 60_000 }) } catch {}
  return !!probe(file, ['-version'])
}

/**
 * ffmpeg สำหรับ macOS — build แบบ static ของ ffmpeg.martin-riedl.de (มีทั้ง Apple Silicon และ Intel พร้อม SHA256)
 * หน้าแรกของเว็บมีลิงก์รุ่น release ล่าสุด: /download/macos/<arm64|amd64>/<เวลา>_<รุ่น>/ffmpeg.zip
 * รุ่น snapshot (ชื่อขึ้นต้น N-) ไม่เอา
 */
async function ensureFfmpegMac() {
  const local = join(RUNTIME, 'ffmpeg')
  const works = () => probe(join(local, 'ffmpeg'), ['-version']) && probe(join(local, 'ffprobe'), ['-version'])
  if (works()) return report('ffmpeg', true, 'มีอยู่ใน runtime/ffmpeg แล้ว')
  if (brewBin('ffmpeg') && brewBin('ffprobe') && probe(brewBin('ffmpeg'), ['-version'])) return report('ffmpeg', true, `ใช้ตัวที่ลงไว้ในเครื่อง (${dirname(brewBin('ffmpeg'))})`)
  if (noDownload) return report('ffmpeg', false, 'ไม่พบในเครื่อง', 'รันตัวติดตั้งอีกครั้งโดยต่ออินเทอร์เน็ต')
  try {
    const site = 'https://ffmpeg.martin-riedl.de'
    const arch = MAC_ARCH === 'arm64' ? 'arm64' : 'amd64'
    const page = await fetchText(`${site}/`)
    const builds = [...page.matchAll(new RegExp(`/download/macos/${arch}/(\\d+)_(\\d[\\d.]*)/ffmpeg\\.zip"`, 'g'))].map((m) => ({ ts: Number(m[1]), dir: `${site}/download/macos/${arch}/${m[1]}_${m[2]}` }))
    const latest = builds.sort((a, b) => b.ts - a.ts)[0]
    if (!latest) throw new Error('หาไฟล์ ffmpeg สำหรับ Mac ไม่เจอ')
    console.log('    ดาวน์โหลด ffmpeg + ffprobe (~60 MB) — ครั้งแรกครั้งเดียว')
    await withTemp(async (tmp) => {
      mkdirSync(local, { recursive: true })
      for (const name of ['ffmpeg', 'ffprobe']) {
        const zip = join(tmp, `${name}.zip`)
        const sha256 = (await fetchText(`${latest.dir}/${name}.zip.sha256`)).trim().split(/\s+/)[0].toLowerCase()
        const got = await download(`${latest.dir}/${name}.zip`, zip, name)
        if (got !== sha256) throw new Error(`ไฟล์ ${name} ที่ดาวน์โหลดเสีย (SHA256 ไม่ตรง) — ลองใหม่อีกครั้ง`)
        unzip(zip, join(tmp, name))
        const bin = findFile(join(tmp, name), name)
        if (!bin) throw new Error(`แตกไฟล์แล้วไม่พบ ${name}`)
        copyFileSync(bin, join(local, name))
        if (!makeRunnable(join(local, name))) throw new Error(`ดาวน์โหลด ${name} แล้วแต่รันไม่ได้`)
      }
    })
    if (works()) return report('ffmpeg', true, 'ดาวน์โหลดมาไว้ใน runtime/ffmpeg')
    report('ffmpeg', false, 'ดาวน์โหลดแล้วแต่รันไม่ได้', `ดับเบิลคลิก ${SETUP} อีกครั้ง`)
  } catch (err) {
    report('ffmpeg', false, err.message, `ตรวจอินเทอร์เน็ตแล้วดับเบิลคลิก ${SETUP} อีกครั้ง`)
  }
}

async function ensureFfmpeg() {
  if (MAC) return ensureFfmpegMac()
  const local = join(RUNTIME, 'ffmpeg')
  const works = () => probe(join(local, 'ffmpeg.exe'), ['-version']) && probe(join(local, 'ffprobe.exe'), ['-version'])
  if (works()) return report('ffmpeg', true, 'แถมมากับแพ็กเกจ')
  if (probe('ffmpeg', ['-version']) && probe('ffprobe', ['-version'])) return report('ffmpeg', true, 'ใช้ตัวที่ลงไว้ในเครื่อง')
  if (noDownload) return report('ffmpeg', false, 'ไม่พบในเครื่อง', 'รันตัวติดตั้งอีกครั้งโดยต่ออินเทอร์เน็ต')
  let lastError = null
  try {
    console.log('    ดาวน์โหลด ffmpeg (~190 MB) — ครั้งแรกครั้งเดียว')
    for await (const { url, sha256 } of ffmpegSources()) {
      try {
        await withTemp(async (tmp) => {
          const zip = join(tmp, 'ffmpeg.zip')
          const got = await download(url, zip, 'ffmpeg')
          if (got !== sha256) throw new Error('ไฟล์ ffmpeg ที่ดาวน์โหลดเสีย (SHA256 ไม่ตรง) — ลองใหม่อีกครั้ง')
          unzip(zip, join(tmp, 'x'))
          const exe = findFile(join(tmp, 'x'), 'ffmpeg.exe')
          if (!exe || !existsSync(join(dirname(exe), 'ffprobe.exe'))) throw new Error('แตกไฟล์แล้วไม่พบ ffmpeg.exe / ffprobe.exe')
          rmSync(local, { recursive: true, force: true })
          mkdirSync(local, { recursive: true })
          // ffmpeg + ffprobe และ DLL ข้าง ๆ (ถ้าเป็นรุ่นที่ต้องใช้ DLL) — ไม่เอา ffplay (ไม่ได้ใช้ ใหญ่)
          for (const f of readdirSync(dirname(exe))) {
            if (/^(ffmpeg|ffprobe)\.exe$|\.dll$/i.test(f)) copyFileSync(join(dirname(exe), f), join(local, f))
          }
        })
        if (works()) return report('ffmpeg', true, 'ดาวน์โหลดมาไว้ใน runtime\\ffmpeg')
        lastError = new Error('ดาวน์โหลดแล้วแต่รันไม่ได้')
      } catch (err) {
        lastError = err
      }
      console.log(`    ${lastError.message} — ลองอีกแหล่ง`)
    }
  } catch (err) {
    lastError = err
  }
  report('ffmpeg', false, lastError?.message ?? 'ดาวน์โหลดไม่สำเร็จ', /รันไม่ได้/.test(lastError?.message ?? '') ? 'โปรแกรมป้องกันไวรัสอาจบล็อก runtime\\ffmpeg\\ffmpeg.exe' : `ตรวจอินเทอร์เน็ตแล้วดับเบิลคลิก ${SETUP} อีกครั้ง`)
}

// ════════════════════════ 2. Python + edge-tts (เสียง Edge) ════════════════════════
const PY_VERSION = '3.11.9'
const pyEnv = () => {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PIP_DISABLE_PIP_VERSION_CHECK: '1' }
  delete env.PYTHONHOME
  delete env.PYTHONPATH
  return env
}
const hasEdgeTts = (python) => {
  try {
    execFileSync(python, ['-c', 'import edge_tts'], { stdio: 'ignore', windowsHide: true, env: pyEnv(), timeout: 30_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Mac ไม่มี Python มาให้ (/usr/bin/python3 เป็นแค่ตัวชวนลง Xcode) → ใช้ Python แบบพกพาของ python-build-standalone
 * (ชุดเดียวกับที่ uv ใช้ · มี pip ในตัว · ตรวจ SHA256 จากไฟล์ SHA256SUMS ของ release) วางที่ runtime/python
 */
async function ensureEdgeTtsMac() {
  const label = 'เสียงพากย์ Edge (ไทย/อังกฤษ)'
  const venv = join(ROOT, 'tts', '.venv', 'bin', 'python')
  const py = join(RUNTIME, 'python')
  const python = join(py, 'bin', 'python3')
  if (existsSync(venv) && hasEdgeTts(venv)) return report(label, true, 'ใช้ระบบเสียงในเครื่อง (tts/.venv)')
  if (existsSync(python) && hasEdgeTts(python)) return report(label, true, 'มีอยู่ใน runtime/python แล้ว')
  if (noDownload) return report(label, false, 'ยังไม่มี Python + edge-tts', 'รันตัวติดตั้งอีกครั้งโดยต่ออินเทอร์เน็ต')
  try {
    if (!existsSync(python)) {
      const base = 'https://github.com/astral-sh/python-build-standalone/releases'
      const target = MAC_ARCH === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
      const sums = (await fetchText(`${base}/latest/download/SHA256SUMS`)).split(/\r?\n/).map((l) => l.trim().split(/\s+/))
      const re = new RegExp(`^cpython-3\\.11\\.(\\d+)\\+(\\d+)-${target}-install_only\\.tar\\.gz$`)
      const pick = sums.filter(([h, n]) => /^[0-9a-f]{64}$/i.test(h) && re.test(n ?? '')).sort(([, a], [, b]) => Number(re.exec(b)[1]) - Number(re.exec(a)[1]))[0]
      if (!pick) throw new Error('หาไฟล์ Python สำหรับ Mac ไม่เจอ')
      const [sha256, name] = pick
      const tag = re.exec(name)[2]
      console.log(`    ดาวน์โหลด Python 3.11 + edge-tts (~20 MB) — ครั้งแรกครั้งเดียว`)
      await withTemp(async (tmp) => {
        const tgz = join(tmp, 'python.tar.gz')
        const got = await download(`${base}/download/${tag}/${encodeURIComponent(name)}`, tgz, 'Python')
        if (got !== sha256.toLowerCase()) throw new Error('ไฟล์ Python ที่ดาวน์โหลดเสีย (SHA256 ไม่ตรง) — ลองใหม่อีกครั้ง')
        execFileSync('/usr/bin/tar', ['-xzf', tgz, '-C', tmp], { stdio: 'ignore' })
        if (!existsSync(join(tmp, 'python', 'bin', 'python3'))) throw new Error('แตกไฟล์แล้วไม่พบ python3')
        rmSync(py, { recursive: true, force: true })
        mkdirSync(RUNTIME, { recursive: true })
        // คนละไดรฟ์ (โฟลเดอร์โปรแกรมอยู่บนไดรฟ์นอก) ย้ายไม่ได้ → คัดลอก (เก็บ symlink ใน bin/ ไว้ตามเดิม)
        try {
          renameSync(join(tmp, 'python'), py)
        } catch {
          cpSync(join(tmp, 'python'), py, { recursive: true, verbatimSymlinks: true })
        }
      })
    }
    execFileSync(python, ['-m', 'pip', 'install', '-q', '--no-warn-script-location', 'edge-tts'], { env: pyEnv(), timeout: 10 * 60_000, stdio: ['ignore', 'ignore', 'pipe'] })
    const ok = hasEdgeTts(python)
    report(label, ok, ok ? 'ลง Python + edge-tts ไว้ใน runtime/python' : 'ลงแล้วแต่ import edge_tts ไม่ได้', `ดับเบิลคลิก ${SETUP} อีกครั้ง`)
  } catch (err) {
    const why = String(err.stderr ?? '').trim().split(/\r?\n/).pop() || err.message
    report(label, false, why, `ตรวจอินเทอร์เน็ตแล้วดับเบิลคลิก ${SETUP} อีกครั้ง (หรือเลือกเสียง ElevenLabs/Gemini ในแผงข้างแทน)`)
  }
}

async function ensureEdgeTts() {
  if (MAC) return ensureEdgeTtsMac()
  // ลำดับเดียวกับ edgePython() ใน pipeline/lib/cloud_tts.mjs
  const venv = join(ROOT, 'tts', '.venv', 'Scripts', 'python.exe')
  const bundled = join(RUNTIME, 'python', 'python.exe')
  if (existsSync(join(ROOT, 'tts', '.venv', 'Lib', 'site-packages', 'edge_tts')) && hasEdgeTts(venv)) return report('เสียงพากย์ Edge (ไทย/อังกฤษ)', true, 'ใช้ระบบเสียงในเครื่อง (tts\\.venv)')
  if (existsSync(join(RUNTIME, 'python', 'Lib', 'site-packages', 'edge_tts')) && hasEdgeTts(bundled)) return report('เสียงพากย์ Edge (ไทย/อังกฤษ)', true, 'แถมมากับแพ็กเกจ')
  if (noDownload) return report('เสียงพากย์ Edge (ไทย/อังกฤษ)', false, 'ยังไม่มี Python + edge-tts', 'รันตัวติดตั้งอีกครั้งโดยต่ออินเทอร์เน็ต')
  try {
    console.log(`    ดาวน์โหลด Python ${PY_VERSION} + edge-tts (~25 MB) — ครั้งแรกครั้งเดียว`)
    const py = join(RUNTIME, 'python')
    if (!existsSync(join(py, 'python.exe'))) {
      await withTemp(async (tmp) => {
        const zip = join(tmp, 'python.zip')
        await download(`https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`, zip, 'Python')
        mkdirSync(py, { recursive: true })
        unzip(zip, py)
      })
    }
    // Python แบบ embeddable ปิด site-packages ไว้ — เปิดให้ลงแพ็กเกจด้วย pip ได้
    const pth = readdirSync(py).find((f) => /^python\d+\._pth$/i.test(f))
    if (pth) {
      const file = join(py, pth)
      const text = readFileSync(file, 'utf8')
      if (/^#\s*import site/m.test(text)) writeFileSync(file, text.replace(/^#\s*import site/m, 'import site'))
    }
    const python = join(py, 'python.exe')
    const run = (pyArgs) => execFileSync(python, pyArgs, { cwd: py, env: pyEnv(), windowsHide: true, timeout: 10 * 60_000, stdio: ['ignore', 'ignore', 'pipe'] })
    if (!existsSync(join(py, 'Lib', 'site-packages', 'pip'))) {
      const getPip = join(py, 'get-pip.py')
      await download('https://bootstrap.pypa.io/get-pip.py', getPip, 'pip')
      run([getPip, '--no-warn-script-location', '-q'])
      rmSync(getPip, { force: true })
    }
    run(['-m', 'pip', 'install', '-q', '--no-warn-script-location', 'edge-tts'])
    const ok = hasEdgeTts(python)
    report('เสียงพากย์ Edge (ไทย/อังกฤษ)', ok, ok ? 'ลง Python + edge-tts ไว้ใน runtime\\python' : 'ลงแล้วแต่ import edge_tts ไม่ได้', `ดับเบิลคลิก ${SETUP} อีกครั้ง`)
  } catch (err) {
    const why = String(err.stderr ?? '').trim().split(/\r?\n/).pop() || err.message
    report('เสียงพากย์ Edge (ไทย/อังกฤษ)', false, why, `ตรวจอินเทอร์เน็ตแล้วดับเบิลคลิก ${SETUP} อีกครั้ง (หรือเลือกเสียง ElevenLabs/Gemini ในแผงข้างแทน)`)
  }
}

// ════════════════════════ 2.5 การตั้งค่าที่ใช้ได้ทันที + รุ่นของโปรแกรม ════════════════════════
const isDevFolder = () => existsSync(join(ROOT, '.git'))

function envKeys() {
  const keys = {}
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line)
      if (m && m[2].trim()) keys[m[1]] = m[2].trim()
    }
  } catch {}
  return keys
}

/**
 * ZIP ที่โหลดจาก GitHub ตรงๆ มี config/project.config.json ของเครื่องนักพัฒนาติดมา (เสียง ElevenLabs ที่โคลนไว้ · Kie)
 * และแตกทับแล้วทับค่าที่ลูกค้าตั้งไว้ด้วย → ตรวจความพร้อมฟ้อง "ElevenLabs ยังไม่มี API key" (เจอจริง ต.ค. 2026)
 * ของที่ต้องมี key แต่เครื่องนี้ไม่มี → เปลี่ยนเป็นของที่ใช้ได้ทันที (เสียง Edge · ภาพนิ่งแทน Kie) แล้วบอกในสรุป
 */
function ensureUsableSettings() {
  if (isDevFolder()) return // เครื่องนักพัฒนา — ไม่แตะการตั้งค่า
  const file = join(ROOT, 'config', 'project.config.json')
  if (!existsSync(file)) return // แพ็กเกจปกติ — ค่าเริ่มต้นใช้ได้ทันทีอยู่แล้ว
  let config
  try {
    config = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return report('การตั้งค่า', false, 'อ่าน config\\project.config.json ไม่ได้', `ลบไฟล์นั้นทิ้งแล้วดับเบิลคลิก ${SETUP} อีกครั้ง (ระบบใช้ค่าเริ่มต้นแทน)`)
  }
  const keys = envKeys()
  const changes = []
  const tts = config.tts ?? {}
  if (tts.engine === 'elevenlabs' && !(keys.ELEVENLABS_API_KEY && tts.elevenlabs?.voiceId && tts.elevenlabs.voiceId !== '7pvyWmzdRPOd6aNRqaHi')) {
    // Voice ID นี้คือเสียงที่โคลนไว้ในบัญชีของเรา — เครื่องอื่นใช้ไม่ได้แม้มี key ของตัวเอง
    tts.engine = 'edge'
    if (tts.elevenlabs) Object.assign(tts.elevenlabs, { voiceId: '', voiceName: '' })
    changes.push('เสียงพากย์ → Edge (ElevenLabs ยังไม่มี API key / Voice ID ของเครื่องนี้)')
  } else if (tts.engine === 'gemini' && !keys.GEMINI_API_KEY) {
    tts.engine = 'edge'
    changes.push('เสียงพากย์ → Edge (Gemini ยังไม่มี API key)')
  }
  if (config.clips?.provider === 'kie' && !keys.KIE_API_KEY) {
    config.clips.provider = 'off'
    changes.push('แอนิเมชัน Kie → ปิด ใช้ภาพนิ่งแทน (ยังไม่มี Kie API key)')
  }
  if (!changes.length) return
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
  report('ตั้งค่าให้ใช้ได้ทันที', true, changes.join(' · '))
}

/**
 * ติดตั้งจาก ZIP ของ GitHub ตรงๆ (ไม่มี git และไม่มี VERSION.json แบบแพ็กเกจ) → สร้าง VERSION.json ให้
 * ระบบอัปเดตในโปรแกรมจึงดึงรุ่นใหม่เองได้ ไม่ต้องโหลด ZIP มาแตกทับอีก (ซึ่งทับการตั้งค่าของลูกค้า)
 */
function ensureVersionFile() {
  const file = join(ROOT, 'VERSION.json')
  if (isDevFolder() || existsSync(file)) return
  let repo = null
  try {
    repo = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).repository?.url ?? null
  } catch {}
  if (!repo) return
  writeFileSync(file, JSON.stringify({ commit: 'unknown', sha: null, source: 'github-zip', repo: repo.replace(/\.git$/, ''), branch: 'main', files: [], createdAt: new Date().toISOString() }, null, 2) + '\n')
  report('อัปเดตในโปรแกรม', true, 'เปิดใช้แล้ว — มีรุ่นใหม่จะขึ้นแถบ "มีอัปเดตใหม่" ในแผงข้าง')
}

// ════════════════════════ 3. ลงทะเบียน native host ════════════════════════
/**
 * Chrome เรียก host ด้วย `cmd.exe /d /c "<path>" ...` — ถ้า path มี & ^ % ! cmd ตัดคำสั่งผิด (ภาษาไทย เว้นวรรค วงเล็บ ใช้ได้)
 * โฟลเดอร์แบบนั้นจึงลงทะเบียนผ่าน junction ที่ %LOCALAPPDATA%\CartoonAuto\app ซึ่งชี้กลับมาที่โฟลเดอร์นี้
 */
const RISKY = /[&^%!]/
const JUNCTION = join(process.env.LOCALAPPDATA ?? tmpdir(), 'CartoonAuto', 'app')

function removeJunction() {
  try {
    if (lstatSync(JUNCTION).isSymbolicLink()) rmdirSync(JUNCTION) // ลบแค่ตัวลิงก์ — ไม่แตะไฟล์ปลายทาง
  } catch {}
}

function hostDir() {
  removeJunction()
  if (!RISKY.test(ROOT) || RISKY.test(JUNCTION)) return DIR
  try {
    mkdirSync(dirname(JUNCTION), { recursive: true })
    symlinkSync(ROOT, JUNCTION, 'junction')
    return join(JUNCTION, 'native')
  } catch {
    return DIR
  }
}

/** Mac: host.sh — Chrome รันไฟล์นี้ตรงๆ (ไม่ผ่าน shell ของผู้ใช้ · PATH สั้น) จึงอ้าง node ด้วย path เต็มเสมอ */
function writeHostFilesMac() {
  writeFileSync(batFile, [
    '#!/bin/sh',
    '# เขียนโดย native/install.mjs — Chrome เรียกไฟล์นี้เมื่อกดไอคอน extension',
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    'if [ -x "$DIR/../runtime/node/bin/node" ]; then exec "$DIR/../runtime/node/bin/node" "$DIR/host.mjs" "$@"; fi',
    `exec "${process.execPath.replace(/(["\\$`])/g, '\\$1')}" "$DIR/host.mjs" "$@"`,
    '',
  ].join('\n'))
  chmodSync(batFile, 0o755)
  writeFileSync(manifestFile, JSON.stringify(macManifest(), null, 2))
  return batFile
}

const macManifest = () => ({
  name: HOST,
  description: 'Cartoon Auto — เปิดโปรแกรมเมื่อกดไอคอน extension',
  path: batFile,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${id}/`],
})

/** วางไฟล์ลงทะเบียนในโฟลเดอร์ของ Chrome (ต้องมี) และ Edge (เฉพาะเครื่องที่มี Edge) */
function registerMac() {
  for (const { app, dir, name } of MAC_HOST_DIRS) {
    if (name !== 'Chrome' && !existsSync(app)) continue
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${HOST}.json`), JSON.stringify(macManifest(), null, 2))
  }
}

function writeHostFiles() {
  if (MAC) return writeHostFilesMac()
  // Chrome เรียกได้แค่ไฟล์ .exe/.bat — ใช้ node ที่แถม/ดาวน์โหลดไว้ใน runtime ก่อน (อ้างจากที่ตั้งของไฟล์ ย้ายโฟลเดอร์แล้วยังถูก)
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
  const path = join(hostDir(), 'host.bat')
  writeFileSync(manifestFile, JSON.stringify({
    name: HOST,
    description: 'Cartoon Auto — เปิดโปรแกรมเมื่อกดไอคอน extension',
    path,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2))
  return path
}

function register() {
  if (MAC) return registerMac()
  const value = resolve(manifestFile)
  for (const key of REG_KEYS) execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore', windowsHide: true })
}

/** อ่านค่าที่ Chrome จะอ่านจริงจาก registry (ผ่าน base64 — reg.exe พิมพ์ภาษาไทยเพี้ยน) */
function readRegistry(key) {
  if (MAC) {
    // Mac ไม่มี registry — "ค่าที่ลงทะเบียน" คือไฟล์ JSON ในโฟลเดอร์ของเบราว์เซอร์นั้น (key = ชื่อเบราว์เซอร์)
    const file = join(MAC_HOST_DIRS.find((d) => d.name === key)?.dir ?? '', `${HOST}.json`)
    return existsSync(file) ? file : null
  }
  try {
    const path = `Registry::${key.replace(/^HKCU/, 'HKEY_CURRENT_USER')}`
    const out = powershell(`$v = (Get-Item -LiteralPath ${psText(path)}).GetValue(''); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$v))`)
    return Buffer.from(out, 'base64').toString('utf8') || null
  } catch {
    return null
  }
}

/** เรียก host แบบเดียวกับที่ Chrome เรียก แล้วส่ง { type: 'ensure' } → คำตอบของ host */
function callHostLikeChrome(hostPath) {
  return new Promise((done) => {
    const line = `/d /c "${hostPath}" --parent-window=0 chrome-extension://${id}/`
    // Mac: Chrome รัน host ตรงๆ ส่งแค่ origin ของ extension เป็นอาร์กิวเมนต์
    const proc = MAC
      ? spawn(hostPath, [`chrome-extension://${id}/`], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir() } })
      : spawn(process.env.ComSpec || 'cmd.exe', [line], { windowsVerbatimArguments: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = Buffer.alloc(0)
    let err = ''
    const timer = setTimeout(() => {
      proc.kill()
      done({ ok: false, error: 'โปรแกรมไม่ตอบภายใน 60 วินาที' })
    }, 60_000)
    proc.stdout.on('data', (d) => {
      out = Buffer.concat([out, d])
      if (out.length >= 4 && out.length >= 4 + out.readUInt32LE(0)) {
        clearTimeout(timer)
        try {
          done(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString('utf8')))
        } catch (e) {
          done({ ok: false, error: `คำตอบอ่านไม่ได้: ${e.message}` })
        }
      }
    })
    proc.stderr.on('data', (d) => (err += d))
    proc.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: e.message }) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      done({ ok: false, error: `host จบโดยไม่ตอบ (exit ${code}) ${err.trim().split(/\r?\n/).pop() ?? ''}`.trim() })
    })
    const body = Buffer.from(JSON.stringify({ type: 'ensure' }), 'utf8')
    const head = Buffer.alloc(4)
    head.writeUInt32LE(body.length, 0)
    proc.stdin.end(Buffer.concat([head, body]))
  })
}

/** ตรวจทั้งเส้นทางที่ Chrome ใช้ → { ok, info?, problem? } */
async function verifyHost() {
  const manifestPath = readRegistry(MAC ? 'Chrome' : REG_KEYS[0])
  if (!manifestPath) return { ok: false, problem: MAC ? 'ไม่พบไฟล์ลงทะเบียนในโฟลเดอร์ของ Chrome' : 'ไม่พบการลงทะเบียนใน registry ของ Chrome' }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return { ok: false, problem: `อ่านไฟล์ลงทะเบียนไม่ได้ (${manifestPath})` }
  }
  if (manifest.name !== HOST) return { ok: false, problem: 'ชื่อในไฟล์ลงทะเบียนไม่ตรง' }
  if (!manifest.allowed_origins?.includes(`chrome-extension://${id}/`)) return { ok: false, problem: 'extension ID ในไฟล์ลงทะเบียนไม่ตรง' }
  if (!existsSync(manifest.path)) return { ok: false, problem: `ไม่พบไฟล์ ${manifest.path}` }
  const info = await callHostLikeChrome(manifest.path)
  return info?.ok ? { ok: true, info } : { ok: false, problem: info?.error ?? 'host ไม่ตอบ' }
}

/** ถาม bridge ว่าเครื่องยังขาดอะไรที่จำเป็น (ชุดเดียวกับหน้า "ตรวจความพร้อม" ของแผงข้าง) */
async function machineChecklist(info) {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/checklist`, { headers: { 'x-bridge-token': info.token }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    return (await res.json()).items ?? null
  } catch {
    return null
  }
}

// ════════════════════════ 4. shortcut ════════════════════════
// Mac: shortcut = แอปเล็กๆ "Cartoon Auto.app" ใน ~/Applications (ค้นใน Spotlight / Launchpad ได้) + ลิงก์บนเดสก์ท็อป
// ข้างในแค่เรียก native/host.sh --open แบบเดียวกับ เปิดโปรแกรม (for Mac).command แต่ไม่มีหน้าต่าง Terminal โผล่
// สร้างในเครื่องเอง (ไม่ได้ดาวน์โหลด) → macOS ไม่ติดป้ายกักกัน เปิดได้ทันที
const APP_NAME = `${SHORTCUT_NAME.replace(/\.lnk$/i, '')}.app`
const macShortcutDirs = () => option('--shortcut-dir') ? { apps: resolve(option('--shortcut-dir')), desktop: null } : { apps: join(homedir(), 'Applications'), desktop: join(homedir(), 'Desktop') }

function createShortcutsMac() {
  const { apps, desktop } = macShortcutDirs()
  const app = join(apps, APP_NAME)
  rmSync(app, { recursive: true, force: true })
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true })
  const q = (s) => s.replace(/(["\\$`])/g, '\\$1')
  writeFileSync(join(app, 'Contents', 'MacOS', 'launcher'), [
    '#!/bin/sh',
    `# ${ROOT}`,
    `exec "${q(batFile)}" --open`,
    '',
  ].join('\n'))
  chmodSync(join(app, 'Contents', 'MacOS', 'launcher'), 0o755)
  // ไอคอน: แปลง PNG ของ extension เป็น .icns ด้วยเครื่องมือที่มีใน macOS (sips + iconutil) — ไม่ได้ก็ใช้ไอคอนปกติ
  let icon = false
  const png = join(EXTENSION_DIR, 'icons', 'icon-128.png')
  if (existsSync(png)) {
    try {
      withTempSync((tmp) => {
        const set = join(tmp, 'icon.iconset')
        mkdirSync(set)
        for (const size of [16, 32, 64, 128, 256, 512]) execFileSync('/usr/bin/sips', ['-z', String(size), String(size), png, '--out', join(set, `icon_${size}x${size}.png`)], { stdio: 'ignore' })
        execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', join(app, 'Contents', 'Resources', 'icon.icns')], { stdio: 'ignore' })
      })
      icon = true
    } catch {}
  }
  const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  writeFileSync(join(app, 'Contents', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>CFBundleName</key><string>${xml(APP_NAME.replace(/\.app$/, ''))}</string>`,
    '  <key>CFBundleExecutable</key><string>launcher</string>',
    `  <key>CFBundleIdentifier</key><string>com.cartoon-auto.launcher</string>`,
    '  <key>CFBundlePackageType</key><string>APPL</string>',
    '  <key>CFBundleVersion</key><string>1</string>',
    icon ? '  <key>CFBundleIconFile</key><string>icon</string>' : '',
    '</dict></plist>',
    '',
  ].filter(Boolean).join('\n'))
  if (desktop && existsSync(desktop)) {
    const link = join(desktop, APP_NAME)
    try { if (lstatSync(link).isSymbolicLink()) rmSync(link, { force: true }) } catch {}
    if (!existsSync(link)) symlinkSync(app, link)
  }
}

function withTempSync(fn) {
  const dir = join(tmpdir(), `cartoon-auto-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** แอป shortcut ที่สร้างไว้ชี้มาที่โฟลเดอร์นี้ไหม (ดูจากบรรทัดความเห็นใน launcher) */
const macAppPointsHere = (app) => {
  try {
    return readFileSync(join(app, 'Contents', 'MacOS', 'launcher'), 'utf8').split('\n')[1] === `# ${ROOT}`
  } catch {
    return false
  }
}

function createShortcuts() {
  if (MAC) return createShortcutsMac()
  const target = join(ROOT, 'เปิดโปรแกรม.bat')
  const icon = join(EXTENSION_DIR, 'icons', 'icon-128.ico')
  const dirs = option('--shortcut-dir') ? `@(${psText(resolve(option('--shortcut-dir')))})` : `@([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))`
  // ใช้ IShellLinkW (Unicode) ตรง ๆ แทน WScript.Shell — WScript.Shell บันทึกชื่อ/ที่อยู่ภาษาไทยไม่ได้
  // บนเครื่องที่ภาษาระบบ (non-Unicode) ไม่ใช่ไทย ("Command failed" ตอนสร้าง shortcut ในเครื่องลูกค้า ต.ค. 2026)
  powershell([
    `Add-Type -TypeDefinition @'`,
    SHELL_LINK_CS,
    `'@`,
    `foreach ($d in ${dirs}) {`,
    `  if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }`,
    `  [DhammaLnk]::Save((Join-Path $d ${psText(SHORTCUT_NAME)}), ${psText(target)}, ${psText(ROOT)}, ${psText('Cartoon Auto — เปิดโปรแกรมทำคลิปการ์ตูน')}, ${existsSync(icon) ? psText(icon) : "''"}, 7)`,
    `}`,
  ].join('\n'), { timeout: 120_000 })
}

/** สร้าง .lnk ผ่าน IShellLinkW + IPersistFile (Unicode ทั้งหมด) — WindowStyle 7 = ย่อไว้ ไม่แย่งโฟกัส */
const SHELL_LINK_CS = `using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class DhammaShellLink {}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
interface IDhammaShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr fd, uint fl);
  void GetIDList(out IntPtr p);
  void SetIDList(IntPtr p);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int c);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string s);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int c);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string s);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int c);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string s);
  void GetHotkey(out short h);
  void SetHotkey(short h);
  void GetShowCmd(out int c);
  void SetShowCmd(int c);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int c, out int i);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string s, int i);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string s, uint r);
  void Resolve(IntPtr h, uint f);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string s);
}
public static class DhammaLnk {
  public static void Save(string lnk, string target, string dir, string desc, string icon, int show) {
    var l = (IDhammaShellLinkW)new DhammaShellLink();
    l.SetPath(target);
    l.SetWorkingDirectory(dir);
    l.SetDescription(desc);
    if (!String.IsNullOrEmpty(icon)) l.SetIconLocation(icon, 0);
    l.SetShowCmd(show);
    ((IPersistFile)l).Save(lnk, true);
  }
}`

// ════════════════════════ 5. extension ใน Chrome ════════════════════════
const chromeData = MAC ? join(APP_SUPPORT, 'Google', 'Chrome') : join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data')

/** หา extension ID นี้ในทุกโปรไฟล์ของ Chrome → { path, disabled } หรือ null */
function loadedExtension() {
  if (!existsSync(chromeData)) return null
  let found = null
  const profiles = readdirSync(chromeData, { withFileTypes: true }).filter((d) => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
  for (const p of profiles) {
    for (const file of ['Secure Preferences', 'Preferences']) {
      try {
        const ext = JSON.parse(readFileSync(join(chromeData, p.name, file), 'utf8'))?.extensions?.settings?.[id]
        if (!ext?.path) continue
        const here = samePath(ext.path, EXTENSION_DIR)
        const disabled = Array.isArray(ext.disable_reasons) ? ext.disable_reasons.length > 0 : !!ext.disable_reasons
        if (!found || (here && !found.here)) found = { path: ext.path, here, disabled }
      } catch {}
    }
  }
  return found
}

function samePath(a, b) {
  const norm = (p) => {
    try { return realpathSync(p).toLowerCase() } catch { return resolve(p).toLowerCase() }
  }
  return norm(a) === norm(b)
}

function chromeExe() {
  // Mac: เรียกตัวโปรแกรมข้างใน .app ตรงๆ — ถ้า Chrome เปิดอยู่แล้ว จะส่งที่อยู่ไปเปิดเป็นแท็บใหม่ในหน้าต่างเดิม
  if (MAC) return ['/Applications', join(homedir(), 'Applications')].map((d) => join(d, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')).find((p) => existsSync(p)) ?? null
  return [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find((p) => existsSync(p)) ?? null
}

function copyToClipboard(text) {
  try {
    if (MAC) return execFileSync('/usr/bin/pbcopy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] }), true
    powershell(`Set-Clipboard -Value ${psText(text)}`)
    return true
  } catch {
    return false
  }
}

async function ensureExtension() {
  const label = 'Extension Cartoon Auto ใน Chrome'
  const chrome = chromeExe()
  if (!chrome) return report(label, false, 'ไม่พบ Google Chrome ในเครื่องนี้', `ติดตั้ง Chrome จาก https://www.google.com/chrome แล้วดับเบิลคลิก ${SETUP} อีกครั้ง`)

  let ext = loadedExtension()
  if (ext?.here && !ext.disabled) return report(label, true, 'โหลดไว้แล้ว')

  const steps = ext?.here && ext.disabled
    ? 'เปิดสวิตช์ของ Cartoon Auto Bridge ในหน้า chrome://extensions ให้เป็นสีน้ำเงิน'
    : [
        ext ? `กด "Remove" ที่ Cartoon Auto ตัวเก่า (โหลดจาก ${ext.path}) ก่อน แล้ว` : '',
        MAC
          ? 'เปิดสวิตช์ "Developer mode" มุมขวาบน → กด "Load unpacked" → ในหน้าต่างเลือกโฟลเดอร์ กด Cmd+Shift+G แล้ว Cmd+V แล้ว Enter → กด Select'
          : 'เปิดสวิตช์ "Developer mode" มุมขวาบน → กด "Load unpacked" → คลิกช่องที่อยู่ด้านบนของหน้าต่างเลือกโฟลเดอร์ กด Ctrl+V แล้ว Enter → กด Select Folder',
      ].join('')
  if (quiet) return report(label, false, ext ? 'โหลดจากโฟลเดอร์อื่น/ถูกปิดอยู่' : 'ยังไม่ได้โหลด', steps)

  const copied = copyToClipboard(EXTENSION_DIR)
  spawn(chrome, ['chrome://extensions'], { detached: true, stdio: 'ignore' }).unref()
  console.log('')
  console.log('  ขั้นเดียวที่ต้องทำเอง (Chrome ไม่อนุญาตให้โปรแกรมทำแทน) — เปิดหน้า chrome://extensions ให้แล้ว')
  console.log(`  ${steps}`)
  console.log(copied ? `  (คัดลอกที่อยู่โฟลเดอร์ extension ไว้ให้แล้ว แค่กด ${MAC ? 'Cmd+V' : 'Ctrl+V'})` : `  โฟลเดอร์: ${EXTENSION_DIR}`)
  if (noWait) return report(label, false, 'เปิดหน้า chrome://extensions ให้แล้ว รอโหลดใน Chrome', steps)
  console.log('  รอให้โหลดเสร็จ… (ไม่ต้องปิดหน้าต่างนี้ — ตรวจให้เองทุก 3 วินาที นานสุด 10 นาที)')
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    ext = loadedExtension()
    if (ext?.here && !ext.disabled) return report(label, true, 'โหลดเรียบร้อย')
  }
  report(label, false, 'ยังไม่เห็นว่าโหลด extension', `${steps}\n      (โฟลเดอร์ ${EXTENSION_DIR})`)
}

// ════════════════════════ 6. สรุป ════════════════════════
function popup(text, icon) {
  // รันผ่าน setup.exe (stdout เป็น pipe ไม่ใช่หน้าต่าง cmd) → หน้าต่าง setup แสดงสรุปเองอยู่แล้ว
  // ป๊อปอัปซ้ำมักถูก Chrome บัง setup จึงค้างที่ "กำลังติดตั้ง..." รอคนกด OK ที่มองไม่เห็น (เจอจริง ต.ค. 2026)
  if (quiet || noWait || !process.stdout.isTTY) return
  if (MAC) return void macDialog(text, { icon: { Error: 'stop', Warning: 'caution' }[icon] ?? 'note', buttons: ['OK'] })
  try {
    powershell([
      `Add-Type -AssemblyName System.Windows.Forms`,
      `$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }`,
      `[void][System.Windows.Forms.MessageBox]::Show($owner, ${psText(text)}, 'Cartoon Auto', 'OK', '${icon}')`,
    ].join('; '), { timeout: 24 * 3600_000 })
  } catch {}
}

// ════════════════════════ ถอนการติดตั้ง ════════════════════════
// ── Mac: ของที่ตัวติดตั้งวางไว้นอกโฟลเดอร์นี้ — ลบเฉพาะที่ชี้มาที่โฟลเดอร์นี้ ──
function unregisterMac() {
  const done = []
  for (const { name, dir } of MAC_HOST_DIRS) {
    const file = join(dir, `${HOST}.json`)
    if (!existsSync(file)) { done.push({ name, state: 'none' }); continue }
    let path = null
    try { path = JSON.parse(readFileSync(file, 'utf8')).path } catch {}
    if (path && !pointsHere(path)) { done.push({ name, state: 'other', where: dirname(dirname(path)) }); continue }
    rmSync(file, { force: true })
    done.push({ name, state: 'removed' })
  }
  return done
}

function removeShortcutsMac() {
  let n = 0
  const { apps, desktop } = macShortcutDirs()
  const app = join(apps, APP_NAME)
  if (existsSync(app) && macAppPointsHere(app)) {
    rmSync(app, { recursive: true, force: true })
    n++
  }
  if (desktop) {
    const link = join(desktop, APP_NAME)
    try {
      if (lstatSync(link).isSymbolicLink() && (readlinkSync(link) === app || !existsSync(link))) {
        rmSync(link, { force: true })
        n++
      }
    } catch {}
  }
  return n
}

/** ปิด process ของโฟลเดอร์นี้ (node ใน runtime/ หรือที่รัน bridge/server.js ของโฟลเดอร์นี้) ยกเว้นตัวเอง → จำนวนที่ปิด */
function stopMineMac() {
  const out = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' })
  let n = 0
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m || Number(m[1]) === process.pid) continue
    if (m[2].startsWith(join(RUNTIME, '/')) || m[2].includes(join(ROOT, 'bridge', 'server.js'))) {
      try { process.kill(Number(m[1]), 'SIGTERM'); n++ } catch {}
    }
  }
  return n
}

function uninstall() {
  if (MAC) {
    unregisterMac()
    rmSync(manifestFile, { force: true })
    rmSync(batFile, { force: true })
    removeShortcutsMac()
    return console.log('ถอนการลงทะเบียนและลบ shortcut แล้ว (ไฟล์โปรแกรมและงานของคุณยังอยู่ครบ)')
  }
  for (const key of REG_KEYS) {
    try { execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' }) } catch {}
  }
  rmSync(manifestFile, { force: true })
  rmSync(batFile, { force: true })
  removeJunction()
  try {
    powershell(`foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) { Remove-Item -LiteralPath (Join-Path $d '${SHORTCUT_NAME}') -Force -ErrorAction SilentlyContinue }`)
  } catch {}
  console.log('ถอนการลงทะเบียนและลบ shortcut แล้ว (ไฟล์โปรแกรมและงานของคุณยังอยู่ครบ)')
}

// ชื่อโปรแกรม/ส่วนเสริมของโปรเจกต์นี้ — โปรเจกต์ที่แยกออกไป (Cartoon Kids, ธรรมะ Auto) ใช้ตัวถอนชุดเดียวกันได้โดยไม่ต้องแก้ข้อความ
// หน้าต่าง cmd แสดงเฉพาะอักษรอังกฤษได้แน่นอน — ชื่อที่เป็นภาษาไทยใช้คำกลางแทนในข้อความภาษาอังกฤษ
const PRODUCT = SHORTCUT_NAME.replace(/.lnk$/i, '')
const EXT_NAME = (() => {
  try {
    return JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')).name
  } catch {
    return `${PRODUCT} Bridge`
  }
})()
const ascii = (t) => /^[ -~]+$/.test(t)
const PRODUCT_EN = ascii(PRODUCT) ? PRODUCT : 'the program'
const EXT_NAME_EN = ascii(EXT_NAME) ? `"${EXT_NAME}"` : 'the extension of this program'

/**
 * ถอนทั้งหมดให้เครื่องกลับเป็นเหมือนไม่เคยติดตั้ง (ถอนการติดตั้ง.bat) — ใช้ทดสอบการติดตั้งใหม่ตั้งแต่ต้น
 *   ปิดโปรแกรม → ตัดการเชื่อมกับ Chrome/Edge → ลบ shortcut → ให้กด Remove extension ใน Chrome → ลบโฟลเดอร์นี้ทั้งโฟลเดอร์
 * แตะเฉพาะของที่ชี้มาที่โฟลเดอร์นี้ — registry / shortcut / junction ที่ชี้ไปโฟลเดอร์อื่น (เช่นเครื่องนักพัฒนา) ไม่ลบ
 * ทุกอย่างที่ตัวติดตั้งลง (node, ffmpeg, python) อยู่ใน runtime\ ของโฟลเดอร์นี้ ไม่ได้ลงทั้งเครื่อง → ลบโฟลเดอร์ก็หมด
 *   --yes          ไม่ถามยืนยัน · --keep-folder  ไม่ลบโฟลเดอร์ · --quiet  ไม่มีป๊อปอัป (ใช้ทดสอบ)
 * โฟลเดอร์ที่มี .git (โฟลเดอร์พัฒนา) ไม่ถูกลบเด็ดขาด
 */
/**
 * Mac: กล่องข้อความด้วย osascript (มีทุกเครื่อง ไม่ต้องขอสิทธิ์) — ข้อความส่งเป็นอาร์กิวเมนต์ ไม่ต้องหนีอักษรพิเศษ
 * คืนชื่อปุ่มที่กด · กดปุ่มยกเลิก / ปิดกล่อง = null
 */
function macDialog(text, { title = 'Cartoon Auto', icon = 'note', buttons = ['OK'], cancel = null } = {}) {
  const list = `{${buttons.map((_, i) => `item ${i + 3} of argv`).join(', ')}}`
  const script = [
    'on run argv',
    `display dialog (item 1 of argv) with title (item 2 of argv) buttons ${list} default button ${buttons.length}${cancel ? ` cancel button ${buttons.indexOf(cancel) + 1}` : ''} with icon ${icon}`,
    'return button returned of result',
    'end run',
  ]
  try {
    return execFileSync('/usr/bin/osascript', [...script.flatMap((l) => ['-e', l]), text, title, ...buttons], { encoding: 'utf8', timeout: 24 * 3600_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function confirmBox(text) {
  if (MAC) return macDialog(text, { title: `${PRODUCT} — ถอนการติดตั้ง`, icon: 'caution', buttons: ['ยกเลิก', 'ถอนการติดตั้ง'], cancel: 'ยกเลิก' }) === 'ถอนการติดตั้ง'
  try {
    return powershell([
      `Add-Type -AssemblyName System.Windows.Forms`,
      `$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }`,
      `[string][System.Windows.Forms.MessageBox]::Show($owner, ${psText(text)}, ${psText(`${PRODUCT} — ถอนการติดตั้ง`)}, 'YesNo', 'Warning')`,
    ].join('; '), { timeout: 24 * 3600_000 }) === 'Yes'
  } catch {
    return false
  }
}

const pointsHere = (p) => {
  try {
    return !!p && (samePath(dirname(p), DIR) || samePath(p, ROOT))
  } catch {
    return false
  }
}

async function uninstallFull() {
  const isDev = existsSync(join(ROOT, '.git'))
  const keepFolder = flag('--keep-folder') || isDev
  const yes = flag('--yes')
  const clips = existsSync(join(ROOT, 'projects')) ? readdirSync(join(ROOT, 'projects'), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).length : 0
  // หน้าต่าง cmd ของ Windows 10 หลายเครื่องแสดงภาษาไทยเป็นกล่อง ▯ อ่านไม่ออก (เจอจริง ต.ค. 2026)
  // → ถอนการติดตั้ง.bat ขอข้อความภาษาอังกฤษในหน้าต่าง · รายละเอียดภาษาไทยอยู่ในป๊อปอัป (แสดงไทยได้ทุกเครื่อง)
  const en = process.env.CARTOON_CONSOLE === 'en'
  const say = (text) => en && process.stdout.write(`${text}\n`)
  if (en) console.log = () => {}
  console.log(`ถอนการติดตั้งจาก: ${ROOT}${isDev ? ' (โฟลเดอร์พัฒนา — ไม่ลบไฟล์)' : ''}`)
  say(`Uninstall ${PRODUCT_EN} from: ${ROOT}`)
  if (!yes && !quiet) {
    say('Answer the popup window (Yes / No)...')
    const ok = confirmBox([
      `ถอน ${PRODUCT} ออกจากเครื่องนี้ ให้เหมือนไม่เคยติดตั้ง`,
      '',
      '• ปิดโปรแกรมที่เปิดอยู่',
      `• ตัดการเชื่อมกับ Chrome และลบ shortcut "${PRODUCT}"`,
      `• เปิดหน้า chrome://extensions ให้กด Remove ที่ ${EXT_NAME}`,
      keepFolder ? '• ไฟล์ในโฟลเดอร์นี้ยังอยู่ครบ' : `• ลบโฟลเดอร์นี้ทั้งหมด รวมงานคลิป ${clips} เรื่อง การตั้งค่า และ key ที่ใส่ไว้ — กู้คืนไม่ได้`,
      '',
      ROOT,
      '',
      'ทำต่อไหม?',
    ].join('\n'))
    if (!ok) {
      console.log('ยกเลิก — ไม่ได้เปลี่ยนอะไร')
      say('Cancelled - nothing was changed.')
      return 0
    }
  }

  step('ปิดโปรแกรม')
  say('- Stopping the program...')
  try {
    // ปิดเฉพาะ process ของโฟลเดอร์นี้ (แบบเดียวกับ ปิดโปรแกรม.bat) ยกเว้นตัวเอง — ตัวนี้รันด้วย node ใน runtime\ เหมือนกัน
    const n = MAC ? stopMineMac() : powershell([
      `$root = ${psText(ROOT)}`,
      `$mine = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne ${process.pid} -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + '\\runtime\\', 'OrdinalIgnoreCase')) -or ($_.CommandLine -and $_.CommandLine.Contains($root + '\\bridge\\server.js'))) })`,
      `$mine | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      `$mine.Count`,
    ].join('; '))
    report('ปิดโปรแกรม', true, Number(n) ? `ปิด ${n} process` : 'ไม่ได้เปิดอยู่')
  } catch (err) {
    report('ปิดโปรแกรม', false, err.message.split(/\r?\n/)[0])
  }

  step('ตัดการเชื่อมกับ Chrome / Edge')
  say('- Unlinking from Chrome / Edge...')
  if (MAC) {
    for (const r of unregisterMac()) report(`ลงทะเบียน ${r.name}`, true, { none: 'ไม่มีอยู่แล้ว', removed: 'ลบแล้ว', other: `ชี้ไปโฟลเดอร์อื่น (${r.where}) — ไม่แตะ` }[r.state])
  }
  for (const key of MAC ? [] : REG_KEYS) {
    const target = readRegistry(key)
    const name = key.includes('Google') ? 'Chrome' : 'Edge'
    if (!target) report(`ลงทะเบียน ${name}`, true, 'ไม่มีอยู่แล้ว')
    else if (!pointsHere(target)) report(`ลงทะเบียน ${name}`, true, `ชี้ไปโฟลเดอร์อื่น (${dirname(dirname(target))}) — ไม่แตะ`)
    else {
      try {
        execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore', windowsHide: true })
        report(`ลงทะเบียน ${name}`, true, 'ลบแล้ว')
      } catch (err) {
        report(`ลงทะเบียน ${name}`, false, err.message.split(/\r?\n/)[0])
      }
    }
  }
  rmSync(manifestFile, { force: true })
  rmSync(batFile, { force: true })
  try {
    if (lstatSync(JUNCTION).isSymbolicLink() && samePath(JUNCTION, ROOT)) rmdirSync(JUNCTION)
  } catch {}
  try {
    rmdirSync(dirname(JUNCTION)) // %LOCALAPPDATA%\CartoonAuto — ลบเมื่อว่างเท่านั้น
  } catch {}

  step('ลบ shortcut')
  say('- Removing shortcuts...')
  try {
    const removed = MAC ? removeShortcutsMac() : powershell([
      `$root = ${psText(ROOT)}`,
      `$shell = New-Object -ComObject WScript.Shell`,
      `$n = 0`,
      `foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {`,
      `  $p = Join-Path $d '${SHORTCUT_NAME}'`,
      `  if ((Test-Path -LiteralPath $p) -and ($shell.CreateShortcut($p).WorkingDirectory.TrimEnd('\\') -ieq $root.TrimEnd('\\'))) { Remove-Item -LiteralPath $p -Force; $n++ }`,
      `}`,
      `$n`,
    ].join('\n'))
    report(`Shortcut "${PRODUCT}"`, true, Number(removed) ? `ลบ ${removed} อัน` : 'ไม่มีที่ชี้มาที่โฟลเดอร์นี้')
  } catch (err) {
    report(`Shortcut "${PRODUCT}"`, false, err.message.split(/\r?\n/)[0])
  }

  step('Extension ใน Chrome')
  let ext = loadedExtension()
  if (!ext?.here) report(`Extension ${EXT_NAME}`, true, ext ? `ตัวที่โหลดไว้มาจากโฟลเดอร์อื่น (${ext.path}) — ไม่แตะ` : 'ไม่ได้โหลดไว้')
  else {
    // Chrome ไม่ยอมให้โปรแกรมลบ extension แทน — เปิดหน้าให้ แล้วรอผู้ใช้กด Remove
    const chrome = chromeExe()
    if (chrome && !quiet) spawn(chrome, ['chrome://extensions'], { detached: true, stdio: 'ignore' }).unref()
    if (!quiet) {
      console.log(`  กด "Remove" ที่ ${EXT_NAME} ในหน้า chrome://extensions ที่เปิดให้ (รอให้ทำ นานสุด 5 นาที)`)
      say(`- In Chrome (chrome://extensions page just opened): click "Remove" on ${EXT_NAME_EN}. Waiting up to 5 minutes...`)
      const deadline = Date.now() + 5 * 60_000
      while (Date.now() < deadline && loadedExtension()?.here) await new Promise((r) => setTimeout(r, 2000))
      ext = loadedExtension()
    }
    report(`Extension ${EXT_NAME}`, !ext?.here, ext?.here ? 'ยังอยู่ใน Chrome' : 'เอาออกแล้ว', `เปิด chrome://extensions แล้วกด Remove ที่ ${EXT_NAME} เอง`)
  }

  let deleting = false
  if (!keepFolder) {
    step('ลบโฟลเดอร์โปรแกรม')
    say('- This folder will be deleted after you click OK in the popup.')
    // กันลบผิดที่: ต้องเป็นโฟลเดอร์ของโปรแกรมนี้จริง และไม่ใช่รากไดรฟ์
    const looksRight = existsSync(join(ROOT, 'bridge', 'server.js')) && existsSync(join(ROOT, 'native', 'install.mjs')) && dirname(ROOT) !== ROOT
    if (!looksRight) report('ลบโฟลเดอร์', false, 'โฟลเดอร์นี้ไม่ใช่โฟลเดอร์ของโปรแกรม — ไม่ลบ')
    else {
      // node ตัวที่รันอยู่นี้อยู่ใน runtime\ — ลบตัวเองไม่ได้ ให้ ถอนการติดตั้ง.bat ลบหลัง node ปิด (exit code 10)
      // ไม่ใช้ process แยกที่รอลบทีหลัง: ถูกปิดตามไปด้วยเมื่อตัวที่เปิดมันจบ (เจอตอนทดสอบ)
      deleting = true
      report('ลบโฟลเดอร์', true, 'จะลบทันทีที่กด OK')
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log('\n' + '─'.repeat(60))
  const summary = failed.length
    ? ['ถอนการติดตั้งแล้ว แต่ยังเหลือบางอย่าง:', '', ...failed.map((r) => `✗ ${r.label}${r.detail ? ` — ${r.detail}` : ''}${r.fix ? `\n   → ${r.fix}` : ''}`)].join('\n')
    : [`ถอน ${PRODUCT} ออกจากเครื่องแล้ว — เหมือนเครื่องที่ยังไม่เคยติดตั้ง`, deleting ? '\nโฟลเดอร์โปรแกรมจะถูกลบเมื่อกด OK' : keepFolder ? `\nไฟล์ในโฟลเดอร์ยังอยู่: ${ROOT}` : ''].join('')
  console.log(summary)
  say('')
  say(failed.length ? `Finished, ${failed.length} item(s) need attention - details (Thai) in the popup window. Click OK.` : 'Finished - uninstalled. Click OK in the popup window.')
  popup(summary, failed.length ? 'Warning' : 'Information')
  return deleting ? 10 : 0
}

// ════════════════════════ เริ่ม ════════════════════════
if (flag('--uninstall')) {
  // --full: exit 10 = ให้ ถอนการติดตั้ง.bat ลบโฟลเดอร์ต่อ
  process.exit(flag('--full') ? await uninstallFull() : (uninstall(), 0))
}
console.log(`โฟลเดอร์โปรแกรม: ${ROOT}`)

// กดจากในไฟล์ zip (Explorer / WinRAR / 7-Zip) → ไฟล์ถูกแตกชั่วคราวไว้ใน Temp และจะหายเมื่อปิดโปรแกรมแตกไฟล์
// ถ้าติดตั้งจากตรงนั้น Chrome จะชี้ไปโฟลเดอร์ที่หายไป → "ยังไม่ได้เชื่อมกับ Chrome" ภายหลัง จึงไม่ยอมติดตั้ง
{
  const inside = (dir, parent) => !!parent && (dir.toLowerCase() + '\\').startsWith(resolve(parent).toLowerCase().replace(/\\?$/, '\\'))
  const temps = [tmpdir(), process.env.TEMP, process.env.TMP, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Temp')]
  if (!MAC && temps.some((t) => inside(ROOT, t))) {
    const text = 'ยังไม่ได้แตกไฟล์ zip — ตอนนี้โปรแกรมรันจากโฟลเดอร์ชั่วคราว ซึ่งจะถูกลบทิ้ง\n\n' +
      'คลิกขวาที่ไฟล์ zip แล้วเลือก "แตกไฟล์ทั้งหมด (Extract All)" (ถ้าเปิดด้วย WinRAR / 7-Zip ให้กด Extract ไปไว้ที่ D:\\ หรือ Documents)\n' +
      'จากนั้นเปิดโฟลเดอร์ที่แตกแล้ว และดับเบิลคลิก setup.exe ในนั้น'
    console.log(`\n✗ ${text}`)
    popup(text, 'Warning')
    process.exit(1)
  }
}

step('เตรียมโปรแกรมที่ต้องใช้')
report('Node.js', true, process.version)
await ensureFfmpeg()
await ensureEdgeTts()
ensureUsableSettings()
ensureVersionFile()

step('เชื่อมกับ Chrome')
const hostPath = writeHostFiles()
let bridgeInfo = null
if (flag('--no-register')) {
  console.log('เขียนไฟล์ host แล้ว (ข้ามการลงทะเบียน --no-register)')
  process.exit(0)
}
try {
  register()
  report('ลงทะเบียนตัวเชื่อม Chrome', true, hostPath === batFile ? '' : `ผ่าน ${dirname(dirname(hostPath))} (ชื่อโฟลเดอร์มีอักษรพิเศษ)`)
} catch (err) {
  report('ลงทะเบียนตัวเชื่อม Chrome', false, err.message, MAC ? `ดับเบิลคลิก ${SETUP} อีกครั้ง` : `ดับเบิลคลิก ${SETUP} อีกครั้ง (ไม่ต้อง Run as administrator)`)
}

step('ทดสอบเปิดโปรแกรมแบบเดียวกับที่ Chrome เปิด')
const verified = await verifyHost()
if (verified.ok) {
  bridgeInfo = verified.info
  report('โปรแกรมในเครื่อง (bridge)', true, `เปิดแล้วที่ ${verified.info.url}`)
} else {
  report('โปรแกรมในเครื่อง (bridge)', false, verified.problem, `ดูรายละเอียดใน ${join('bridge', 'bridge.log')} หรือส่งภาพหน้าต่างนี้ให้ผู้ดูแล`)
}

if (!flag('--no-shortcut')) {
  step('สร้าง shortcut')
  try {
    createShortcuts()
    report('Shortcut "Cartoon Auto"', true, option('--shortcut-dir') ? option('--shortcut-dir') : MAC ? 'บนเดสก์ท็อปและในโฟลเดอร์ Applications' : 'บนเดสก์ท็อปและ Start menu')
  } catch (err) {
    report('Shortcut "Cartoon Auto"', false, err.message.split(/\r?\n/)[0], 'ไม่มีผลกับการใช้งาน — เปิดโปรแกรมด้วยไอคอน extension ใน Chrome ได้เหมือนเดิม')
  }
}

step('Extension ใน Chrome')
await ensureExtension()

// รายการจำเป็นที่ bridge ตรวจ (ffmpeg, เสียงพากย์, Blueprint, พื้นที่ดิสก์ …) — ชุดเดียวกับหน้า "ตรวจความพร้อม"
let machineMissing = []
if (bridgeInfo) {
  step('ตรวจความพร้อมของเครื่อง')
  const items = await machineChecklist(bridgeInfo)
  if (items) {
    machineMissing = items.filter((i) => i.need === 'required' && i.status === 'missing')
    for (const i of machineMissing) report(i.label, false, i.detail, i.fix?.text ?? '')
    if (!machineMissing.length) console.log('✓ ของในเครื่องครบทุกรายการที่จำเป็น')
  } else {
    console.log('  (ถามรายการตรวจความพร้อมจากโปรแกรมไม่ได้ — ข้าม)')
  }
}

const failed = results.filter((r) => !r.ok)
const onlyExtension = failed.length > 0 && failed.every((r) => r.label.startsWith('Extension'))
console.log('\n' + '─'.repeat(60))
let summary
if (!failed.length) {
  summary = [
    'ติดตั้งเสร็จ พร้อมใช้งาน ✓',
    '',
    'ใช้งาน: เปิด Chrome → กดไอคอนจิ๊กซอว์บนแถบ → ปักหมุด Cartoon Auto → กดไอคอน แผงทำคลิปเปิดขึ้นมาเอง',
    'ในแผงข้างกด "ตรวจความพร้อม" → ตรวจใหม่ — เหลือแค่ล็อกอิน ChatGPT และ Google Flow ใน Chrome',
  ].join('\n')
} else {
  summary = [
    onlyExtension ? 'ติดตั้งโปรแกรมเสร็จ เหลือขั้นเดียวใน Chrome' : `ติดตั้งยังไม่ครบ — มีปัญหา ${failed.length} ข้อ`,
    '',
    ...failed.map((r) => `✗ ${r.label}${r.detail ? `: ${r.detail}` : ''}${r.fix ? `\n   → ${r.fix}` : ''}`),
    '',
    `แก้แล้วดับเบิลคลิก ${SETUP} อีกครั้งได้เลย (รันซ้ำได้ ไม่มีอะไรเสีย)`,
  ].join('\n')
}
console.log(summary)
popup(summary, failed.length ? (onlyExtension ? 'Warning' : 'Error') : 'Information')
process.exit(failed.length && !onlyExtension ? 1 : 0)
