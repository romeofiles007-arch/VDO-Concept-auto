// ⏹ หยุดทุกอย่าง — ยกมาจากตำนานจีน (ผู้ใช้ 21 พ.ย. 2026: "บางทีปุ่มหยุดใช้ไม่ได้ มันยังทำงานเอง")
//   node --test scripts/test-halt.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHalt, strayProcesses, parsePs, listProcesses, HALTED_MESSAGE } from '../bridge/halt.js'
import { createRunner } from '../bridge/runner.js'

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('สวิตช์หยุดเก็บลงไฟล์ — โปรแกรมรีสตาร์ทแล้วยังหยุดอยู่', () => {
  const dir = mkdtempSync(join(tmpdir(), 'halt-'))
  try {
    const file = join(dir, 'runtime', 'halt.json')
    const a = createHalt(file)
    assert.equal(a.on(), false)
    a.set(true)
    assert.equal(createHalt(file).on(), true, 'อ่านใหม่แล้วต้องยังหยุดอยู่')
    a.set(false)
    assert.equal(createHalt(file).on(), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('process ที่หลุดการควบคุม (Windows): เฉพาะของโปรแกรมนี้ ไม่แตะ bridge และไม่แตะโปรแกรมอื่นบนเครื่องเดียวกัน', () => {
  const root = 'C:\\Git\\Youtube Free animation Auto Claude'
  const list = [
    { pid: 10, name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Git\\Youtube Free animation Auto Claude\\pipeline\\autopilot.mjs" --auto-topic' },
    { pid: 11, name: 'python.exe', cmd: 'C:\\py\\python.exe "C:\\Git\\Youtube Free animation Auto Claude\\tts\\cloud\\edge_synth.py" job.json' },
    { pid: 12, name: 'ffmpeg.exe', cmd: 'ffmpeg -i "C:\\Git\\Youtube Free animation Auto Claude\\projects\\x\\02_audio\\a.wav" out.mp4' },
    { pid: 13, name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Git\\Youtube Free animation Auto Claude\\bridge\\server.js"' },
    { pid: 14, name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" C:\\Git\\china\\pipeline\\autopilot.mjs' },
    { pid: 15, name: 'chrome.exe', cmd: 'chrome.exe "C:\\Git\\Youtube Free animation Auto Claude\\pipeline\\x"' },
    { pid: 16, name: 'node.exe', cmd: 'node pipeline/autopilot.mjs' },
  ]
  assert.deepEqual(strayProcesses(root, list, { selfPid: 1 }).map((p) => p.pid), [10, 11, 12])
})

test('process ที่หลุดการควบคุม (Linux ใน Docker): python3 · ffmpeg · node ใต้ /app เท่านั้น', () => {
  const list = parsePs([
    '    1 node            node /app/bridge/server.js',
    '   40 node            /usr/local/bin/node /app/pipeline/autopilot.mjs --auto-topic',
    '   41 python3         /usr/bin/python3 /app/tts/cloud/edge_synth.py job.json',
    '   42 ffmpeg          ffmpeg -y -i /app/projects/x/02_audio/a.wav out.mp4',
    '   43 chromium        /usr/lib/chromium/chromium --user-data-dir=/app/projects/x',
    '   44 node            node /srv/other/pipeline/autopilot.mjs',
    '',
  ].join('\n'))
  assert.deepEqual(list[1], { pid: 40, name: 'node', cmd: '/usr/local/bin/node /app/pipeline/autopilot.mjs --auto-topic' })
  assert.deepEqual(strayProcesses('/app', list, { selfPid: 1 }).map((p) => p.pid), [40, 41, 42])
  assert.ok(Array.isArray(listProcesses()), 'อ่านรายการ process ไม่ได้ก็ต้องคืน [] ไม่ throw')
})

test('Linux: อ่านด้วย ps -eo pid=,comm=,args= · ไม่มี ps (image slim) อ่าน /proc · ปิดด้วย SIGKILL', () => {
  const src = read('bridge/halt.js')
  assert.match(src, /execFileSync\('ps', \['-eo', 'pid=,comm=,args='\]/)
  assert.match(src, /readdirSync\('\/proc'\)/)
  assert.match(src, /process\.kill\(p\.pid, 'SIGKILL'\)/)
})

test('ระหว่างหยุดทุกอย่าง: ไม่เริ่มขั้นใหม่ของ pipeline', () => {
  let on = true
  const runner = createRunner({ log: () => {}, halted: () => on })
  assert.throws(() => runner.start('timecode', 'x'), /หยุดทุกอย่างไว้อยู่/)
  on = false
  assert.equal(typeof runner.start, 'function')
})

test('runner เรียกสคริปต์ด้วย path เต็ม (ปุ่มหยุดหา process ที่หลุดได้)', () => {
  const src = read('bridge/runner.js')
  assert.doesNotMatch(src, /\['pipeline\//, 'ห้ามเหลือ path สั้น pipeline/...')
  assert.match(src, /const P = \(file\) => join\(ROOT, 'pipeline', file\)/)
})

test('bridge: ระหว่างหยุด ไม่ส่งงานให้แท็บ · งานใหม่ถูกปฏิเสธ · ผลิตต่อเนื่อง/โพสต์อัตโนมัติไม่เริ่มเอง', () => {
  const server = read('bridge/server.js')
  assert.match(server, /const halt = createHalt\(join\(ROOT, 'runtime', 'halt\.json'\)\)/)
  assert.match(server, /function dispatch\(job\) \{\n\s+\/\/[^\n]*\n\s+if \(halt\?\.on\(\)\) return/)
  assert.match(server, /const pending = halt\.on\(\) \? null/)
  assert.match(server, /if \(halt\?\.on\(\)\) Object\.assign\(job, \{ status: 'error', error: HALTED_MESSAGE/)
  assert.match(server, /halted: \(\) => halt\.on\(\)/)
  const production = read('bridge/production.js')
  assert.match(production, /if \(!state\.active \|\| halted\(\)\) return/)
  assert.match(production, /&& halted\(\)\) return json\(res, 423/)
  assert.match(production, /const api = \{[^}]*\bstop\b/)
  assert.match(read('bridge/posting.js'), /async function tick\(\) \{\n\s+\/\/[^\n]*\n\s+if \(halted\(\)\) return/)
  assert.ok(HALTED_MESSAGE.includes('ทำงานต่อ'))
})

test('ปุ่มหยุดทุกอย่าง: หยุดผลิต + ยกเลิกงานทุกแท็บ + กวาด process ที่หลุด · ปุ่มหยุดคลิปเดิมใช้ตัวยกเลิกชุดเดียวกัน', () => {
  const ui = read('bridge/ui.js')
  assert.match(ui, /function stopEverything\(\) \{\n\s+halt\?\.set\(true\)\n[^\n]*\n\s+production\.stop\(\)\n\s+cancelRun\('หยุดทุกอย่างโดยผู้ใช้', \{ all: true \}\)/)
  assert.match(ui, /killStray\(ROOT, log\)/)
  assert.match(ui, /path === '\/api\/halt'/)
  assert.match(ui, /path === '\/api\/run\/stop'\) \{\n\s+return json\(res, 200, cancelRun\(\)\), true/)
})

test('แผงข้าง: แถบหยุดทุกอย่างบนสุด + สั่งทุกแท็บหยุดทันที · โค้ดอยู่นอกส่วน 🏭 ผลิตต่อเนื่อง', () => {
  const html = read('extension/sidepanel.html')
  assert.ok(html.indexOf('id="haltBar"') < html.indexOf('id="studioHero"'), 'แถบหยุดต้องอยู่บนสุด')
  const js = read('extension/sidepanel.js')
  assert.match(js, /type: 'STOP_ALL_TABS'/)
  const prodSection = js.indexOf('// ── 🏭 ผลิตต่อเนื่อง —')
  assert.ok(prodSection > 0)
  assert.ok(js.indexOf('async function haltCall(') < prodSection, 'โค้ดหยุดทุกอย่างต้องอยู่ก่อนส่วน 🏭')
  assert.ok(!js.slice(prodSection).includes('haltCall'), 'ส่วน 🏭 ต้องไม่อ้าง haltCall')
  assert.match(read('extension/background.js'), /msg\.type === 'STOP_ALL_TABS'/)
})
