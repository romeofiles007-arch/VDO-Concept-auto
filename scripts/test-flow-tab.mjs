// เทสต์: งาน Flow เปิดเป็นแท็บในหน้าต่างเดิม ไม่เปิดหน้าต่างใหม่ (ผู้ใช้ 31 ต.ค. 2026: "ให้เปิดเป็นแท็บใหม่นะ")
//   node scripts/test-flow-tab.mjs
// โหลด extension/background.js จริงใน vm พร้อม chrome จำลอง — ไม่เปิดเบราว์เซอร์
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import * as tabClaim from '../extension/tab-claim.js'

const EXT = join(fileURLToPath(new URL('..', import.meta.url)), 'extension')
const bgSource = readFileSync(join(EXT, 'background.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'))

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ✓ ${name}`)
}

/** chrome จำลอง: tabs = [{ id, windowId, url, incognito }] · windows = [{ id, incognito }] · focused = id หน้าต่างล่าสุด */
function makeChrome({ tabs, windows, focused, redirects, pages = null }) {
  const calls = []
  const rec = (name, value) => (...args) => {
    calls.push([name, ...args])
    return Promise.resolve(typeof value === 'function' ? value(...args) : value)
  }
  const event = () => ({ addListener: () => {}, removeListener: () => {} })
  const onUpdated = {
    addListener: (fn) => queueMicrotask(() => fn(tabs[0]?.id, { status: 'complete' })),
    removeListener: () => {},
  }
  const chrome = {
    runtime: { id: 'this-ext', onInstalled: event(), onStartup: event(), onMessage: event(), getManifest: () => manifest, reload: () => {} },
    alarms: { onAlarm: event(), create: () => {} },
    notifications: { onClicked: event() },
    storage: {
      local: { get: async () => ({}), set: rec('storage.local.set') },
      session: { get: async () => ({}), set: rec('storage.session.set') },
    },
    sidePanel: { setPanelBehavior: async () => {}, setOptions: rec('sidePanel.setOptions'), open: async () => {} },
    tabs: {
      query: rec('tabs.query', (q) => (q.windowId != null ? tabs.filter((t) => t.windowId === q.windowId) : tabs)),
      update: rec('tabs.update', (id, props) => {
        const tab = tabs.find((t) => t.id === id)
        // Flow พา project ของบัญชีอื่นไปหน้า /404 เอง (redirects = { url ที่เปิด: url ที่ไปลงจริง })
        if (tab && props?.url) tab.url = redirects?.[props.url] ?? props.url
        return tab
      }),
      get: rec('tabs.get', (id) => tabs.find((t) => t.id === id)),
      create: rec('tabs.create', (props) => {
        if (!pages) return tabs[0]
        const tab = { id: 99, windowId: 1, url: props.url }
        tabs.unshift(tab)
        return tab
      }),
      move: rec('tabs.move', (id, { windowId }) => Object.assign(tabs.find((t) => t.id === id), { windowId })),
      sendMessage: rec('tabs.sendMessage', { ok: true }),
      onUpdated,
    },
    windows: {
      create: rec('windows.create', { id: 999 }),
      getAll: rec('windows.getAll', () => windows),
      getLastFocused: rec('windows.getLastFocused', () => windows.find((w) => w.id === focused) ?? null),
      get: rec('windows.get', (id) => windows.find((w) => w.id === id)),
    },
    // pages = { tabId: Map } → จำลอง sessionStorage ของแต่ละแท็บ (ป้ายเจ้าของแท็บ tab-claim.js)
    scripting: {
      executeScript: rec('scripting.executeScript', ({ target, func, args = [] }) => {
        if (!pages || !/sessionStorage/.test(String(func))) return [{ result: false }]
        const m = (pages[target.tabId] ??= new Map())
        const saved = globalThis.sessionStorage
        globalThis.sessionStorage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }
        try { return [{ result: func(...args) }] } finally { globalThis.sessionStorage = saved }
      }),
    },
  }
  return { chrome, calls }
}

function loadBackground(env) {
  const { chrome, calls } = makeChrome(env)
  const ctx = vm.createContext({ ...tabClaim, chrome, console: { log() {}, warn() {} }, setTimeout, clearTimeout, setInterval: (...a) => setInterval(...a).unref(), clearInterval, queueMicrotask, URL, fetch: async () => ({ ok: false, status: 500 }) })
  vm.runInContext(bgSource.replace(/^import \{[^\n]+\} from '\.\/tab-claim\.js'\r?\n/m, ''), ctx)
  return { ctx, calls }
}
const names = (calls) => calls.map((c) => c[0])
// ออบเจกต์ที่สร้างใน vm มี prototype ต่างกับของเทสต์ — เทียบผ่าน JSON
const args = (calls, name) => JSON.parse(JSON.stringify(calls.find((c) => c[0] === name)?.slice(1) ?? null))

await test('แท็บ Flow ในหน้าต่างหลัก: ปิดแผงข้างเฉพาะแท็บนี้ ไม่ย้าย ไม่เปิดหน้าต่างใหม่', async () => {
  const tabs = [
    { id: 7, windowId: 1, url: 'https://flow.google.com/' },
    { id: 3, windowId: 1, url: 'https://github.com/' },
  ]
  const { ctx, calls } = loadBackground({ tabs, windows: [{ id: 1 }], focused: 1 })
  await ctx.keepFlowInTab(tabs[0])
  assert.deepEqual(args(calls, 'sidePanel.setOptions'), [{ tabId: 7, enabled: false }])
  assert.ok(!names(calls).includes('tabs.move'))
  assert.ok(!names(calls).includes('windows.create'))
})

await test('แท็บ Flow ที่รุ่นก่อนย้ายไปอยู่หน้าต่างแยก → ย้ายกลับเป็นแท็บท้ายสุดของหน้าต่างที่ใช้ล่าสุด', async () => {
  const tabs = [
    { id: 7, windowId: 2, url: 'https://flow.google.com/' },
    { id: 3, windowId: 1, url: 'https://github.com/' },
    { id: 4, windowId: 5, url: 'https://example.com/' },
  ]
  const { ctx, calls } = loadBackground({ tabs, windows: [{ id: 5 }, { id: 1 }, { id: 2 }], focused: 1 })
  await ctx.keepFlowInTab(tabs[0])
  assert.deepEqual(args(calls, 'tabs.move'), [7, { windowId: 1, index: -1 }])
  assert.ok(!names(calls).includes('windows.create'))
})

await test('หน้าต่างล่าสุดคือหน้าต่างของ Flow เอง → ย้ายไปหน้าต่างปกติอื่น · ไม่มีหน้าต่างอื่น → อยู่ที่เดิม', async () => {
  const tabs = [
    { id: 7, windowId: 2, url: 'https://flow.google.com/' },
    { id: 3, windowId: 1, url: 'https://github.com/' },
  ]
  const a = loadBackground({ tabs, windows: [{ id: 2 }, { id: 1 }], focused: 2 })
  await a.ctx.keepFlowInTab(tabs[0])
  assert.deepEqual(args(a.calls, 'tabs.move'), [7, { windowId: 1, index: -1 }])

  const only = [{ id: 7, windowId: 2, url: 'https://flow.google.com/' }]
  const b = loadBackground({ tabs: only, windows: [{ id: 2 }], focused: 2 })
  await b.ctx.keepFlowInTab(only[0])
  assert.ok(!names(b.calls).includes('tabs.move'))
})

await test('ไม่ย้ายข้ามหน้าต่างไม่ระบุตัวตน (incognito) กับหน้าต่างปกติ', async () => {
  const tabs = [
    { id: 7, windowId: 2, url: 'https://flow.google.com/', incognito: false },
    { id: 3, windowId: 1, url: 'https://github.com/', incognito: true },
  ]
  const { ctx, calls } = loadBackground({ tabs, windows: [{ id: 2 }, { id: 1, incognito: true }], focused: 1 })
  await ctx.keepFlowInTab(tabs[0])
  assert.ok(!names(calls).includes('tabs.move'))
})

await test('งานสร้างภาพ: ปิดแผงข้างบนแท็บ Flow ก่อนโหลดหน้า แล้วส่งงานในแท็บเดิม — ไม่มีหน้าต่างใหม่', async () => {
  const tabs = [
    { id: 7, windowId: 1, url: 'https://flow.google.com/' },
    { id: 3, windowId: 1, url: 'https://github.com/' },
  ]
  const { ctx, calls } = loadBackground({ tabs, windows: [{ id: 1 }], focused: 1 })
  await ctx.handleJob({ id: 'j1', agent: 'flow', kind: 'generate-images', payload: { agent: 'flow' } })
  const order = names(calls)
  assert.ok(!order.includes('windows.create'), 'ห้ามเปิดหน้าต่างใหม่')
  const panelOff = order.indexOf('sidePanel.setOptions')
  const load = order.indexOf('tabs.update')
  assert.ok(panelOff >= 0 && load > panelOff, 'ต้องปิดแผงข้างก่อนโหลดหน้า Flow')
  assert.deepEqual(JSON.parse(JSON.stringify(calls[load].slice(1))), [7, { url: 'https://flow.google.com/?hl=en', active: true }])
  assert.equal(calls.find((c) => c[0] === 'tabs.sendMessage')[1], 7)
})

const loads = (calls) => calls.filter((c) => c[0] === 'tabs.update' && c[2]?.url).map((c) => c[2].url)

await test('ลองซ้ำ: กลับ project เดิมของคลิป (รับลิงก์ /u/N/project/ ด้วย)', async () => {
  const tabs = [{ id: 7, windowId: 1, url: 'https://flow.google.com/' }]
  const { ctx, calls } = loadBackground({ tabs, windows: [{ id: 1 }], focused: 1 })
  await ctx.handleJob({ id: 'j2', agent: 'flow', kind: 'generate-images', payload: { agent: 'flow', projectUrl: 'https://flow.google.com/u/2/project/abc' } })
  assert.deepEqual(loads(calls), ['https://flow.google.com/u/2/project/abc?hl=en'])
})

await test('project เดิมเป็นของบัญชีอื่น (Flow พาไป /404) → โหลดหน้าแรกของบัญชีเดิมแทน ไม่ล้มทั้งคลิป', async () => {
  const tabs = [{ id: 7, windowId: 1, url: 'https://flow.google.com/' }]
  const redirects = {
    'https://flow.google.com/project/abc?hl=en': 'https://flow.google.com/404?reason=project',
    'https://flow.google.com/u/1/project/xyz?hl=en': 'https://flow.google.com/u/1/404?reason=project',
  }
  const a = loadBackground({ tabs, windows: [{ id: 1 }], focused: 1, redirects })
  await a.ctx.handleJob({ id: 'j3', agent: 'flow', kind: 'generate-images', payload: { agent: 'flow', projectUrl: 'https://flow.google.com/project/abc' } })
  assert.deepEqual(loads(a.calls), ['https://flow.google.com/project/abc?hl=en', 'https://flow.google.com/?hl=en'])

  const b = loadBackground({ tabs, windows: [{ id: 1 }], focused: 1, redirects })
  await b.ctx.handleJob({ id: 'j4', agent: 'flow', kind: 'generate-images', payload: { agent: 'flow', projectUrl: 'https://flow.google.com/u/1/project/xyz' } })
  assert.deepEqual(loads(b.calls), ['https://flow.google.com/u/1/project/xyz?hl=en', 'https://flow.google.com/u/1/?hl=en'])
})

await test('project เดิมเปิดได้ปกติ → ไม่โหลดซ้ำ', async () => {
  const tabs = [{ id: 7, windowId: 1, url: 'https://flow.google.com/' }]
  const { ctx, calls } = loadBackground({ tabs, windows: [{ id: 1 }], focused: 1 })
  await ctx.handleJob({ id: 'j5', agent: 'flow', kind: 'generate-images', payload: { agent: 'flow', projectUrl: 'https://flow.google.com/project/abc' } })
  assert.deepEqual(loads(calls), ['https://flow.google.com/project/abc?hl=en'])
})

await test('แท็บ ChatGPT ที่ระบบอื่นในโปรไฟล์เดียวกันถืออยู่ → เปิดแท็บของตัวเองแทน ไม่ส่ง prompt ลงแท็บนั้น', async () => {
  const other = new Map([['__autoBridgeTabOwner', JSON.stringify({ id: 'dhamma-ext', at: Date.now() })]])
  const tabs = [{ id: 5, windowId: 1, url: 'https://chatgpt.com/' }]
  const pages = { 5: other }
  const { ctx, calls } = loadBackground({ tabs, windows: [{ id: 1 }], focused: 1, pages })
  const tab = await ctx.ensureTab('chatgpt')
  assert.equal(tab.id, 99)
  assert.ok(names(calls).includes('tabs.create'))
  assert.equal(JSON.parse(pages[99].get('__autoBridgeTabOwner')).id, 'this-ext')
  assert.equal(JSON.parse(other.get('__autoBridgeTabOwner')).id, 'dhamma-ext', 'ห้ามทับป้ายของระบบอื่น')
  ctx.releaseTab('chatgpt')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(pages[99].get('__autoBridgeTabOwner'), undefined, 'งานจบแล้วต้องถอดป้าย')
})

await test('แท็บ ChatGPT ว่าง → ใช้แท็บเดิม ติดป้ายของเรา ไม่เปิดแท็บใหม่', async () => {
  const tabs = [{ id: 5, windowId: 1, url: 'https://chatgpt.com/' }]
  const pages = {}
  const { ctx, calls } = loadBackground({ tabs, windows: [{ id: 1 }], focused: 1, pages })
  const tab = await ctx.ensureTab('chatgpt')
  assert.equal(tab.id, 5)
  assert.ok(!names(calls).includes('tabs.create'))
  assert.equal(JSON.parse(pages[5].get('__autoBridgeTabOwner')).id, 'this-ext')
  ctx.releaseTab('chatgpt')
})

await test('โค้ดไม่มีการเปิดหน้าต่างใหม่แล้ว · ไม่ขอสิทธิ์อ่านจอ (system.display) ที่ไม่ใช้แล้ว', () => {
  assert.doesNotMatch(bgSource, /chrome\.windows\.create/)
  assert.doesNotMatch(bgSource, /ensureWideFlow|flowWindowBounds/)
  assert.ok(!manifest.permissions.includes('system.display'))
  assert.ok(manifest.permissions.includes('sidePanel'))
})

console.log(`\nผ่าน ${passed} ข้อ`)
