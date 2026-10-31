// เทสต์ความทนทานของตัวขับ Flow / ChatGPT ต่อหน้าที่ Chrome แปล และหน้า Flow รุ่นใหม่ (ต.ค. 2026)
//   node scripts/test-flow-text.mjs
// ไม่เปิดเบราว์เซอร์ — โหลด extension/flow-text.js และ no-translate.js ใน vm พร้อม DOM จำลอง
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const EXT = join(fileURLToPath(new URL('..', import.meta.url)), 'extension')
const src = (name) => readFileSync(join(EXT, name), 'utf8')

let passed = 0
const test = (name, fn) => {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

class KeyboardEvent {
  constructor(type, init = {}) {
    this.type = type
    Object.assign(this, init)
  }
}
const ctx = vm.createContext({ KeyboardEvent })
vm.runInContext(src('flow-text.js'), ctx)
const T = ctx.CartoonFlowText

// ── D: ชื่อรุ่นแบบไม่สนภาษา ──
test('ชื่อรุ่นอังกฤษ: มีอีโมจิ/ไอคอนนำหน้า/ลูกศรท้ายก็ยังตรง', () => {
  assert.equal(T.sameModel('🍌 Nano Banana 2 Lite', 'Nano Banana 2 Lite'), true)
  assert.equal(T.sameModel('check Nano Banana 2 Lite', 'Nano Banana 2 Lite'), true)
  assert.equal(T.sameModel('🍌 Nano Banana 2 Lite arrow_drop_down', 'Nano Banana 2 Lite'), true)
  assert.equal(T.sameModel('NanoBanana Pro', 'Nano Banana Pro'), true)
})

test('ชื่อรุ่นที่ถูกแปลเป็นไทย: นาโน บานานา · บานาน่า · โปร · ไลต์/ไลท์', () => {
  assert.equal(T.sameModel('🍌 นาโน บานานา 2 Lite', 'Nano Banana 2 Lite'), true)
  assert.equal(T.sameModel('นาโน บานานา 2 ไลต์', 'Nano Banana 2 Lite'), true)
  assert.equal(T.sameModel('นาโน บานานา 2 ไลท์', 'Nano Banana 2 Lite'), true)
  assert.equal(T.sameModel('check นาโนบานาน่า โปร', 'Nano Banana Pro'), true)
  assert.equal(T.sameModel('นาโน บานานา 2', 'Nano Banana 2'), true)
})

test('เทียบทั้งคำ ไม่เลือกผิดรุ่น: "2" ≠ "2.1" · "2" ≠ "2 Lite" · "Pro" ≠ "2 Lite"', () => {
  assert.equal(T.sameModel('Nano Banana 2', 'Nano Banana 2 Lite'), false)
  assert.equal(T.sameModel('Nano Banana 2 Lite', 'Nano Banana 2'), false)
  assert.equal(T.sameModel('Nano Banana 2.1', 'Nano Banana 2'), false)
  assert.equal(T.sameModel('Nano Banana 2', 'Nano Banana 2.1'), false)
  assert.equal(T.sameModel('นาโน บานานา โปร', 'Nano Banana 2 Lite'), false)
  assert.equal(T.sameModel('Nano Banana Pro', 'Nano Banana 2 Lite'), false)
  assert.equal(T.sameModel('นาโน บานานา 2', 'Nano Banana 2 Lite'), false)
})

test('คำไทยที่ไม่รู้จักในชื่อรุ่น → ไม่เดา (กันเลือกผิดรุ่นจนกินเครดิต)', () => {
  // ถ้าตัดคำไทยที่ไม่รู้จักทิ้งเฉย ๆ "นาโน บานานา 2 เบา" จะกลายเป็น "Nano Banana 2" ซึ่งเป็นคนละรุ่น
  assert.equal(T.modelKey('นาโน บานานา 2 เบา'), '')
  assert.equal(T.sameModel('นาโน บานานา 2 เบา', 'Nano Banana 2'), false)
  assert.equal(T.sameModel('นาโน บานานา 2 เบา', 'Nano Banana 2 Lite'), false)
  assert.equal(T.sameModel('', ''), false)
  assert.equal(T.sameModel('Nano Banana 2 Lite', ''), false)
})

test('รุ่นที่ไม่ใช่ Nano Banana ยังเทียบแบบเดิมได้ (ตัดไอคอนคำแรก)', () => {
  assert.equal(T.sameModel('image Imagen 4', 'Imagen 4'), true)
  assert.equal(T.sameModel('Imagen 4', 'Imagen 4'), true)
  assert.equal(T.sameModel('image Imagen 4 Ultra', 'Imagen 4'), false)
})

test('ข้อความปุ่มไม่เอาชื่อไอคอน — ไอคอนที่ถูกแปลเป็นไทยไม่ทำให้อ่านชื่อรุ่นพัง', () => {
  const icon = { innerText: 'ลูกศรลง' } // arrow_drop_down หลังถูกแปล
  const btn = { innerText: '🍌 นาโน บานานา 2 Lite ลูกศรลง', querySelectorAll: () => [icon] }
  assert.equal(T.labelText(btn), '🍌 นาโน บานานา 2 Lite')
  assert.equal(T.sameModel(T.labelText(btn), 'Nano Banana 2 Lite'), true)
  // ถ้ายังอ่านชื่อไอคอนติดมา → ไม่ตรง (ปลอดภัย: หยุดพร้อมข้อความ ไม่เลือกมั่ว)
  assert.equal(T.sameModel(btn.innerText, 'Nano Banana 2 Lite'), false)
  assert.equal(T.labelText(null), '')
})

// ── C: เมนูค้างที่ไม่ใช่เมนูโมเดล ──
test('เมนูค้าง: รายการไม่ใช่ชื่อรุ่น = เมนูอื่น (ปิดด้วย Escape) · รายการรุ่น = ไม่ใช่เมนูค้าง', () => {
  assert.equal(T.strayMenu(['เพิ่มไปยังพรอมต์', 'ดาวน์โหลด', 'เปลี่ยนชื่อ']), true)
  assert.equal(T.strayMenu(['Add to prompt', 'Download', 'Rename']), true)
  assert.equal(T.strayMenu(['🍌 Nano Banana 2 Lite', '🍌 Nano Banana Pro']), false)
  assert.equal(T.strayMenu(['🍌 นาโน บานานา 2 Lite', 'นาโนบานาน่า โปร']), false)
  assert.equal(T.strayMenu([]), false)
})

const fakeDoc = (menus = 2, className = '') => {
  const log = []
  const target = (name) => ({ dispatchEvent: (e) => log.push(`${name}:${e.type}:${e.key}`), click: () => log.push(`${name}:click`) })
  const doc = {
    documentElement: { className },
    querySelectorAll: (sel) => (sel === '[role="menu"]' ? Array.from({ length: menus }, (_, i) => target(`menu${i}`)) : []),
    querySelector: (sel) => (sel === '.cdk-overlay-backdrop' ? target('backdrop') : null),
    ...target('document'),
  }
  return { doc, log }
}

test('Escape ส่งถึงตัว [role="menu"] ทุกตัว + document + กด backdrop', () => {
  const { doc, log } = fakeDoc(2)
  T.escapeMenus(doc)
  assert.deepEqual(log, ['menu0:keydown:Escape', 'menu1:keydown:Escape', 'document:keydown:Escape', 'backdrop:click'])
})

test('ปิดเฉพาะเมนู: ไม่ส่งระดับ document / ไม่กด backdrop (แผงตั้งค่าที่เปิดอยู่ไม่ปิดตาม)', () => {
  const { doc, log } = fakeDoc(1)
  T.escapeMenus(doc, { documentToo: false, backdrop: false })
  assert.deepEqual(log, ['menu0:keydown:Escape'])
  const b = fakeDoc(0)
  T.escapeMenus(b.doc, { backdrop: false })
  assert.deepEqual(b.log, ['document:keydown:Escape'])
})

// ── A: หน้าที่ถูกแปล ──
test('ตรวจหน้าที่ Chrome แปลแล้ว (translated-ltr / translated-rtl)', () => {
  assert.equal(T.pageTranslated(fakeDoc(0, 'notranslate translated-ltr').doc), true)
  assert.equal(T.pageTranslated(fakeDoc(0, 'translated-rtl').doc), true)
  assert.equal(T.pageTranslated(fakeDoc(0, 'notranslate').doc), false)
  assert.equal(T.pageTranslated(fakeDoc(0, 'untranslated-ltrx').doc), false)
  assert.match(T.TRANSLATED_HINT, /แปล/)
})

test('no-translate.js ใส่ translate="no" + class notranslate + meta google notranslate และใส่คืนเมื่อถูกลบ', () => {
  const attrs = {}
  const classes = new Set()
  const appended = []
  let observer = null
  const html = {
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => (attrs[k] = v),
    classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c) },
    appendChild: (el) => appended.push(el),
  }
  const head = { appendChild: (el) => appended.push(el) }
  const document = {
    documentElement: html,
    head,
    querySelector: (sel) => (sel === 'meta[name="google"][content="notranslate"]' ? appended.find((m) => m.name === 'google' && m.content === 'notranslate') ?? null : null),
    createElement: () => ({}),
    addEventListener: () => {},
  }
  class MutationObserver {
    constructor(fn) {
      observer = fn
    }
    observe() {}
  }
  vm.runInContext(src('no-translate.js'), vm.createContext({ document, MutationObserver }))
  assert.equal(attrs.translate, 'no')
  assert.ok(classes.has('notranslate'))
  assert.equal(appended.filter((m) => m.name === 'google' && m.content === 'notranslate').length, 1)
  // หน้าเว็บวาด <html> ใหม่แล้วลบออก → ตัวเฝ้าใส่คืน (ไม่ใส่ meta ซ้ำ)
  delete attrs.translate
  classes.clear()
  observer()
  assert.equal(attrs.translate, 'no')
  assert.ok(classes.has('notranslate'))
  assert.equal(appended.length, 1)
})

// ── ตรวจโค้ดที่ต่อสายไว้ (ไม่มี DOM จริงให้รัน content script ทั้งไฟล์) ──
const manifest = JSON.parse(src('manifest.json'))
const flow = src('content-flow-agent.js')
const bg = src('background.js')

test('manifest: no-translate.js ที่ document_start บน flow.google.com · labs.google · chatgpt.com', () => {
  const nt = manifest.content_scripts.find((c) => c.js.includes('no-translate.js'))
  assert.ok(nt, 'ไม่มี no-translate.js ใน manifest')
  assert.equal(nt.run_at, 'document_start')
  for (const host of ['https://flow.google.com/*', 'https://labs.google/*', 'https://chatgpt.com/*']) assert.ok(nt.matches.includes(host), host)
})

test('flow-text.js โหลดก่อน content-flow-agent.js ทุกทาง (manifest · background · แผงข้าง)', () => {
  const cs = manifest.content_scripts.find((c) => c.js.includes('content-flow-agent.js'))
  assert.deepEqual(cs.js, ['flow-text.js', 'content-flow-agent.js'])
  assert.match(bg, /flow: \['flow-text\.js', 'content-flow-agent\.js'\]/)
  assert.match(src('sidepanel.js'), /files: \['flow-text\.js', 'content-flow-agent\.js'\]/)
})

test('ตัวขับ Flow: เทียบชื่อรุ่นผ่าน sameModel ทุกจุด · ไม่ส่ง Escape ระดับ document ตรง ๆ แล้ว', () => {
  assert.doesNotMatch(flow, /[!=]==\s*model\b/, 'ยังมีการเทียบชื่อรุ่นตรงตัว')
  assert.doesNotMatch(flow, /replace\(\/\^\\S\+\\s\/, ''\) === model/)
  assert.doesNotMatch(flow, /document\.dispatchEvent\(new KeyboardEvent\('keydown', \{ key: 'Escape'/)
  assert.match(flow, /sameModel\(labelText\(m\), model\)/)
  assert.match(flow, /closeStrayMenus\(\)/)
})

test('ตัวตรวจ "ใช้ 0 credits" ก่อนสั่ง agent ยังอยู่ครบทั้งสองทาง', () => {
  const checks = flow.match(/if \(credits !== 0\)/g) ?? []
  assert.equal(checks.length, 2, 'ต้องมีทั้ง runImageJob และ FLOW_AGENT_RUN')
  // ตรวจเครดิตต้องมาก่อนตั้ง Agent และก่อนส่ง prompt
  const job = flow.slice(flow.indexOf('async function runImageJob'))
  assert.ok(job.indexOf('credits !== 0') < job.indexOf('configureAgent('))
  assert.ok(job.indexOf('credits !== 0') < job.indexOf('sendPrompt('))
})

test('หน้าที่ถูกแปล: background โหลดใหม่ก่อนส่งงาน (Flow + ChatGPT) · error บอกสาเหตุ', () => {
  assert.equal((bg.match(/await reloadIfTranslated\(/g) ?? []).length, 2)
  assert.match(flow, /translated: pageTranslated\(\)/)
  assert.equal((flow.match(/errorText\(err\)/g) ?? []).length, 3)
  assert.match(src('content-chatgpt.js'), /translated-\(ltr\|rtl\)/)
})

test('โหลดตัวขับ Flow ทั้งไฟล์ได้ (ต่อสายกับ flow-text.js) · PING รายงานหน้าที่ถูกแปล', () => {
  let listener = null
  const html = { className: 'translated-ltr' }
  const document = { documentElement: html, querySelectorAll: () => [], querySelector: () => null }
  const c = vm.createContext({
    KeyboardEvent,
    document,
    location: { pathname: '/project/abc', href: 'https://flow.google.com/project/abc' },
    MutationObserver: class {
      observe() {}
    },
    chrome: { runtime: { getManifest: () => ({ version: manifest.version }), onMessage: { addListener: (fn) => (listener = fn) } } },
  })
  vm.runInContext(src('flow-text.js'), c)
  vm.runInContext(src('content-flow-agent.js'), c)
  assert.ok(listener, 'ตัวขับไม่ได้ลงทะเบียนรับข้อความ')
  let res = null
  listener({ type: 'PING' }, {}, (r) => (res = r))
  assert.equal(res.ok, true)
  assert.equal(res.translated, true)
  assert.equal(res.loggedIn, true)
  html.className = 'notranslate'
  listener({ type: 'PING' }, {}, (r) => (res = r))
  assert.equal(res.translated, false)
})

console.log(`\nผ่าน ${passed} ข้อ`)
