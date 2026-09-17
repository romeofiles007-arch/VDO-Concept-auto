// ตรวจสีและฉากโดยไม่อ่านค่าลับหรือเรียก bridge
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../extension/agents.css', import.meta.url), 'utf8')
const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8')
const luminance = hex => {
  if (hex.length === 4) hex = '#' + [...hex.slice(1)].map(c => c + c).join('')
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722
}
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
const roots = [...html.matchAll(/:root\s*\{([^}]+)\}/g)]
assert.equal(roots.length, 2)
const themes = []
for (const [i, root] of roots.entries()) {
  const colors = Object.fromEntries([...root[1].matchAll(/--([\w-]+):\s*(#[\da-f]+)/gi)].map(m => [m[1], m[2]]))
  themes.push(colors)
  let minimum = Infinity
  for (const fg of ['ink', 'muted', 'accent', 'ok', 'warn', 'danger']) {
    for (const bg of ['bg', 'panel', 'pick']) {
      const ratio = contrast(colors[fg], colors[bg])
      assert.ok(ratio >= 4.5, `${i ? 'มืด' : 'สว่าง'} ${fg}/${bg}: ${ratio.toFixed(2)}`)
      minimum = Math.min(minimum, ratio)
    }
  }
  assert.ok(contrast(colors['accent-ink'], colors.accent) >= 4.5)
  // กล่องโปร่งเล็กน้อย ทดสอบกรณีภาพด้านหลังดำ/ขาวสนิท
  const hex = values => '#' + values.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
  const panel = [1, 3, 5].map(n => parseInt(colors.panel.slice(n, n + 2), 16))
  for (const backdrop of [0, 255]) {
    const surface = hex(panel.map(v => v * .92 + backdrop * .08))
    for (const fg of ['ink', 'muted', 'accent', 'ok', 'warn', 'danger']) assert.ok(contrast(colors[fg], surface) >= 4.5, `ข้อความบนกล่องภาพ ${fg}`)
  }
  for (const bg of ['bg', 'panel', 'pick']) assert.ok(contrast(colors.line, colors[bg]) >= 3, `ขอบ/${bg}`)
  console.log(`ผ่านธีม${i ? 'มืด' : 'สว่าง'}: contrast ข้อความต่ำสุด ${minimum.toFixed(2)}:1`)
}
for (const id of ['chatgpt', 'flow', 'voice', 'edit']) {
  const rules = [...css.matchAll(new RegExp(`html\\[data-dept='${id}'\\]\\s*\\{([^}]+)\\}`, 'g'))]
  assert.equal(rules.length, 2)
  const overrides = rules.map(rule => Object.fromEntries([...rule[1].matchAll(/--([\w-]+):\s*(#[\da-f]+)/gi)].map(m => [m[1], m[2]])))
  for (const i of [0, 1]) {
    const colors = { ...themes[i], ...overrides[0], ...(i ? overrides[1] : {}) }
    for (const fg of ['ink', 'muted', 'accent', 'ok', 'warn', 'danger']) {
      for (const bg of ['bg', 'panel', 'pick']) assert.ok(contrast(colors[fg], colors[bg]) >= 4.5, `${id}/${i}/${fg}/${bg}`)
      for (const backdrop of [0, 255]) {
        const surface = '#' + [1, 3, 5].map(n => Math.round(parseInt(colors.panel.slice(n, n + 2), 16) * .92 + backdrop * .08).toString(16).padStart(2, '0')).join('')
        assert.ok(contrast(colors[fg], surface) >= 4.5, `${id}/${i}/${fg}/ภาพ`)
      }
    }
    assert.ok(contrast(colors['accent-ink'], colors.accent) >= 4.5, `${id}/${i}/ปุ่ม`)
    for (const bg of ['bg', 'panel', 'pick']) assert.ok(contrast(colors.line, colors[bg]) >= 3, `${id}/${i}/ขอบ`)
  }
  assert.match(rules[0][1], new RegExp(`--world-image: url\\('agents/ocean-${id}\\.png'\\)`))
  const asset = readFileSync(new URL(`../extension/agents/ocean-${id}.png`, import.meta.url))
  assert.ok(asset.readUInt32BE(16) >= 1024 && asset.readUInt32BE(20) >= 1536)
}
console.log('ผ่าน: ภาพและสีครบ 4 แผนก × 2 ธีม รวมพื้นภาพดำ/ขาวกรณีแย่สุด')
assert.match(js, /setInterval\(refreshAgents, 3000\)/)
assert.match(js, /if \(document\.hidden \|\| agentRefreshing\) return/)
assert.match(js, /hero\.dataset\.department = id/)
assert.match(js, /new IntersectionObserver/)
assert.match(css, /data-offscreen='true'/)
assert.match(css, /prefers-reduced-motion: reduce/)
assert.doesNotMatch(js, /requestAnimationFrame/)
const png = readFileSync(new URL('../extension/agents/department-props.png', import.meta.url))
assert.equal(png.readUInt32BE(16), 2172)
assert.equal(png.readUInt32BE(20), 724)
assert.equal(png[25], 6, 'ต้องเป็น PNG RGBA')
assert.match(css, /url\('agents\/department-props\.png'\)/)
assert.match(html, /class="heroProps" aria-hidden="true"/)
assert.match(html, /body::before.*position: fixed.*pointer-events: none.*ocean-world\.png/)
const world = readFileSync(new URL('../extension/agents/ocean-world.png', import.meta.url))
assert.ok(world.readUInt32BE(16) >= 1024 && world.readUInt32BE(20) >= 1536)
console.log('ผ่าน: ภาพโปร่งใส 4 ช่อง, หยุดเมื่อซ่อน/พ้นจอ, reduced-motion และ polling เดิม')
