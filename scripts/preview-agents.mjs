// แผงจริงกับข้อมูลจำลอง ไม่มีการอ่าน .env หรือสั่งงาน bridge
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'
import { ROOT } from '../pipeline/lib/config.mjs'
import { elapsed, HANDOFF } from '../extension/agents.js'
import assert from 'node:assert/strict'

assert.equal(elapsed(1_000, 126_000), '2:05')
assert.equal(elapsed(200_000, 126_000), '0:00')
assert.equal(elapsed('invalid', 126_000), '')
assert.deepEqual(HANDOFF.map(s => s.id), ['chatgpt', 'voice', 'chatgpt', 'flow', 'edit'])
console.log('ผ่าน: เวลาใช้งานและลำดับส่งต่องาน')
if (process.argv.includes('--check')) process.exit(0)

const base = resolve(ROOT, 'extension')
const version = JSON.parse(readFileSync(resolve(base, 'manifest.json'), 'utf8')).version
const fixtureSince = Date.now()
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' }
const stub = `
const params = new URLSearchParams(location.search)
let simulateHidden = false
Object.defineProperty(document, 'hidden', { configurable: true, get: () => simulateHidden })
const storage = { get: async () => ({}), set: async () => {} }
window.chrome = {
  storage: { local: storage, session: storage },
  runtime: { getManifest: () => ({version:${JSON.stringify(version)}}), getURL: path => new URL(path, location.href).href,
    sendMessage: async () => ({ok:true,url:location.origin+'/',token:'fixture-only'}) },
  tabs: { query: async () => [], onUpdated:{addListener(){},removeListener(){}} }
}
window.agentTestStats = {requests:0,changes:0,stable:true,hiddenRequests:null}
const originalFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href)
  if (url.pathname === '/api/agents') {
    window.agentTestStats.requests++
    return originalFetch('/fixture-agents?'+params)
  }
  if (url.pathname.startsWith('/api/')) {
    const payload = url.pathname === '/api/voices' ? {voices:[],selected:null,choice:null}
      : url.pathname === '/api/character' ? {images:[],description:''}
      : url.pathname === '/api/autopilot' ? {status:null,run:null}
      : url.pathname === '/api/clip-settings' ? {orientation:'landscape',subtitles:'none',pause:'natural',options:{subtitles:[{id:'none',label:'ไม่ใส่'}],pause:[{id:'natural',label:'ปกติ'}]}} : {}
    return new Response(JSON.stringify(payload), {headers:{'content-type':'application/json'}})
  }
  return originalFetch(input, init)
}
addEventListener('DOMContentLoaded', () => {
  const bar = document.getElementById('agentBar') ?? document.getElementById('studioHero')
  if (!bar) return
  if (bar.tagName === 'DETAILS') bar.open = params.get('fold') !== '1'
  const first = [...bar.querySelectorAll(bar.id === 'studioHero' ? '.heroCrew .sea-portrait' : '.sea-portrait')]
  window.agentTestStats.nodes = first.length
  let key = ''
  const observer = new MutationObserver(() => {
    const stats = window.agentTestStats
    stats.stable &&= first.every(n => n.isConnected)
    const rows = [...bar.querySelectorAll('.agent, .heroCrew button')]
    const newKey = rows.map(e => e.dataset.state).join(',')
    if (newKey !== key) {stats.changes++; key = newKey}
  })
  observer.observe(bar, {subtree:true,childList:true,attributes:true})
  // ปุ่มทดสอบใช้ได้เฉพาะหน้า preview
  const controls = document.createElement('div')
  controls.innerHTML = '<button id="testHidden">จำลองซ่อนแผง</button><button id="testVisible">จำลองเปิดแผง</button><button id="testNext">ทดสอบส่งต่อขั้นถัดไป</button>'
  controls.style.cssText = 'margin:12px;font-size:12px;display:flex;flex-wrap:wrap;gap:6px'
  document.body.append(controls)
  const output = document.createElement('output')
  output.id = 'agentTestReport'
  output.style.cssText = 'flex-basis:100%;min-width:0;max-width:100%;overflow-wrap:anywhere'
  controls.append(output)
  const report = () => { output.textContent = JSON.stringify(window.agentTestStats) }
  setInterval(report, 1000)
  report()
  document.getElementById('testHidden').onclick = () => {
    simulateHidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    const before = window.agentTestStats.requests
    setTimeout(() => { window.agentTestStats.hiddenRequests = window.agentTestStats.requests - before }, 6500)
  }
  document.getElementById('testVisible').onclick = () => {
    simulateHidden = false
    document.dispatchEvent(new Event('visibilitychange'))
  }
  document.getElementById('testNext').onclick = () => {
    const stages = ['script','voice','art','images','edit']
    params.set('auto', stages[(stages.indexOf(params.get('auto'))+1)%stages.length])
    document.dispatchEvent(new Event('visibilitychange'))
  }
})
`

createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:18768')
  const reply = (type, value) => { res.writeHead(200, {'content-type':type,'cache-control':'no-store'}); res.end(value) }
  if (url.pathname === '/fixture-stub.js') return reply('text/javascript', stub)
  if (url.pathname === '/fixture-agents') {
    const mode = url.searchParams.get('case') ?? 'mixed'
    const ids = ['chatgpt', 'flow', 'voice', 'edit']
    const names = ['ChatGPT','Google Flow','เสียงพากย์','ตัดต่อ']
    const work = ['เขียนบทเรื่องความกลัวให้เล่าเข้าใจง่าย','วาดภาพช็อตที่ 12 จาก 24','สร้างเสียงพากย์ภาษาไทย','ตัดต่อภาพและเสียงเป็นวิดีโอ']
    const states = ['working','waiting','idle','offline']
    const auto = url.searchParams.get('auto')
    const failed = mode === 'failed'
    const autoState = failed ? 'failed' : mode === 'done' ? 'done' : 'running'
    return reply('application/json', JSON.stringify({
      agents: ids.map((id,i) => ({id,name:names[i],state:mode === 'mixed' ? states[i] : ['working','waiting','idle','offline'].includes(mode) ? mode : 'idle',
        doing:mode === 'mixed' ? [work[0],'รอบทและคำกำกับภาพ','พร้อมรับงาน','ส่วนขยายยังไม่ได้ต่อ'][i] : work[i],since:fixtureSince-((i+1)*63_000),queued:mode==='waiting'?2:0,attempt:1})),
      autopilot: auto ? {title:'ทำไมเราถึงกลัวความมืด',current:auto,status:autoState,startedAt:Date.now()-300_000,
        departments:failed ? {[auto]:{status:'failed',detail:'ทดสอบงานไม่สำเร็จ'}} : null} : null, at:Date.now()
    }))
  }
  const file = resolve(base, '.' + (url.pathname === '/' ? '/sidepanel.html' : url.pathname))
  if (!file.startsWith(base + sep) || !types[extname(file)] || !existsSync(file)) {res.writeHead(404);return res.end()}
  let content = readFileSync(file)
  if (extname(file) === '.html') {
    content = content.toString().replace('<title>Cartoon Auto</title>', '<title>ตัวอย่างสถานะแผนก AI</title><script src="/fixture-stub.js"></script>')
    // ใช้กฎธีมจริง โดยบังคับเงื่อนไขในหน้า fixture เท่านั้น
    content = content.replace('@media (prefers-color-scheme: dark)', url.searchParams.get('theme') === 'light' ? '@media not all' : '@media all')
  }
  if (extname(file) === '.css' && req.headers.referer) {
    const params = new URL(req.headers.referer).searchParams
    content = content.toString().replaceAll('@media (prefers-color-scheme: dark)', params.get('theme') === 'light' ? '@media not all' : '@media all')
    if (params.get('motion') === 'reduce') content = content.toString().replaceAll('@media (prefers-reduced-motion: reduce)', '@media all')
  }
  reply(types[extname(file)], content)
}).listen(18768, '127.0.0.1', () => console.log('ตัวอย่างข้อมูลจำลอง: http://127.0.0.1:18768/?case=mixed&auto=art&theme=light'))
