(() => {
if (globalThis.__cartoon_flow_agent) return // ฉีดซ้ำ → ไม่เพิ่ม listener ซ้ำ
globalThis.__cartoon_flow_agent = true

/**
 * ขับ Google Flow (flow.google.com) แบบ Agent — ตรวจกับหน้าเว็บจริงแล้ว (ก.ย. 2026)
 *
 *   1. เปิด/สร้าง project
 *   2. ตั้งช่องพิมพ์ปกติเป็น Image · 16:9 หรือ 9:16 · Nano Banana 2 Lite · x1 แล้วอ่าน "Generating will use N credits"
 *      ถ้าไม่ใช่ 0 credits → หยุดทันที ไม่เปิดอะไรต่อ
 *   3. เปิด Agent → Agent settings: ตั้ง Image default ชุดเดียวกัน + Confirm before generating = Never → Save
 *   4. วาง prompt (Style Bible + Character Bible + Shot List) แล้วกดส่ง
 *
 * ข้อความที่แผงข้างส่งมา:
 *   FLOW_AGENT_RUN  { prompt, expected, model, dryRun }  → { ok, credits, projectUrl }
 *   FLOW_AGENT_STATUS                                    → { ok, images, busy }
 *   FLOW_AGENT_RENAME { prompt }                         → { ok, names }   สั่ง agent ตั้งชื่อ "00_00_00.png SHOT 01"
 *   FLOW_AGENT_LIST                                      → { ok, images: [{ id, name, filename }] }
 *   FLOW_AGENT_IMAGE  { id }                             → { ok, base64 (PNG), width, height }
 */
const VERSION = chrome.runtime.getManifest().version
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, { timeout = 20_000, interval = 250, label = 'หน้าเว็บ' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`รอ ${label} ไม่เจอ (${Math.round(timeout / 1000)} วิ) — หน้า Google Flow อาจเปลี่ยน`)
    await sleep(interval)
  }
}

/** คลิกแบบคนจริง — ปุ่ม Material บางตัว (เช่น Settings ของ Agent) ไม่รับ .click() เปล่าๆ */
function realClick(el) {
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }
  el.dispatchEvent(new PointerEvent('pointerdown', opts))
  el.dispatchEvent(new MouseEvent('mousedown', opts))
  el.dispatchEvent(new PointerEvent('pointerup', opts))
  el.dispatchEvent(new MouseEvent('mouseup', opts))
  el.dispatchEvent(new MouseEvent('click', opts))
}

const text = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim()
const visible = (el) => !!el && el.getBoundingClientRect().width > 0
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

const SEL = {
  newProject: () => $$('button').find((b) => /new project/i.test(text(b)) && visible(b)),
  agentChip: () => document.querySelector('button.agent-mode-chip'),
  settingsTrigger: () => $$('button[aria-label="Settings trigger"]').find(visible),
  agentSettings: () => $$('button[aria-label="Settings"]').find(visible),
  agentPanel: () => document.querySelector('flow-agent-panel'),
  editor: () => $$('flow-prompt-box .ProseMirror, flow-base-prompt-box .ProseMirror').find(visible) ?? $$('.ProseMirror[contenteditable="true"]').find(visible),
  send: () => $$('button[aria-label="Start generation"]').find(visible),
}

const agentOn = () => SEL.agentChip()?.getAttribute('aria-pressed') === 'true'

/**
 * เปิด/ปิดโหมด Agent แล้วตรวจผล — ปุ่มถูกวาดใหม่ทุกครั้งที่สลับ (element เปลี่ยนตัว)
 * ลำดับ pointer+mouse event บางครั้งไม่ติด ส่วน .click() บางครั้งไม่ติด → สลับวิธีแล้วลองซ้ำ
 */
async function setAgent(on) {
  for (let attempt = 0; attempt < 6 && agentOn() !== on; attempt++) {
    const chip = await waitFor(() => (visible(SEL.agentChip()) ? SEL.agentChip() : null), { label: 'ปุ่ม Agent' })
    if (attempt % 2 === 0) chip.click()
    else realClick(chip)
    await waitFor(() => agentOn() === on, { timeout: 2500, label: 'สลับโหมด Agent' }).catch(() => null)
    await sleep(300)
  }
  if (agentOn() !== on) throw new Error(`${on ? 'เปิด' : 'ปิด'}โหมด Agent ไม่สำเร็จ — กดปุ่ม Agent ในช่องพิมพ์ของ Flow เองแล้วสั่งใหม่`)
}

/** ปุ่มตัวเลือกใน toggle group — จับจากข้อความท้ายปุ่ม เช่น "16:9", "x1", "Image" */
function toggle(root, label) {
  return $$('button[role="radio"]', root).find((b) => text(b).split(' ').pop() === label || text(b).endsWith(label))
}

async function choose(root, label) {
  const btn = await waitFor(() => toggle(root, label), { label: `ตัวเลือก ${label}` })
  if (btn.getAttribute('aria-checked') !== 'true') {
    realClick(btn)
    await sleep(300)
  }
}

async function chooseModel(trigger, model) {
  if (text(trigger).includes(model) && !text(trigger).includes(`${model} `)) return
  realClick(trigger)
  const item = await waitFor(
    () => $$('[role="menuitem"]').find((m) => text(m).replace(/^\S+\s/, '') === model || text(m).endsWith(` ${model}`)),
    { label: `โมเดล ${model}` },
  )
  realClick(item)
  await waitFor(() => text(trigger).includes(model), { label: `เลือกโมเดล ${model}` })
}

async function openProject() {
  if (/\/project\//.test(location.pathname)) return
  const btn = await waitFor(SEL.newProject, { timeout: 30_000, label: 'ปุ่ม New project' })
  realClick(btn)
  await waitFor(() => /\/project\//.test(location.pathname), { timeout: 30_000, label: 'project ใหม่' })
  await waitFor(SEL.editor, { timeout: 30_000, label: 'ช่องพิมพ์ของ project' })
}

/** ช่องพิมพ์ปกติ (ไม่ใช่ agent) มีตัวบอกจำนวน credit — ใช้ตรวจว่าชุดนี้ฟรีจริงก่อนให้ agent ใช้ */
async function verifyFreeSettings(model, ratio = "16:9") {
  // project ใหม่ของ Flow (ก.ย. 2026) เปิดแชต Agent ด้านขวาเอง → ช่องพิมพ์ปกติที่มีปุ่ม Agent/ตัวเลือกโมเดลถูกซ่อน → ปิดแชตก่อน
  const chatPanel = SEL.agentPanel()
  if (visible(chatPanel) && !SEL.settingsTrigger() && !visible(SEL.agentChip())) {
    const close = $$('button[aria-label="Close"]', chatPanel).find(visible)
    if (close) {
      realClick(close)
      await waitFor(() => visible(SEL.agentChip()), { timeout: 10_000, label: 'ช่องพิมพ์หลังปิดแชต Agent' })
      await sleep(500)
    }
  }
  await setAgent(false)
  await waitFor(SEL.settingsTrigger, { label: 'ปุ่มตั้งค่าโมเดล' })

  // แผงตั้งค่าโมเดลวาดใหม่ทุกครั้งที่เปลี่ยนตัวเลือก (เช่น Video → Image) → ห้ามเก็บ element ไว้ใช้ซ้ำ ต้อง query ใหม่ทุกครั้ง
  const pane = () => $$('.cdk-overlay-pane').find((p) => visible(p) && /Generating will use/i.test(text(p)))
  const readPane = () => {
    const p = pane()
    if (!p) return null
    const on = (label) => $$('button[role="radio"]', p).find((b) => text(b).split(' ').pop() === label)?.getAttribute('aria-checked') === 'true'
    const modelBtn = p.querySelector('button[aria-label="Select model family"]')
    return {
      modelBtn,
      state: {
        image: on('Image'),
        ratio: on(ratio),
        x1: on('x1'),
        model: text(modelBtn).replace(/arrow_drop_down/, '').replace(/^\S+\s/, '').trim(),
      },
      credits: Number((/Generating will use\s*(\d+)\s*credits?/i.exec(text(p)) ?? [])[1]),
    }
  }
  const ready = (st) => st.image && st.ratio && st.x1 && st.model === model

  let cur = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (!pane()) {
      realClick(await waitFor(SEL.settingsTrigger, { label: 'ปุ่มตั้งค่าโมเดล' }))
      await waitFor(pane, { label: 'หน้าตั้งค่าโมเดล' })
      await sleep(400)
    }
    cur = readPane()
    if (cur && ready(cur.state)) break
    for (const label of ['Image', ratio]) {
      const btn = $$('button[role="radio"]', pane() ?? document).find((b) => text(b).split(' ').pop() === label)
      if (btn && btn.getAttribute('aria-checked') !== 'true') {
        realClick(btn)
        await sleep(600) // Image/Video สลับแล้วแผงวาดตัวเลือกโมเดลใหม่
      }
    }
    cur = readPane()
    if (cur?.modelBtn && cur.state.model !== model) {
      realClick(cur.modelBtn)
      const item = await waitFor(() => $$('[role="menuitem"]').find((m) => visible(m) && text(m).replace(/^\S+\s/, '') === model), {
        timeout: 5000,
        label: `เมนูโมเดล ${model}`,
      }).catch(() => null)
      if (item) realClick(item)
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await sleep(700)
    }
    const x1 = $$('button[role="radio"]', pane() ?? document).find((b) => text(b).split(' ').pop() === 'x1')
    if (x1 && x1.getAttribute('aria-checked') !== 'true') {
      realClick(x1)
      await sleep(500)
    }
    cur = readPane()
    if (cur && ready(cur.state)) break
    if (attempt === 4) {
      const st = cur?.state ?? {}
      throw new Error(`ตั้งโมเดลในช่องพิมพ์ของ Flow ไม่สำเร็จ (ตอนนี้: ${st.image ? 'Image' : 'ไม่ใช่ Image'} · ${st.model || '?'} · ${st.x1 ? 'x1' : 'ไม่ใช่ x1'})`)
    }
  }
  await sleep(500)
  const credits = readPane()?.credits
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  document.querySelector('.cdk-overlay-backdrop')?.click()
  await sleep(400)
  return credits
}

/** รอจน DOM ของ element หยุดเปลี่ยน — แผง Agent settings โหลดค่าที่บันทึกไว้จาก server แล้ววาดใหม่หลังเปิดไม่กี่ร้อยมิลลิวินาที */
async function waitSettled(getRoot, { quietMs = 1200, timeout = 15_000 } = {}) {
  const deadline = Date.now() + timeout
  let last = ''
  let since = Date.now()
  while (Date.now() < deadline) {
    const root = getRoot()
    const snapshot = root ? root.innerHTML.length + '|' + $$('[aria-checked="true"], input:checked', root).length + '|' + text(root) : ''
    if (snapshot !== last) {
      last = snapshot
      since = Date.now()
    } else if (root && Date.now() - since >= quietMs) return root
    await sleep(200)
  }
  return getRoot()
}

async function configureAgent(model, { dryRun, ratio = "16:9" }) {
  await setAgent(true)
  const openPanel = () => (visible(SEL.agentPanel()) && /Image generation default/.test(text(SEL.agentPanel())) ? SEL.agentPanel() : null)
  if (!openPanel()) realClick(await waitFor(SEL.agentSettings, { label: 'ปุ่ม Settings ของ Agent' }))
  await waitFor(openPanel, { label: 'Agent settings' })
  await waitSettled(openPanel)

  // ทุกครั้งต้อง query ใหม่ — แผงวาดใหม่แล้ว element เดิมหลุดจากหน้า คลิกไปก็ไม่มีผล
  const read = () => {
    const panel = openPanel()
    if (!panel) return null
    const labels = $$('.settings-section-label', panel)
    const imageLabel = labels.find((l) => /Image generation default/.test(text(l)))
    const videoLabel = labels.find((l) => /Video generation default/.test(text(l)))
    const inImage = (el) =>
      imageLabel && imageLabel.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING &&
      (!videoLabel || videoLabel.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)
    const imageButtons = $$('button[role="radio"]', panel).filter(inImage)
    const never = $$('mat-radio-button', panel).find((r) => /^Never/.test(text(r)))
    const modelBtn = panel.querySelector('button[aria-label="Image generation default model"]')
    const checked = (re) => text(imageButtons.find((b) => b.getAttribute('aria-checked') === 'true' && re.test(text(b)))).split(' ').pop()
    return {
      panel,
      imageButtons,
      neverInput: never?.querySelector('input[type="radio"]'),
      modelBtn,
      state: {
        confirm: never?.querySelector('input')?.checked ? 'Never' : 'Always',
        ratio: checked(/:/),
        count: checked(/(^|\s)x\d$/),
        model: text(modelBtn).replace(/arrow_drop_down/, '').replace(/^\S+\s/, '').trim(),
      },
    }
  }
  const ok = (st) => st.confirm === 'Never' && st.ratio === ratio && st.count === 'x1' && st.model === model

  for (let attempt = 1; attempt <= 4; attempt++) {
    let cur = read()
    if (!cur) throw new Error('แผง Agent settings ปิดไปเอง')
    if (ok(cur.state)) break

    // Confirm before generating = Never → agent สร้างภาพต่อเนื่องเองโดยไม่ต้องรอกดยืนยันทีละชุด
    if (cur.state.confirm !== 'Never' && cur.neverInput) {
      realClick(cur.neverInput)
      await sleep(400)
    }
    for (const label of [ratio, 'x1']) {
      cur = read()
      const btn = cur?.imageButtons.find((b) => text(b).split(' ').pop() === label)
      if (!btn) throw new Error(`ไม่พบตัวเลือก ${label} ใน Agent settings`)
      if (btn.getAttribute('aria-checked') !== 'true') {
        realClick(btn)
        await sleep(400)
      }
    }
    cur = read()
    if (cur && cur.state.model !== model) {
      realClick(cur.modelBtn)
      const item = await waitFor(() => $$('[role="menuitem"]').find((m) => visible(m) && text(m).replace(/^\S+\s/, '') === model), {
        timeout: 5000,
        label: `เมนูโมเดล ${model}`,
      }).catch(() => null)
      if (item) realClick(item)
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) // เมนูไม่เปิด/ถูกวาดทับ → ปิดแล้วลองรอบใหม่
      await sleep(700)
    }
    await waitSettled(openPanel, { quietMs: 600, timeout: 5000 })
    if (attempt === 4 && !ok(read()?.state ?? {})) {
      const st = read()?.state ?? {}
      throw new Error(`ตั้ง Agent settings ไม่สำเร็จ (ตอนนี้: ${st.confirm} · ${st.ratio} · ${st.count} · ${st.model}) — ตั้งเองในแผง Agent settings เป็น Never · ${ratio} · x1 · ${model} แล้วกด Save แล้วสั่งใหม่`)
    }
  }

  const final = read()
  const summary = final.state
  if (dryRun) {
    realClick(final.panel.querySelector('button[aria-label="Back"]'))
  } else {
    realClick(await waitFor(() => $$('button', openPanel() ?? document).find((b) => text(b) === 'Save'), { label: 'ปุ่ม Save' }))
    await waitFor(() => !openPanel(), { timeout: 10_000, label: 'บันทึก Agent settings' })
  }
  await sleep(800)
  return summary
}

/** แนบรูปตัวละครเป็น ingredient ของ agent (วางด้วย paste เหมือน Ctrl+V) */
async function attachImages(editor, attachments) {
  if (!attachments?.length) return
  const chips = () => document.querySelectorAll('flow-ingredient-chip').length
  const before = chips()
  const dt = new DataTransfer()
  for (const a of attachments) dt.items.add(new File([Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0))], a.name, { type: a.type }))
  editor.focus()
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  await waitFor(() => chips() >= before + attachments.length && !document.querySelector('flow-ingredient-chip mat-progress-spinner, flow-ingredient-chip [role="progressbar"]'), {
    timeout: 60_000,
    interval: 500,
    label: 'Flow อัปโหลดรูปตัวละคร',
  })
  await sleep(1000)
}

async function sendPrompt(prompt, attachments) {
  await attachImages(await waitFor(SEL.editor, { label: 'ช่องพิมพ์' }), attachments)
  // แนบรูปแล้ว Flow วาดช่องพิมพ์ใหม่ (element เดิมหลุดจากหน้า — ตรวจกับหน้าจริงแล้ว) → ต้องหาช่องพิมพ์ใหม่ทุกครั้ง
  const pasteText = async () => {
    const editor = await waitFor(SEL.editor, { label: 'ช่องพิมพ์' })
    editor.focus()
    const data = new DataTransfer()
    data.setData('text/plain', prompt)
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    await sleep(500)
    if (!text(SEL.editor())) {
      SEL.editor()?.focus()
      document.execCommand('insertText', false, prompt)
      await sleep(400)
    }
    return !!text(SEL.editor())
  }
  let pasted = false
  for (let attempt = 0; attempt < 3 && !pasted; attempt++) {
    pasted = await pasteText()
    if (!pasted) await sleep(1500)
  }
  if (!pasted) throw new Error('วาง prompt ลงช่องพิมพ์ของ Flow ไม่ได้')
  const send = await waitFor(() => (SEL.send() && !SEL.send().disabled ? SEL.send() : null), { label: 'ปุ่มส่ง' })
  realClick(send)
  await waitFor(() => agentBusy() || !text(SEL.editor()), { timeout: 15_000, label: 'Flow รับ prompt' })
}

const agentBusy = () => !!$$('button[aria-label="Stop"]').find(visible)

// ── ภาพใน project ──
// grid เป็น virtual scroll (แสดงเฉพาะที่อยู่บนจอ) → จำภาพทุกใบที่เคยโผล่ด้วย MutationObserver
// ชื่อภาพ = aria-label ของ tile ซึ่ง agent เปลี่ยนเป็น "00_00_00.png SHOT 01" ได้ตามที่สั่ง
const tiles = new Map() // mediaId → { name, src }

function collectTiles() {
  for (const tile of $$('flow-grid-tile-container')) {
    const img = tile.querySelector('img[data-media-id]')
    if (!img) continue
    const id = img.dataset.mediaId
    tiles.set(id, { name: tile.getAttribute('aria-label') ?? '', src: img.currentSrc || img.src || tiles.get(id)?.src })
  }
  return tiles
}
new MutationObserver(() => collectTiles()).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'src'] })

/** เลื่อน grid จนสุดเพื่อให้ tile ทุกใบถูก render อย่างน้อยครั้งหนึ่ง แล้วกลับขึ้นบน */
/** กล่องที่เลื่อนได้จริงของ grid — ไม่ใช่ cdk-virtual-scroll-viewport (สูงเท่าเนื้อหา) แต่เป็น .cdk-virtual-scrollable ที่ครอบอยู่ */
function gridScroller() {
  const viewport = document.querySelector('cdk-virtual-scroll-viewport')
  if (!viewport) return null
  for (let el = viewport; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if (/(auto|scroll)/.test(overflowY) && el.scrollHeight > el.clientHeight + 10) return el
  }
  return viewport.closest('.cdk-virtual-scrollable') ?? viewport
}

async function scanAllTiles() {
  collectTiles()
  // วิธีหลัก: ย่อหน้าจอชั่วคราว → virtual scroll วาด tile ทุกใบพร้อมกัน (ทดสอบกับ project 366 ภาพแล้ว)
  // เลื่อนทีละช่วงช้ามากเมื่อแท็บอยู่เบื้องหลัง เพราะ Chrome ชะลอ timer/การวาดของแท็บที่มองไม่เห็น
  const html = document.documentElement
  const oldZoom = html.style.zoom
  html.style.zoom = '0.06'
  window.dispatchEvent(new Event('resize'))
  let last = -1
  for (let i = 0; i < 20; i++) {
    await sleep(700)
    collectTiles()
    const loaded = $$('flow-grid-tile-container img[data-media-id]').length
    if (loaded === last && i >= 3) break
    last = loaded
  }
  html.style.zoom = oldZoom
  window.dispatchEvent(new Event('resize'))
  await sleep(500)

  // สำรอง: เลื่อนทีละช่วง เผื่อบาง tile ยังไม่ถูกวาด
  const scroller = gridScroller()
  if (!scroller) return tiles
  scroller.scrollTop = 0
  await sleep(500)
  for (let guard = 0; guard < 600; guard++) {
    collectTiles()
    const before = scroller.scrollTop
    scroller.scrollTop += Math.max(200, scroller.clientHeight * 0.7)
    await sleep(450) // ให้ virtual scroll วาด tile แถวใหม่ + โหลด src
    if (scroller.scrollTop === before) break
  }
  collectTiles()
  scroller.scrollTop = 0
  return tiles
}

// ชื่อภาพที่เก็บกลับ: timecode ของช็อต หรือ cover.png (ภาพปกคลิป)
const TIMECODE_NAME = /(\d{2}_\d{2}_\d{2}(?:_\d)?\.png|cover\.png)/i

/** ภาพจาก flow-content.google เป็น JPEG → แปลงเป็น PNG ให้ตรงกับชื่อไฟล์ตาม Blueprint กฎ 4 */
async function imageAsPngBase64(src) {
  const blob = await fetch(src).then((r) => {
    if (!r.ok) throw new Error(`โหลดภาพไม่ได้ (${r.status})`)
    return r.blob()
  })
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext('2d').drawImage(bitmap, 0, 0)
  const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
  let binary = ''
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000))
  return { base64: btoa(binary), width: bitmap.width, height: bitmap.height }
}

let running = false
// ── งานจากโปรแกรมในเครื่อง (pipeline/5_images.mjs ผ่าน bridge) — ทำครบทั้งเส้นในแท็บนี้ ──

/** ส่งถึง bridge ผ่าน service worker — ลองใหม่ถ้า worker กำลังถูกปลุก; RESULT/PARTIAL ต้องได้ ok จริง */
async function toBridge(type, body, { tries = 6 } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type, body })
      if (res?.ok || type === 'PROGRESS') return res
      last = res?.error ?? 'bridge ไม่รับ'
    } catch (err) {
      last = String(err?.message ?? err)
    }
    await sleep(1500 * (i + 1))
  }
  throw new Error(`ส่งภาพกลับโปรแกรมในเครื่องไม่สำเร็จ: ${last}`)
}
const PNG_BATCH = 4 // ส่งกลับทีละ 4 ใบ กัน payload ใหญ่เกิน
const RETRY_BATCH = 10 // สั่งซ้ำทีละไม่เกิน 10 ช็อต — ชุดใหญ่ทำให้ "The agent failed" บ่อย
const SAFE_AFTER = 2 // ช็อตที่ล้มเหลวครบกี่ครั้งแล้วให้ agent เขียนภาพใหม่ให้ปลอดภัยขึ้น
const MAX_STALLS = 3 // รอบติดกันที่ไม่ได้ภาพเพิ่มเลย → เลิก (autopilot จะเปิด project ใหม่สั่งต่อเอง)
const IDLE_MS = 75_000 // agent หยุดนิ่งนานเท่านี้ = จบรอบ (ระหว่างภาพปุ่ม Stop อาจหายแวบๆ)
const ROUND_MAX_MS = 45 * 60_000

const shotLine = (s) => (s.prompt ? `${s.filename} ${s.prompt}` : `${s.filename} SHOT`)

function renameInstruction(shots) {
  const first = shots.find((s) => s.prompt) ?? shots[0]
  const example = first.prompt ? `${first.filename} ${first.prompt}` : `${first.filename} SHOT 01`
  return `เปลี่ยนชื่อ แต่ละ shot ให้ตรงตาม prompt ที่ส่งให้ เช่น

${example}

ก็แก้ชื่อเป็น ${first.filename} ${(/SHOT\s*\d+/i.exec(first.prompt ?? '') ?? ['SHOT 01'])[0]}

ห้ามสร้างภาพใหม่ แค่เปลี่ยนชื่อภาพที่มีอยู่ให้ครบทุกภาพ ใช้ชื่อไฟล์ตาม shot list เป๊ะๆ`
}

/** agent หยุดกลางทาง (high demand / agent failed / ทำไม่ครบ) → สั่งต่อเฉพาะช็อตที่ขาด ใน project เดิม ตัวละครจึงยังเหมือนเดิม */
function continueInstruction(batch, { remaining, safer }) {
  const naming = `ตั้งชื่อแต่ละภาพเป็นชื่อไฟล์ตามหน้าบรรทัดเป๊ะๆ เช่น "${batch[0].filename} SHOT" (ชื่อภาพเท่านั้น ห้ามเขียนชื่อไฟล์ เลข SHOT หรือ @TAG ลงในภาพ)`
  if (safer) {
    return `ช็อตต่อไปนี้สร้างไม่สำเร็จหลายครั้งแล้ว (Failed) — น่าจะติดตัวกรองเนื้อหา
ปรับภาพให้ปลอดภัยขึ้นแต่ยังเล่าเรื่องเดิม: ไม่มีเลือด บาดแผล อาวุธกระทบร่างกาย การทำร้าย หรือหน้าน่ากลัวแบบสมจริง
ใช้วิธีเล่าอ้อม เช่น เงา สัญลักษณ์ มุมกล้องไกล หรือท่าทางตกใจแบบการ์ตูน · Style Bible และ Character Bible เดิมทุกอย่าง (lock ตัวละคร)
${naming}

${batch.map(shotLine).join('\n\n')}`
  }
  return `ยังขาดภาพอีก ${remaining} ช็อต — รอบนี้สร้าง ${batch.length} ช็อตนี้ก่อน ใช้ Style Bible และ Character Bible เดิมทุกอย่าง (lock ตัวละครเหมือนภาพที่ทำไปแล้ว)
${naming}

${batch.map(shotLine).join('\n\n')}`
}

/** ภาพที่ Flow สร้างไม่สำเร็จ ("Sorry, this image failed to generate") + agent ล้มเหลวทั้งรอบ ("The agent failed") */
function failureCounts() {
  // grid เป็น virtual scroll → นับได้เฉพาะใบที่วาดอยู่ ใช้บอกสาเหตุใน log ไม่ได้ใช้ตัดสินใจ
  const imageFailed =
    $$('flow-error-tile').filter((el) => !el.closest('flow-agent-panel')).length +
    $$('flow-grid-tile-container').filter((t) => !t.querySelector('flow-error-tile') && /failed to generate/i.test(t.innerText ?? '')).length
  const agentFailed = (SEL.agentPanel()?.innerText.match(/The agent failed/gi) ?? []).length
  return { imageFailed, agentFailed }
}

/** รอ agent ทำงานจนนิ่ง — คืนจำนวนภาพใหม่ของรอบนี้ */
async function waitAgentIdle(job, { before, expected, stage }) {
  const started = Date.now()
  let last = -1
  let idleSince = null
  for (;;) {
    await sleep(5000)
    const made = collectTiles().size - before
    if (made !== last) {
      last = made
      await toBridge('PROGRESS', { id: job.id, progress: { done: made, total: expected, stage } })
    } else {
      await toBridge('PROGRESS', { id: job.id }) // heartbeat
    }
    if (agentBusy()) {
      idleSince = null
    } else {
      idleSince ??= Date.now()
      if (Date.now() - idleSince > IDLE_MS) return made
    }
    if (Date.now() - started > ROUND_MAX_MS) return made
  }
}

/** ภาพที่ตั้งชื่อ timecode แล้ว — grid เรียงใหม่สุดก่อน ชื่อซ้ำจึงได้ใบล่าสุด */
function namedPicks(wanted) {
  const picks = new Map()
  for (const t of tiles.values()) {
    const filename = TIMECODE_NAME.exec(t.name)?.[1]
    if (filename && wanted.has(filename) && !picks.has(filename) && t.src) picks.set(filename, t.src)
  }
  return picks
}

/**
 * ตั้งชื่อ project ใน Flow เป็นชื่อเรื่อง — ชื่อเริ่มต้นของ Flow เป็นวันที่ ("Sep 17 - 18:54") หาในรายการ project ยาก
 * ช่องชื่ออยู่หัวหน้า project: input.editable-text-input (aria-label "Editable text") ตรวจกับหน้าเว็บจริงแล้ว (ก.ย. 2026)
 * ตั้งไม่สำเร็จไม่ถือว่างานพัง — แค่ชื่อไม่เปลี่ยน
 */
async function renameProject(title) {
  const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 100)
  if (!name) return
  const input = await waitFor(() => $$('input.editable-text-input, input[aria-label="Editable text"]').find(visible), { timeout: 15_000, label: 'ช่องชื่อ project' }).catch(() => null)
  if (!input || input.value === name) return
  input.focus()
  input.select()
  // Angular อ่านค่าจาก event — ตั้งค่าผ่าน setter ของ input จริง แล้วยิง input/change ให้ครบ
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, name)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  for (const type of ['keydown', 'keyup']) input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  input.blur()
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  await sleep(1500)
  if (!document.title.includes(name.slice(0, 20)) && input.value !== name) console.warn('[cartoon-auto] ตั้งชื่อ project ใน Flow ไม่สำเร็จ')
}

async function runImageJob(job) {
  const { prompt, shots, model = 'Nano Banana 2 Lite', aspect = '16:9', attachments = [], projectTitle } = job.payload
  const expected = shots.length
  const wanted = new Set(shots.map((s) => s.filename))
  await openProject()
  await renameProject(projectTitle).catch(() => {})
  await toBridge('PROGRESS', { id: job.id, progress: { done: 0, total: expected, stage: 'project', projectUrl: location.href.split('?')[0] } })
  const credits = await verifyFreeSettings(model, aspect)
  if (credits !== 0) throw new Error(`ชุด ${model} · x1 ใช้ ${Number.isFinite(credits) ? credits : '?'} credits ไม่ใช่ 0 — หยุดไว้ก่อน ไม่ได้สั่ง agent`)
  await configureAgent(model, { dryRun: false, ratio: aspect })
  await scanAllTiles() // project เดิมมีภาพอยู่แล้ว → นับของเดิมไว้ก่อน ภาพใหม่จะได้นับถูก
  const before = collectTiles().size

  const saved = new Set()
  // เซฟภาพที่ได้ทุกรอบทันที (PARTIAL) — ถ้ารอบหลังพัง ภาพที่ได้แล้วไม่หาย
  async function saveNew(picks) {
    const entries = [...picks].filter(([name]) => !saved.has(name))
    for (let i = 0; i < entries.length; i += PNG_BATCH) {
      const files = []
      for (const [name, src] of entries.slice(i, i + PNG_BATCH)) {
        try {
          files.push({ name, base64: (await imageAsPngBase64(src)).base64 })
        } catch {} // src หมดอายุ → รอบหน้าสแกนใหม่ได้ src ใหม่
      }
      if (!files.length) continue
      await toBridge('PARTIAL', { id: job.id, files })
      for (const f of files) saved.add(f.name)
      await toBridge('PROGRESS', { id: job.id, progress: { done: saved.size, total: expected, stage: 'save' } })
    }
  }

  await sendPrompt(prompt, attachments)
  let stalls = 0
  const tries = new Map(shots.map((s) => [s.filename, 1])) // จำนวนครั้งที่สั่งแต่ละช็อตไปแล้ว
  const failuresAtStart = failureCounts()
  for (let round = 1; ; round++) {
    const beforeRound = collectTiles().size
    await waitAgentIdle(job, { before, expected, stage: 'generate' })
    const newThisRound = collectTiles().size - beforeRound
    await scanAllTiles()
    let picks = namedPicks(wanted)

    // มีภาพใหม่ที่ยังไม่ได้ตั้งชื่อ timecode → ให้ agent ตั้งชื่อก่อน
    const unnamed = collectTiles().size - before - picks.size
    if (unnamed > 0 && picks.size < expected) {
      await toBridge('PROGRESS', { id: job.id, progress: { done: picks.size, total: expected, stage: 'rename' } })
      await sendPrompt(renameInstruction(shots.filter((s) => !picks.has(s.filename))))
      await sleep(3000)
      await waitAgentIdle(job, { before, expected, stage: 'rename' })
      await scanAllTiles()
      picks = namedPicks(wanted)
    }
    await saveNew(picks)

    const missing = shots.filter((s) => !saved.has(s.filename))
    if (!missing.length) break
    const failures = failureCounts()
    const failed = {
      images: failures.imageFailed - failuresAtStart.imageFailed,
      agent: failures.agentFailed - failuresAtStart.agentFailed,
    }
    await toBridge('PROGRESS', { id: job.id, progress: { done: saved.size, total: expected, stage: 'retry', failed } })
    stalls = newThisRound > 0 ? 0 : stalls + 1
    if (stalls >= MAX_STALLS) break

    // ช็อตที่ขาด: ตัวที่ลองน้อยครั้งก่อน · ลองครบ SAFE_AFTER แล้วยังไม่ได้ → ขอแบบปลอดภัยขึ้นแยกชุด
    const safer = missing.filter((s) => tries.get(s.filename) >= SAFE_AFTER)
    const normal = missing.filter((s) => tries.get(s.filename) < SAFE_AFTER)
    const useSafer = safer.length && (!normal.length || round % 2 === 0)
    const batch = (useSafer ? safer : normal).slice(0, RETRY_BATCH)
    // ช็อตที่ขอแบบปลอดภัยไปแล้วหลายรอบก็ยังไม่ได้ → เลิกขอ ให้ภาพข้างเคียงค้างแทน
    if (useSafer && batch.every((s) => tries.get(s.filename) >= SAFE_AFTER + 2)) break
    for (const s of batch) tries.set(s.filename, tries.get(s.filename) + 1)
    if (agentBusy()) await waitFor(() => !agentBusy(), { timeout: 10 * 60_000, interval: 2000, label: 'Agent ว่าง' })
    await sendPrompt(continueInstruction(batch, { remaining: missing.length, safer: useSafer }))
  }

  if (!saved.size) throw new Error('Agent ไม่ได้สร้างภาพที่ตั้งชื่อเป็น timecode เลย — ดูในแท็บ Flow')
  await toBridge('RESULT', { id: job.id, files: [], meta: { generated: collectTiles().size - before, expected, named: saved.size } })
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // หน้าตรวจความพร้อม: เห็นปุ่ม New project หรืออยู่ใน project = ล็อกอินแล้ว · เห็นปุ่ม Sign in = ยัง
  if (msg.type === 'PING') {
    const signIn = $$('a, button').some((el) => visible(el) && /^\s*sign in\s*$|เข้าสู่ระบบ/i.test(text(el)))
    const inside = /\/project\//.test(location.pathname) || !!SEL.newProject()
    sendResponse({ ok: true, loggedIn: signIn ? false : inside ? true : null, url: location.href, running })
    return
  }
  if (msg.type === 'RUN_JOB' && msg.job?.kind === 'generate-images') {
    if (running) {
      sendResponse({ ok: false, error: 'กำลังส่งงานให้ Flow อยู่แล้ว' })
      return
    }
    running = true
    // ผลและ error ส่งผ่าน toBridge เอง — service worker อาจถูกปิดระหว่างงาน 30 นาที ทำให้ sendResponse หาย
    runImageJob(msg.job)
      .then(() => sendResponse({ ok: true }))
      .catch(async (err) => {
        const message = `[extension ${VERSION}] ${err.message}`
        await toBridge('ERROR', { id: msg.job.id, message }).catch(() => {})
        sendResponse({ ok: true, reported: true })
      })
      .finally(() => (running = false))
    return true
  }

  const reply = (fn) => {
    ;(async () => {
      try {
        sendResponse({ ok: true, ...(await fn()) })
      } catch (err) {
        sendResponse({ ok: false, error: `[extension ${VERSION}] ${err.message}` })
      }
    })()
    return true
  }

  if (msg.type === 'FLOW_AGENT_STATUS') {
    collectTiles()
    sendResponse({ ok: true, running, images: tiles.size, busy: agentBusy(), url: location.href })
    return
  }

  // สั่ง agent เปลี่ยนชื่อภาพตาม shot list แล้วรอจน agent ทำเสร็จ
  if (msg.type === 'FLOW_AGENT_RENAME') {
    return reply(async () => {
      if (agentBusy()) throw new Error('Flow Agent ยังทำงานอยู่ — รอให้สร้างภาพเสร็จก่อน')
      await sendPrompt(msg.prompt)
      await sleep(3000)
      await waitFor(() => !agentBusy(), { timeout: 20 * 60_000, interval: 2000, label: 'Agent เปลี่ยนชื่อภาพ' })
      await sleep(1500)
      await scanAllTiles()
      return { names: [...tiles.values()].map((t) => t.name) }
    })
  }

  // รายการภาพทั้งหมดใน project + ชื่อ timecode ที่อ่านได้
  if (msg.type === 'FLOW_AGENT_LIST') {
    return reply(async () => {
      await scanAllTiles()
      return {
        images: [...tiles.entries()].map(([id, t]) => ({ id, name: t.name, filename: TIMECODE_NAME.exec(t.name)?.[1] ?? null })),
      }
    })
  }

  if (msg.type === 'FLOW_AGENT_IMAGE') {
    return reply(async () => {
      const tile = tiles.get(msg.id)
      if (!tile?.src) throw new Error('ไม่พบภาพนี้ในหน้า Flow')
      return imageAsPngBase64(tile.src)
    })
  }

  if (msg.type !== 'FLOW_AGENT_RUN') return
  if (running) {
    sendResponse({ ok: false, error: 'กำลังส่งงานให้ Flow อยู่แล้ว' })
    return
  }
  running = true
  ;(async () => {
    const model = msg.model ?? 'Nano Banana 2 Lite'
    const aspect = msg.aspect ?? '16:9'
    try {
      await openProject()
      const credits = await verifyFreeSettings(model, aspect)
      if (credits !== 0) {
        throw new Error(`ชุด ${model} · x1 ใช้ ${Number.isFinite(credits) ? credits : '?'} credits ไม่ใช่ 0 — หยุดไว้ก่อน ไม่ได้สั่ง agent`)
      }
      const agent = await configureAgent(model, { dryRun: !!msg.dryRun, ratio: aspect })
      const imagesBefore = collectTiles().size
      if (!msg.dryRun) await sendPrompt(msg.prompt, msg.attachments)
      sendResponse({ ok: true, credits, agent, imagesBefore, projectUrl: location.href })
    } catch (err) {
      sendResponse({ ok: false, error: `[extension ${VERSION}] ${err.message}` })
    } finally {
      running = false
    }
  })()
  return true
})
})()
