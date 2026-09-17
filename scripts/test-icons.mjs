import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import { ROOT } from '../pipeline/lib/config.mjs'
import { createUi } from '../bridge/ui.js'

const manifest = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8'))
for (const size of [16, 32, 48, 128]) {
  const file = manifest.icons[size]
  assert.equal(manifest.action.default_icon[size], file)
  const bytes = readFileSync(join(ROOT, 'extension', file))
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
  assert.equal(bytes.readUInt32BE(16), size)
  assert.equal(bytes.readUInt32BE(20), size)
}
const css = readFileSync(join(ROOT, 'extension/icons.css'), 'utf8')
for (const name of ['idea', 'script', 'mic', 'clock', 'shots', 'image', 'video', 'check', 'warning', 'close']) {
  assert.ok(css.includes(`[data-icon="${name}"]`), `Missing icon ${name}`)
}
const html = readFileSync(join(ROOT, 'ui/index.html'), 'utf8')
const inline = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: inline, encoding: 'utf8' })
assert.equal(syntax.status, 0, syntax.stderr)

// Exercise the public asset allowlist without touching project data or jobs.
const port = 18767
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const ui = createUi({ jobs: new Map(), enqueue() {}, lastPoll: {}, token: 'test-only', port, json, log() {} })
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`)
  if (!await ui.handle(req, res, url)) { res.writeHead(404); res.end() }
})
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
try {
  for (const [path, type] of [['icons.css', 'text/css'], ['icons.js', 'text/javascript'], ['cartoon-auto.svg', 'image/svg+xml']]) {
    const res = await fetch(`http://127.0.0.1:${port}/assets/${path}`)
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type').startsWith(type))
    assert.ok((await res.text()).length > 100)
  }
  const refusedStatus = await new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/assets/icons.css', headers: { host: 'external.invalid' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
  assert.equal(refusedStatus, 403)
  const unknown = await fetch(`http://127.0.0.1:${port}/assets/not-allowed.js`)
  assert.equal(unknown.status, 404)
} finally { await new Promise(resolve => server.close(resolve)) }
console.log('Icon checks passed: PNG sizes, icon coverage, UI syntax, asset types and host guard.')

// Optional read-only static preview of the extension, without a Chrome session.
if (process.argv.includes('--preview')) {
  const assets = {
    '/': ['sidepanel.html', 'text/html'], '/sidepanel.js': ['sidepanel.js', 'text/javascript'],
    '/prompts.js': ['prompts.js', 'text/javascript'], '/icons.js': ['icons.js', 'text/javascript'],
    '/icons.css': ['icons.css', 'text/css'], '/icons/cartoon-auto.svg': ['icons/cartoon-auto.svg', 'image/svg+xml'],
  }
  createServer((req, res) => {
    const asset = assets[new URL(req.url, 'http://127.0.0.1:18766').pathname]
    if (!asset || !existsSync(join(ROOT, 'extension', asset[0]))) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': `${asset[1]}; charset=utf-8` })
    res.end(readFileSync(join(ROOT, 'extension', asset[0])))
  }).listen(18766, '127.0.0.1', () => console.log('Static icon preview: http://127.0.0.1:18766/ (Chrome APIs intentionally unavailable).'))
}
