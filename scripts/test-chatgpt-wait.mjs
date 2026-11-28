/**
 * เทสต์ตัวรอคำตอบ ChatGPT (extension/content-chatgpt.js) กับหน้า ChatGPT จำลอง + นาฬิกาจำลอง
 * เจอจริง 26 พ.ย. 2026: คำตอบขึ้นครบบนจอ แต่ extension รอ "ตอบจบ" ไปจนหมดเวลา งานไม่กลับมาที่โปรแกรม
 *
 * - หน้าปกติ (ปุ่มหยุดหายแล้วแถบปุ่มใต้คำตอบโผล่) → รับคำตอบภายในไม่กี่วินาที
 * - แถบปุ่มใต้คำตอบหาไม่เจอ (หน้าเปลี่ยน) → ข้อความนิ่ง 90 วิ ก็รับ
 * - ปุ่มหยุดค้างตลอด (selector จับผิดตัว) → ข้อความนิ่ง 4 นาที ก็รับ
 * - หัว "Thinking…" สั้นๆ นิ่งนาน → ไม่เอาไปเป็นคำตอบ
 * - id แชตชั่วคราว local-chatgpt → id จริง ไม่นับเป็นระบบอื่นแย่งแท็บ
 * - heartbeat ส่งสถานะการรอไปให้ bridge
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const EXT = fileURLToPath(new URL('../extension/', import.meta.url))
const source = readFileSync(EXT + 'content-chatgpt.js', 'utf8')
const selectorsSrc = readFileSync(EXT + 'selectors.js', 'utf8')

// ── DOM จำลองแบบเล็กที่สุด: element ประกาศเองว่าตรง selector ไหน ──
let order = 0
class El {
  constructor(sels = [], { text = '', attrs = {} } = {}) {
    this.sels = new Set(sels)
    this.children = []
    this.parentElement = null
    this._text = text
    this.attrs = attrs
    this.order = order++
    this.disabled = false
    this.offsetParent = {}
    this.isContentEditable = false
    this.textContent = ''
    this.clicks = 0
  }
  add(...kids) {
    for (const k of kids) {
      k.parentElement = this
      this.children.push(k)
    }
    return this
  }
  get innerText() {
    return [this._text, ...this.children.map((c) => c.innerText)].filter(Boolean).join('\n')
  }
  matches(sel) {
    return this.sels.has(sel.trim())
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()])
  }
  querySelectorAll(selector) {
    const parts = selector.split(/,(?![^[]*\])/).map((s) => s.trim())
    const out = []
    for (const part of parts) {
      const scoped = part.match(/^:scope\s*>\s*(.+)$/)
      const pool = scoped ? this.children : this.all()
      for (const el of pool) if (el.matches(scoped ? scoped[1] : part) && !out.includes(el)) out.push(el)
    }
    return out.sort((a, b) => a.order - b.order)
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
  closest(selector) {
    for (let el = this; el; el = el.parentElement) if (selector.split(',').some((s) => el.matches(s))) return el
    return null
  }
  getAttribute(name) {
    return this.attrs[name] ?? null
  }
  compareDocumentPosition(other) {
    return other.order > this.order ? 4 : 2
  }
  focus() {}
  click() {
    this.clicks++
    this.onclick?.()
  }
  remove() {
    const p = this.parentElement
    if (p) p.children = p.children.filter((c) => c !== this)
    this.parentElement = null
  }
}

const HEAD = 'h4[data-conversation-role="assistant"]'
const BAR = '[class*="turn-action-controls"]'

/**
 * page: ฉากจำลอง — stream = กี่วิกว่าข้อความจะพิมพ์ครบ · bar = แถบปุ่มโผล่ตอนจบไหม · stopForever = ปุ่มหยุดค้าง
 * answer = ข้อความคำตอบ · thinkingOnly = ค้างที่หัว "Thinking…" ไม่ตอบ · swapPath = id ชั่วคราว → จริง
 */
function makePage({ stream = 20, bar = true, stopForever = false, answer = 'ก'.repeat(600), thinkingOnly = false, swapPath = true } = {}) {
  let now = 1_000_000
  const location = { pathname: '/', href: 'https://chatgpt.com/' }
  const main = new El(['main'])
  const body = new El(['body']).add(main)
  const input = new El(['#prompt-textarea', 'div[contenteditable="true"]'])
  input.isContentEditable = true
  const send = new El(['button[data-testid="send-button"]', 'button[aria-label*="Send" i]'])
  const form = new El(['form']).add(input, send)
  body.add(form)
  let stop = null
  let sentAt = null
  let turn = null
  let group = null
  let barAdded = false

  const showStop = () => {
    if (stop) return
    stop = new El(['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'], { attrs: { 'aria-label': 'Stop streaming' } })
    form.add(stop)
  }
  const hideStop = () => {
    stop?.remove()
    stop = null
  }

  function onSend() {
    sentAt = now
    group = new El([])
    const user = new El(['[data-user-message-bubble]'], { text: input.textContent })
    turn = new El([])
    turn.add(new El([HEAD], { text: 'ChatGPT said:' }))
    group.add(user, turn)
    main.add(group)
    input.textContent = ''
    location.pathname = swapPath ? '/c/local-chatgpt%3A71c8f16d-83fa-4a59-afcd-2674c20ea864' : '/c/6b084944-2ca0-83ec-b09c-c499ea864e06'
    showStop()
  }

  // เดินเวลา: ข้อความค่อยๆ พิมพ์ · id แชตเปลี่ยนเป็นของจริงหลัง 3 วิ · จบแล้วปุ่มหยุดหาย + แถบปุ่มโผล่
  function step() {
    if (sentAt == null) return
    const t = (now - sentAt) / 1000
    if (t > 3 && location.pathname.includes('local-')) location.pathname = '/c/6b084944-2ca0-83ec-b09c-c499ea864e06'
    const body = turn.children[1] ?? turn.add(new El([], { text: '' })).children[1]
    if (thinkingOnly) {
      body._text = 'Thinking'
      return
    }
    const shown = Math.min(answer.length, Math.floor((answer.length * t) / stream))
    body._text = answer.slice(0, shown)
    if (shown >= answer.length) {
      if (!stopForever) hideStop()
      if (bar && !barAdded) {
        barAdded = true
        const b = new El([BAR])
        for (let i = 0; i < 6; i++) b.add(new El(['button'], { attrs: { 'aria-label': i ? `Action ${i}` : 'Copy' } }))
        b.sels.add(BAR)
        group.add(b)
      }
    }
  }

  const document = {
    querySelector: (s) => body.querySelector(s),
    querySelectorAll: (s) => body.querySelectorAll(s),
    execCommand() {},
    documentElement: { className: '' },
  }
  return {
    location,
    document,
    input,
    advance(ms) {
      now += ms
      step()
    },
    now: () => now,
    onSend,
  }
}

async function run(page, { prompt = 'นี่คือ prompt ทดสอบของธรรมะ Auto '.repeat(10), progressLog = [] } = {}) {
  let listener = null
  let heartbeatGetter = null
  const result = {}
  const helpers = {
    typeInto: async (el, text) => {
      el.textContent = text
    },
    pressEnter: async () => page.onSend(),
    toBridge: async (type, body) => {
      result[type] = body
      return { ok: true }
    },
    heartbeat: (_id, _onCancel, getProgress) => {
      heartbeatGetter = getProgress
      return () => {}
    },
    pasteFiles() {},
    sleep: async (ms) => page.advance(ms),
    waitFor: async (fn, { timeout = 60_000, interval = 300, label = 'เงื่อนไข' } = {}) => {
      const deadline = page.now() + timeout
      let beats = 0
      for (;;) {
        const v = await fn()
        if (v) return v
        if (page.now() > deadline) throw new Error(`รอ ${label} เกิน ${Math.round(timeout / 1000)} วิ`)
        page.advance(interval)
        if (heartbeatGetter && ++beats % 20 === 0) progressLog.push(heartbeatGetter())
      }
    },
  }
  const FakeDate = class extends Date {
    static now() {
      return page.now()
    }
  }
  const ctx = vm.createContext({
    console: { warn() {}, log() {} },
    globalThis: {},
    location: page.location,
    document: page.document,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    Date: FakeDate,
    bridgeHelpers: helpers,
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => (listener = fn) },
        sendMessage: async (msg) => {
          if (msg.type === 'CHATGPT_PASTE') page.input.textContent = msg.text
          return null
        },
      },
    },
  })
  ctx.globalThis = ctx
  vm.runInContext(`${selectorsSrc}\nglobalThis.SELECTORS = SELECTORS; globalThis.pick = pick; globalThis.pickAll = typeof pickAll === 'function' ? pickAll : undefined`, ctx)
  vm.runInContext(source, ctx)
  const started = page.now()
  await new Promise((resolve) => listener({ type: 'RUN_JOB', job: { id: 'job-1', kind: 'prompt', payload: { prompt, newChat: true } } }, {}, resolve))
  return { text: result.RESULT?.text ?? null, error: result.ERROR?.message ?? null, secs: Math.round((page.now() - started) / 1000), progressLog }
}

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}\n    ${err.message}`)
  }
}
const assert = (ok, msg) => {
  if (!ok) throw new Error(msg)
}

console.log('ตัวรอคำตอบ ChatGPT')
await check('หน้าปกติ: ปุ่มหยุดหาย + แถบปุ่มโผล่ → รับคำตอบเร็ว · id ชั่วคราว→จริง ไม่ปัดทิ้ง', async () => {
  const r = await run(makePage())
  assert(!r.error, `ไม่ควร error: ${r.error}`)
  assert(r.text?.length === 600, `ได้ข้อความ ${r.text?.length}`)
  assert(r.secs < 60, `ใช้เวลา ${r.secs} วิ`)
})
await check('แถบปุ่มใต้คำตอบหาไม่เจอ → ข้อความนิ่ง 90 วิ แล้วรับ (เดิมรอจนหมดเวลา 30 นาที)', async () => {
  const r = await run(makePage({ bar: false }))
  assert(!r.error, `ไม่ควร error: ${r.error}`)
  assert(r.text?.length === 600, `ได้ข้อความ ${r.text?.length}`)
  assert(r.secs >= 90 && r.secs < 200, `ใช้เวลา ${r.secs} วิ`)
})
await check('ปุ่มหยุดค้างตลอด + ไม่มีแถบปุ่ม → ข้อความนิ่ง 4 นาที แล้วรับ', async () => {
  const r = await run(makePage({ bar: false, stopForever: true }))
  assert(!r.error, `ไม่ควร error: ${r.error}`)
  assert(r.text?.length === 600, `ได้ข้อความ ${r.text?.length}`)
  assert(r.secs >= 240 && r.secs < 360, `ใช้เวลา ${r.secs} วิ`)
})
await check('แถบปุ่มโผล่แล้วแต่ปุ่มหยุดค้าง → รับภายใน ~15 วิหลังนิ่ง (เดิมรอ 4 นาทีทุกคำถาม)', async () => {
  const r = await run(makePage({ stopForever: true }))
  assert(!r.error, `ไม่ควร error: ${r.error}`)
  assert(r.text?.length === 600, `ได้ข้อความ ${r.text?.length}`)
  assert(r.secs >= 35 && r.secs < 60, `ใช้เวลา ${r.secs} วิ`)
})
await check('แถบปุ่มโผล่ + ปุ่มหยุดค้าง + คำตอบสั้น → ยังรับได้เร็ว', async () => {
  const r = await run(makePage({ stopForever: true, answer: 'ข'.repeat(120) }))
  assert(r.text?.length === 120, `ได้ข้อความ ${r.text?.length} · ${r.error}`)
  assert(r.secs < 60, `ใช้เวลา ${r.secs} วิ`)
})
await check('หัว "Thinking" สั้นๆ นิ่งนาน → ไม่เอาไปเป็นคำตอบ', async () => {
  const r = await run(makePage({ thinkingOnly: true, bar: false }))
  assert(!r.text, `ไม่ควรได้คำตอบ แต่ได้ "${r.text}"`)
  assert(/เกิน/.test(r.error ?? ''), `ควรหมดเวลารอ: ${r.error}`)
})
await check('คำตอบสั้น (< 200) ที่แถบปุ่มโผล่ปกติ → ยังรับได้ทางปกติ', async () => {
  const r = await run(makePage({ answer: 'ข'.repeat(120) }))
  assert(r.text?.length === 120, `ได้ข้อความ ${r.text?.length} · ${r.error}`)
})

console.log(failed ? `\nล้ม ${failed} ข้อ` : '\nผ่านทุกข้อ')
process.exit(failed ? 1 : 0)
