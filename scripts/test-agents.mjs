// ตรวจไฟล์ภาพและข้อกำหนดของแถบ โดยไม่อ่านข้อมูลลับหรือเรียก bridge
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SEA_ASSETS, DEPARTMENTS, HANDOFF, elapsed } from '../extension/agents.js'

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8')
assert.deepEqual(DEPARTMENTS.map(d => [d.id, d.animal]), [
  ['chatgpt', 'เต่าทะเล'], ['flow', 'ปลาหมึก'], ['voice', 'โลมา'], ['edit', 'ปู'],
])
assert.deepEqual(HANDOFF.map(s => [s.key, s.id]), [
  ['script', 'chatgpt'], ['voice', 'voice'], ['art', 'chatgpt'], ['images', 'flow'], ['edit', 'edit'],
])
assert.equal(elapsed(1_000, 126_000), '2:05')
assert.equal(elapsed('2026-09-17T00:00:00Z', Date.parse('2026-09-17T00:02:10Z')), '2:10')
assert.equal(elapsed(200_000, 126_000), '0:00')
assert.equal(elapsed(null), '')
assert.equal(elapsed('invalid'), '')

for (const animal of Object.values(SEA_ASSETS)) {
  const png = readFileSync(new URL('../extension/agents/' + animal + '-work.png', import.meta.url))
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), 2172, animal + ': ความกว้างสี่เฟรม')
  assert.equal(png.readUInt32BE(20), 724, animal + ': ความสูงเฟรม')
  assert.equal(png[25], 6, animal + ': มี alpha โปร่งใส')
}
const scene = readFileSync(new URL('../extension/agents/undersea-studio.png', import.meta.url))
assert.equal(scene.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
const css = read('extension/agents.css')
assert.match(css, /steps\(4, end\)/)
assert.match(css, /translateX\(-100%\)/)
assert.match(css, /prefers-reduced-motion: reduce/)
assert.match(css, /animation-play-state: paused !important/)
assert.doesNotMatch(css, /url\(['"]?https?:/)
assert.doesNotMatch(read('extension/agents.js'), /requestAnimationFrame|setInterval/)
const panel = read('extension/sidepanel.js')
assert.match(panel, /setInterval\(refreshAgents, 3000\)/)
assert.match(panel, /if \(document.hidden \|\| agentRefreshing\) return/)
assert.equal(JSON.parse(read('extension/manifest.json')).version, '0.9.2')
// ตรวจแบบเผื่อฉากสว่าง/มืดที่สุดใต้สีทับ 94%
const rgb = hex => hex.match(/[a-f0-9]{2}/gi).map(v => parseInt(v, 16) / 255)
const mix = (a, b, weight) => a.map((v, i) => v * weight + b[i] * (1 - weight))
const luminance = color => color.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
const themes = [...read('extension/sidepanel.html').matchAll(/:root\s*\{([^}]+)\}/g)].map(match =>
  Object.fromEntries([...match[1].matchAll(/--(panel|ink|muted|accent|ok|warn):\s*#([a-f0-9]{6})/gi)].map(m => [m[1], rgb(m[2])])))
assert.equal(themes.length, 2)
for (const theme of themes) {
  const extreme = Array(3).fill(luminance(theme.panel) > .5 ? 0 : 1)
  const background = mix(theme.panel, extreme, .94)
  const colors = { ข้อความ: theme.ink, รอง: theme.muted, ทำงาน: mix(theme.accent, theme.ink, .85), ว่าง: mix(theme.ok, theme.ink, .85), รอ: theme.warn }
  for (const [name, color] of Object.entries(colors)) assert.ok(contrast(color, background) >= 4.5, name + ': contrast ต้องไม่น้อยกว่า 4.5:1')
}
console.log('ผ่าน: สัตว์ 4 แผนก, ลำดับ 5 ขั้น, เวลา, ภาพโปร่งใส 4 เฟรม, ลดการเคลื่อนไหว, pause และ poll 3 วินาที')
console.log('ผ่าน: ความต่างสีข้อความและสถานะ >= 4.5:1 ทั้งธีมสว่างและมืด')
