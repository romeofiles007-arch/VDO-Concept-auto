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
 *   4. วาง prompt (Style Bible + Character Bible + Shot List) แล้วกด Enter
 *
 * ข้อความที่แผงข้างส่งมา:
 *   FLOW_AGENT_RUN  { prompt, expected, model, dryRun }  → { ok, credits, projectUrl }
 *   FLOW_AGENT_STATUS                                    → { ok, images, busy }
 *   FLOW_AGENT_RENAME { prompt }                         → { ok, names }   สั่ง agent ตั้งชื่อ "00_00_00.png SHOT 01"
 *   FLOW_AGENT_LIST                                      → { ok, images: [{ id, name, filename }] }
 *   FLOW_AGENT_IMAGE  { id }                             → { ok, base64 (PNG), width, height }
 */
const VERSION = chrome.runtime.getManifest().version
// flow-text.js โหลดก่อนไฟล์นี้ (manifest + CONTENT_FILES ใน background.js) — เทียบชื่อรุ่นไม่สนภาษา · ปิดเมนู · ตรวจหน้าที่ถูกแปล
const { sameModel, labelText, pageTranslated, TRANSLATED_HINT, escapeMenus, strayMenu } = globalThis.CartoonFlowText
/** กล่องข้อความของ Flow ที่ค้างคาหน้าอยู่ (เช่นประกาศรุ่นใหม่) — บอกผู้ใช้ให้ปิดเอง ไม่กดปุ่มในกล่องแทนผู้ใช้ */
const blockingDialog = () => $$('mat-dialog-container').filter(visible).map((d) => text(d).slice(0, 60))[0] ?? ''
/** ข้อความ error ที่ส่งกลับ — หน้าถูก Chrome แปลอยู่ให้บอกสาเหตุนี้ก่อน เพราะเป็นต้นเหตุที่ทำให้หาปุ่มไม่เจอ */
const errorText = (err) => {
  const dialog = blockingDialog()
  return `[extension ${VERSION}] ${pageTranslated() ? `${TRANSLATED_HINT} · ` : ''}${err.message}` +
    (dialog ? ` · มีกล่องข้อความของ Flow ค้างอยู่บนหน้า ("${dialog}") ปิดกล่องนั้นก่อนแล้วสั่งใหม่` : '')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FLOW_PROMPT_GAP_MS = 2 * 60_000 // เว้นอย่างน้อย 2 นาทีระหว่างคำสั่งที่ส่งให้ Flow
const FLOW_LAST_PROMPT_KEY = 'flowLastPromptAt'

async function waitBeforeNextPrompt() {
  // เก็บเวลาใน storage.local เพื่อคงระยะห่างแม้ Flow โหลดหน้าใหม่หรือ service worker เริ่มใหม่
  const saved = await chrome.storage.local.get(FLOW_LAST_PROMPT_KEY)
  const last = Number(saved[FLOW_LAST_PROMPT_KEY]) || 0
  const remaining = Math.min(FLOW_PROMPT_GAP_MS, Math.max(0, last + FLOW_PROMPT_GAP_MS - Date.now()))
  if (remaining) await sleep(remaining)
}

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

/**
 * ส่ง prompt ผ่านอินพุตจริงของเบราว์เซอร์ (debugger) หลังตรวจว่าข้อความพร้อมแล้ว
 *   click = false → กด Enter ในช่องพิมพ์ · click = true → กดปุ่มลูกศรส่ง (ทางสำรองเมื่อ Enter ไม่ติด)
 */
async function trustedSend(editor, prompt, { click = false } = {}) {
  editor.scrollIntoView({ block: 'center' })
  editor.focus()
  await sleep(150)
  if (document.activeElement !== editor) throw new Error('โฟกัสช่อง prompt ของ Flow ไม่ได้')
  if (text(editor) !== String(prompt).replace(/\s+/g, ' ').trim()) throw new Error('ข้อความในช่อง prompt เปลี่ยนก่อนกดส่ง — ยังไม่ได้ส่ง')
  const result = await chrome.runtime.sendMessage({ type: 'FLOW_TRUSTED_ENTER', click, labels: L.send })
  if (!result?.ok) throw new Error(`${click ? 'กดปุ่มส่ง' : 'กด Enter เพื่อส่ง'} prompt ไม่สำเร็จ: ${result?.error ?? 'ไม่มีคำตอบจาก service worker'}`)
}

/** สภาพช่องพิมพ์ตอนส่งไม่ติด — ใส่ใน error ไว้ดูว่าหน้า Flow ค้างที่อะไร (รอบหน้าหน้าเปลี่ยนจะได้แก้ตรงจุด) */
function sendDiagnosis() {
  const editor = SEL.editor()
  const send = SEL.send()
  const parts = [
    `ช่องพิมพ์ ${text(editor).length} ตัวอักษร`,
    send ? `ปุ่มส่ง${send.disabled ? 'กดไม่ได้' : 'กดได้'}` : 'ไม่เห็นปุ่มส่ง',
    `โหมด Agent ${agentOn() ? 'เปิด' : 'ปิด'}`,
    document.activeElement === editor ? 'โฟกัสอยู่ที่ช่องพิมพ์' : `โฟกัสอยู่ที่ ${document.activeElement?.tagName?.toLowerCase() ?? '-'}`,
    document.hasFocus() ? '' : 'หน้าต่าง Chrome ไม่ได้อยู่ด้านหน้า',
    pageAlerts(),
  ]
  return parts.filter(Boolean).join(' · ').slice(0, 300)
}

const text = (el) => (el?.innerText ?? '').replace(/\s+/g, ' ').trim()
const visible = (el) => !!el && el.getBoundingClientRect().width > 0
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

/**
 * ข้อความบนหน้า Flow ทั้งภาษาอังกฤษและไทย — บัญชีที่ตั้งภาษาไทย Flow จะเป็นภาษาไทยทั้งหน้า
 * (background เปิดด้วย ?hl=en อยู่แล้ว ชุดภาษาไทยเป็นตัวสำรองเมื่อหน้าเปลี่ยนภาษาเอง) — คำไทยตรวจกับหน้าจริงแล้ว (ก.ย. 2026)
 */
const L = {
  newProject: /new project|โปรเจ็กต์ใหม่/i,
  settingsTrigger: ['Settings trigger', 'ทริกเกอร์การตั้งค่า'],
  // 19 พ.ย. 2026 Flow เปลี่ยนชื่อปุ่มเฟืองในช่องพิมพ์เป็น "Agent settings / การตั้งค่า Agent" (ชื่อเดิมไว้เผื่อหน้าเก่า)
  agentSettings: ['Agent settings', 'การตั้งค่า Agent', 'Settings', 'การตั้งค่า'],
  send: ['Start generation', 'เริ่มสร้าง'],
  close: ['Close', 'ปิด'],
  back: ['Back', 'กลับ'],
  stop: ['Stop', 'หยุด', 'หยุดสร้าง'],
  save: ['Save', 'บันทึก'],
  image: ['Image', 'รูปภาพ'],
  modelFamily: ['Select model family', 'เลือกกลุ่มผลิตภัณฑ์โมเดล'],
  editableText: ['Editable text', 'ข้อความที่แก้ไขได้'],
  creditsPane: /Generating will use|การสร้างจะใช้/i,
  credits: /(?:Generating will use|การสร้างจะใช้)\s*(\d+)\s*(?:credits?|เครดิต)/i,
  // พ.ย. 2026 ข้อความสั้นลงเป็น "ค่าเริ่มต้นของรูปภาพ / Image defaults" (ของเดิมไว้เผื่อหน้าเก่า)
  // Flow ตอบกลับว่ารับงานไม่ได้ — การ์ดคำตอบขึ้น "เกิดข้อผิดพลาด โปรดลองอีกครั้ง" พร้อมปุ่มลองอีกครั้ง
  agentFailed: /Something went wrong|เกิดข้อผิดพลาด/i,
  tryAgain: /Try again|ลองอีกครั้ง/i,
  // Flow กันบอต: "We noticed some unusual activity… browser extensions that modify the page may cause issues"
  unusualActivity: /unusual activity|กิจกรรมที่ผิดปกติ|การใช้งานที่ผิดปกติ|ผิดปกติ/i,
  imageDefault: /Image (generation )?default|ค่าเริ่มต้น(สำหรับการสร้าง|ของ)รูปภาพ/,
  videoDefault: /Video (generation )?default|ค่าเริ่มต้น(ของการสร้าง|ของ)วิดีโอ/,
  never: /^(Never|ไม่เลย)/,
  failedTile: /failed to generate|Something went wrong|สร้างไม่สำเร็จ|สร้างไม่ได้|เกิดข้อผิดพลาด/i,
  highDemand: /experiencing high demand|มีผู้ใช้งานจำนวนมาก|มีความต้องการสูง/gi,
}
/** ปุ่มที่ aria-label ตรงกับคำใดคำหนึ่งในรายการ (อังกฤษ/ไทย) */
const byAria = (labels, root = document, tag = 'button') => $$(tag, root).filter((b) => labels.includes(b.getAttribute('aria-label')))
/** ข้อความท้ายปุ่มตรงกับคำใดคำหนึ่ง เช่น "image รูปภาพ" → "รูปภาพ" */
const lastWordIs = (el, labels) => [labels].flat().includes(text(el).split(' ').pop())

/** ช่องพิมพ์ของ Flow ทุกแบบ — ใช้แยกปุ่มในช่องพิมพ์ออกจากปุ่มชื่อซ้ำกันบนแถบหัว project */
const PROMPT_BOX = 'flow-base-prompt-box, flow-creative-agent-prompt-box, flow-prompt-box'
/** ไอคอนของปุ่มเฟือง — Flow เปลี่ยนจาก tune เป็น settings_2 เมื่อ 19 พ.ย. 2026 */
const GEAR = ['settings_2', 'tune', 'settings']

const SEL = {
  newProject: () => $$('button').find((b) => L.newProject.test(text(b)) && visible(b)),
  // 19 พ.ย. 2026 ปุ่ม Agent กลายเป็นสวิตช์ใน <flow-agent-mode-switch> คลาส .agent-mode-chip เดิมหายไป
  // ผลคือ agentOn() ตอบ false ตลอด setAgent(false) จึงไม่ทำอะไร ช่องพิมพ์ค้างอยู่โหมด Agent
  // แล้วหา "ปุ่มตั้งค่าโมเดล" ไม่เจอจนหมดเวลา (เจอจริง 20 พ.ย. 2026 — ผลิตล้มทุกรอบ)
  agentChip: () =>
    document.querySelector('flow-agent-mode-switch button[aria-pressed]') ??
    document.querySelector('button.agent-mode-chip') ??
    $$('button.switch').find((b) => b.hasAttribute('aria-pressed')),
  settingsTrigger: () => byAria(L.settingsTrigger).find(visible),
  // ต.ค. 2026 หัวหน้า project มีปุ่มเฟืองชื่อ/ไอคอนเดียวกันเพิ่มมา และอยู่ก่อนใน DOM
  // → เจาะจงปุ่มที่อยู่ในช่องพิมพ์เท่านั้น ไม่งั้นไปเปิดแผงผิดแล้วรอ Agent settings จนหมดเวลา
  agentSettings: () => {
    const inBox = (b) => !!b.closest(PROMPT_BOX)
    return byAria(L.agentSettings).filter(visible).find(inBox) ??
      $$('button').filter((b) => visible(b) && inBox(b)).find((b) => GEAR.includes(text(b)))
  },
  agentPanel: () => document.querySelector('flow-agent-panel'),
  // แผง Agent มีช่องพิมพ์ของตัวเองแล้ว (พ.ย. 2026) → เลือกช่องพิมพ์ของหน้าหลักก่อนเสมอ
  editor: () => {
    const boxes = $$(`${PROMPT_BOX.split(', ').map((s) => `${s} .ProseMirror`).join(', ')}`).filter(visible)
    const list = boxes.length ? boxes : $$('.ProseMirror[contenteditable="true"]').filter(visible)
    return list.find((e) => !e.closest('flow-agent-panel')) ?? list[0]
  },
  send: () => byAria(L.send).find(visible),
}

const agentOn = () => SEL.agentChip()?.getAttribute('aria-pressed') === 'true'

/**
 * เปิด/ปิดโหมด Agent แล้วตรวจผล — ปุ่มถูกวาดใหม่ทุกครั้งที่สลับ (element เปลี่ยนตัว)
 * ลำดับ pointer+mouse event บางครั้งไม่ติด ส่วน .click() บางครั้งไม่ติด → สลับวิธีแล้วลองซ้ำ
 */
async function setAgent(on) {
  for (let attempt = 0; attempt < 6 && agentOn() !== on; attempt++) {
    const chip = await waitFor(() => (visible(SEL.agentChip()) ? SEL.agentChip() : null), { label: 'ปุ่ม Agent' }).catch((err) => {
      // Flow ซ่อนปุ่ม Agent เมื่อหน้าแคบแบบมือถือ (เช่นแผงข้างของ Chrome กว้างจนบีบแท็บ)
      if (window.innerWidth < 1000) {
        throw new Error(`หน้า Google Flow แคบเกินไป (${window.innerWidth}px) Flow จึงซ่อนปุ่ม Agent — ปิดแผงข้างของ Chrome บนแท็บ Flow หรือขยายหน้าต่าง Chrome ให้กว้างกว่า 1000px แล้วกดทำต่อ`)
      }
      throw err
    })
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

const menuItems = () => $$('[role="menuitem"]').filter(visible)

/**
 * ก่อนเปิดเมนูโมเดล: มีเมนูอื่นค้างอยู่ (เมนูของภาพ · ตัวเลือกสื่อ ไม่ใช่รายการรุ่น) → ปิดด้วย Escape แล้วทำต่อ
 * ไม่กดรายการใดในเมนูนั้น และไม่หยุดทั้งงาน (เจอจริงที่ Ebook Plus 0.2.5: หยุดทั้งงานเพราะเมนูค้าง)
 * ส่ง Escape ให้ตัวเมนูก่อน ไม่กด backdrop — กันไปปิดแผงตั้งค่าที่กำลังใช้อยู่
 */
async function closeStrayMenus() {
  if (!strayMenu(menuItems().map(labelText))) return
  escapeMenus(document, { documentToo: false, backdrop: false })
  const closed = await waitFor(() => !menuItems().length, { timeout: 1500, label: 'ปิดเมนูที่ค้าง' }).catch(() => false)
  if (!closed) {
    escapeMenus(document, { backdrop: false })
    await waitFor(() => !menuItems().length, { timeout: 1500, label: 'ปิดเมนูที่ค้าง' }).catch(() => null)
  }
}

/** เปิดเมนูรุ่นแล้วกดรุ่นที่ต้องการ — เทียบชื่อแบบไม่สนภาษาแต่ทั้งคำ ไม่เจอ → ปิดเมนู ไม่กดอะไร (ลองรอบถัดไป) */
async function pickModelFromMenu(modelBtn, model) {
  await closeStrayMenus()
  realClick(modelBtn)
  const item = await waitFor(() => menuItems().find((m) => sameModel(labelText(m), model)), {
    timeout: 5000,
    label: `เมนูโมเดล ${model}`,
  }).catch(() => null)
  if (item) realClick(item)
  else escapeMenus(document, { backdrop: false }) // เมนูไม่เปิด/ถูกวาดทับ/ไม่มีรุ่นนี้ → ปิดแล้วลองรอบใหม่
  await sleep(700)
}

/** หน้า "Project not found" (/404?reason=project) — project ของบัญชี Google อื่น/ถูกลบ ไม่มีปุ่ม New project บนหน้านี้ */
const projectNotFound = () => /^(?:\/u\/\d+)?\/404\b/.test(location.pathname) || /Project not found|ไม่พบโปรเจ็?กต์/i.test(text(document.body).slice(0, 300))

async function openProject() {
  if (/\/project\//.test(location.pathname)) return
  if (projectNotFound()) {
    // กลับหน้ารายการ project ของบัญชีเดียวกันในหน้าเดิม (SPA ไม่โหลดหน้าใหม่ ตัวขับจึงยังอยู่) แล้วเปิด project ใหม่
    console.warn('[cartoon-auto] project เดิมเปิดไม่ได้ (Project not found) — เปิด project ใหม่แทน')
    const back = $$('a, button').find((el) => visible(el) && /Back to projects|กลับไปที่โปรเจ็?กต์/i.test(text(el)))
    if (back) realClick(back)
  }
  const btn = await waitFor(SEL.newProject, { timeout: 30_000, label: 'ปุ่ม New project / โปรเจ็กต์ใหม่' }).catch((err) => {
    const signIn = $$('a, button').some((el) => visible(el) && /^\s*sign in\s*$|เข้าสู่ระบบ/i.test(text(el)))
    if (signIn) throw new Error('Chrome โปรไฟล์นี้ยังไม่ได้ลงชื่อเข้าใช้ Google Flow — ลงชื่อเข้าใช้ในแท็บ Flow ก่อนแล้วกดทำต่อ')
    if (projectNotFound()) throw new Error(`เปิด project ของ Flow ไม่ได้ (Project not found — น่าจะเป็นของบัญชี Google อื่น) และกลับหน้ารายการ project ไม่สำเร็จ (${location.href.split('?')[0]})`)
    throw new Error(`${err.message} (หน้าที่เปิดอยู่: ${location.href.split('?')[0]})`)
  })
  realClick(btn)
  await waitFor(() => /\/project\//.test(location.pathname), { timeout: 30_000, label: 'project ใหม่' })
  await waitFor(SEL.editor, { timeout: 30_000, label: 'ช่องพิมพ์ของ project' })
}

/** ช่องพิมพ์ปกติ (ไม่ใช่ agent) มีตัวบอกจำนวน credit — ใช้ตรวจว่าชุดนี้ฟรีจริงก่อนให้ agent ใช้ */
async function verifyFreeSettings(model, ratio = "16:9") {
  // project ใหม่ของ Flow (ก.ย. 2026) เปิดแชต Agent ด้านขวาเอง → ช่องพิมพ์ปกติที่มีปุ่ม Agent/ตัวเลือกโมเดลถูกซ่อน → ปิดแชตก่อน
  const chatPanel = SEL.agentPanel()
  if (visible(chatPanel) && !SEL.settingsTrigger() && !visible(SEL.agentChip())) {
    const close = byAria(L.close, chatPanel).find(visible)
    if (close) {
      realClick(close)
      await waitFor(() => visible(SEL.agentChip()), { timeout: 10_000, label: 'ช่องพิมพ์หลังปิดแชต Agent' })
      await sleep(500)
    }
  }
  await setAgent(false)
  await waitFor(SEL.settingsTrigger, { label: 'ปุ่มตั้งค่าโมเดล' })

  // แผงตั้งค่าโมเดลวาดใหม่ทุกครั้งที่เปลี่ยนตัวเลือก (เช่น Video → Image) → ห้ามเก็บ element ไว้ใช้ซ้ำ ต้อง query ใหม่ทุกครั้ง
  const pane = () => $$('.cdk-overlay-pane').find((p) => visible(p) && L.creditsPane.test(text(p)))
  const readPane = () => {
    const p = pane()
    if (!p) return null
    const on = (label) => $$('button[role="radio"]', p).find((b) => lastWordIs(b, label))?.getAttribute('aria-checked') === 'true'
    const modelBtn = byAria(L.modelFamily, p)[0]
    return {
      modelBtn,
      state: {
        image: on(L.image),
        ratio: on(ratio),
        x1: on('x1'),
        model: labelText(modelBtn).replace(/arrow_drop_down/, '').replace(/^\S+\s/, '').trim(),
        sameModel: sameModel(labelText(modelBtn), model),
      },
      credits: Number((L.credits.exec(text(p)) ?? [])[1]),
    }
  }
  // ชื่อรุ่นเทียบไม่สนภาษา (หน้าแปลแล้วเป็น "นาโน บานานา 2 Lite") — ตัวตรวจ 0 credits ด้านล่างยังเป็นด่านสุดท้ายเสมอ
  const ready = (st) => st.image && st.ratio && st.x1 && st.sameModel

  let cur = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (!pane()) {
      realClick(await waitFor(SEL.settingsTrigger, { label: 'ปุ่มตั้งค่าโมเดล' }))
      await waitFor(pane, { label: 'หน้าตั้งค่าโมเดล' })
      await sleep(400)
    }
    cur = readPane()
    if (cur && ready(cur.state)) break
    for (const label of [L.image, ratio]) {
      const btn = $$('button[role="radio"]', pane() ?? document).find((b) => lastWordIs(b, label))
      if (btn && btn.getAttribute('aria-checked') !== 'true') {
        realClick(btn)
        await sleep(600) // Image/Video สลับแล้วแผงวาดตัวเลือกโมเดลใหม่
      }
    }
    cur = readPane()
    if (cur?.modelBtn && !cur.state.sameModel) await pickModelFromMenu(cur.modelBtn, model)
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
  // ปิดแผงตั้งค่า: Escape ถึงตัวเมนู + document + backdrop · ยังไม่ปิดลองอีกครั้ง ไม่หยุดงานเพราะเรื่องนี้
  for (let i = 0; i < 2 && pane(); i++) {
    escapeMenus()
    await waitFor(() => !pane(), { timeout: 1500, label: 'ปิดแผงตั้งค่า' }).catch(() => null)
  }
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

/**
 * แผง Agent settings — Flow เปลี่ยนรูปแบบทั้งแผงเมื่อ 19 พ.ย. 2026 (ตรวจกับหน้าจริงแล้ว 20 พ.ย. 2026)
 *   เดิม  ทุกอย่างอยู่หน้าเดียว เลือกรุ่นจากเมนู แล้วกดปุ่ม Save
 *   ใหม่  หน้าหลัก <flow-unified-settings-view> = ยืนยันก่อนสร้าง + แถว "ค่าเริ่มต้นของรูปภาพ/วิดีโอ"
 *         กดแถวรูปภาพ → หน้าย่อย <flow-generation-defaults-view> = รุ่น (label.radio-option) · สัดส่วน · จำนวน
 *         ไม่มีปุ่ม Save แล้ว ค่าถูกบันทึกทันทีที่กด จึงกดปุ่มย้อนกลับแทน
 */
const AGENT = {
  root: () => $$('flow-unified-settings-view', SEL.agentPanel() ?? document).find(visible),
  sub: () => $$('flow-generation-defaults-view', SEL.agentPanel() ?? document).find(visible),
  imageRow: () => $$('button.image-defaults-row', SEL.agentPanel() ?? document).find(visible),
  back: () => {
    const root = SEL.agentPanel() ?? document
    return byAria(L.back, root).find(visible) ?? $$('button', root).find((b) => visible(b) && text(b) === 'arrow_back')
  },
  models: () => $$('label.radio-option', AGENT.sub() ?? document),
  radios: (root) => $$('button[role="radio"]', root ?? document),
}

async function configureAgent(model, { dryRun, ratio = "16:9" }) {
  await setAgent(true)
  const settingsOpen = () => (AGENT.root() || AGENT.sub() ? SEL.agentPanel() : null)
  if (!settingsOpen()) realClick(await waitFor(SEL.agentSettings, { label: 'ปุ่ม Settings ของ Agent' }))
  await waitFor(settingsOpen, { label: 'Agent settings' })
  await waitSettled(settingsOpen)

  // รอบก่อนอาจค้างอยู่หน้าย่อย → กลับหน้าหลักก่อน ไม่งั้นหาสวิตช์ "ยืนยันก่อนสร้าง" ไม่เจอ
  for (let i = 0; i < 2 && AGENT.sub() && AGENT.back(); i++) {
    realClick(AGENT.back())
    await waitFor(() => !AGENT.sub(), { timeout: 4000, label: 'กลับหน้าหลักของ Agent settings' }).catch(() => null)
  }

  // 1) ยืนยันก่อนสร้าง = ไม่เลย → agent สร้างภาพต่อเนื่องเองโดยไม่ต้องรอกดยืนยันทีละชุด
  const never = () => AGENT.radios(AGENT.root()).find((b) => L.never.test(labelText(b)))
  for (let i = 0; i < 3 && never() && never().getAttribute('aria-checked') !== 'true'; i++) {
    realClick(never())
    await sleep(700)
  }
  const confirm = never()?.getAttribute('aria-checked') === 'true' ? 'Never' : 'Always'
  if (confirm !== 'Never') {
    throw new Error('ตั้ง "ยืนยันก่อนสร้าง" เป็น ไม่เลย/Never ไม่สำเร็จ — ตั้งเองในแผง Agent settings ของ Flow แล้วสั่งใหม่')
  }

  // 2) เข้าหน้าค่าเริ่มต้นของรูปภาพ
  // แผงยังโหลดค่าจาก server แล้ววาดใหม่ได้ — คลิกแรกหายไปกับแถวเก่า (เจอจริง 23 พ.ย. 2026 "รอ หน้าค่าเริ่มต้นของรูปภาพ ไม่เจอ")
  // → หาแถวใหม่ทุกรอบ สลับวิธีคลิก ลองได้ 4 ครั้ง
  for (let attempt = 0; attempt < 4 && !AGENT.sub(); attempt++) {
    const row = await waitFor(AGENT.imageRow, { label: 'แถวค่าเริ่มต้นของรูปภาพใน Agent settings' })
    if (attempt % 2 === 0) realClick(row)
    else row.click()
    await waitFor(AGENT.sub, { timeout: 6000, label: 'หน้าค่าเริ่มต้นของรูปภาพ' }).catch(() => null)
  }
  if (!AGENT.sub()) await waitFor(AGENT.sub, { timeout: 4000, label: 'หน้าค่าเริ่มต้นของรูปภาพ' })
  await waitSettled(AGENT.sub, { quietMs: 600, timeout: 6000 })

  // 3) รุ่น · สัดส่วน · จำนวน — ทุกครั้งต้อง query ใหม่ แผงวาดใหม่แล้ว element เดิมหลุดจากหน้า คลิกไปก็ไม่มีผล
  const picked = () => AGENT.models().find((o) => o.classList.contains('radio-option-selected'))
  const state = () => {
    const sub = AGENT.sub()
    const checked = (re) => text(AGENT.radios(sub).find((b) => b.getAttribute('aria-checked') === 'true' && re.test(text(b)))).split(' ').pop()
    return {
      model: labelText(picked()),
      sameModel: sameModel(labelText(picked()), model),
      ratio: checked(/:/),
      count: checked(/(^|\s)x\d$/),
    }
  }
  const ok = (st) => st.sameModel && st.ratio === ratio && st.count === 'x1'
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (ok(state())) break
    if (!state().sameModel) {
      const want = AGENT.models().find((o) => sameModel(labelText(o), model))
      if (!want) {
        const have = AGENT.models().map((o) => labelText(o)).join(' · ') || 'อ่านรายการรุ่นไม่ได้'
        throw new Error(`ไม่มีรุ่น ${model} ในหน้าค่าเริ่มต้นของรูปภาพ (มี: ${have})`)
      }
      realClick(want)
      await sleep(900)
    }
    for (const label of [ratio, 'x1']) {
      const btn = AGENT.radios(AGENT.sub()).find((b) => text(b).split(' ').pop() === label)
      if (!btn) throw new Error(`ไม่พบตัวเลือก ${label} ในหน้าค่าเริ่มต้นของรูปภาพของ Agent`)
      if (btn.getAttribute('aria-checked') !== 'true') {
        realClick(btn)
        await sleep(700)
      }
    }
    if (attempt === 4 && !ok(state())) {
      const st = state()
      throw new Error(`ตั้งค่าเริ่มต้นของรูปภาพใน Agent settings ไม่สำเร็จ (ตอนนี้: ${st.model || '?'} · ${st.ratio || '?'} · ${st.count || '?'}) — ตั้งเองเป็น ${model} · ${ratio} · x1 แล้วสั่งใหม่`)
    }
  }
  const summary = { confirm, ...state() }

  // 4) ออกจากแผง — ไม่มีปุ่ม Save แล้ว ค่าบันทึกไปตั้งแต่ตอนกด (dryRun จึงกันการบันทึกไม่ได้อีกต่อไป)
  for (let i = 0; i < 2 && (AGENT.sub() || AGENT.root()); i++) {
    const back = AGENT.back()
    if (!back) break
    realClick(back)
    await sleep(1200)
  }
  const close = byAria(L.close, SEL.agentPanel() ?? document).find(visible)
  if (close) {
    realClick(close)
    await sleep(600)
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
  await waitBeforeNextPrompt()
  await attachImages(await waitFor(SEL.editor, { label: 'ช่องพิมพ์' }), attachments)
  // แนบรูปแล้ว Flow วาดช่องพิมพ์ใหม่ (element เดิมหลุดจากหน้า — ตรวจกับหน้าจริงแล้ว) → ต้องหาช่องพิมพ์ใหม่ทุกครั้ง
  const want = String(prompt).replace(/\s+/g, ' ').trim()
  const clearEditor = () => {
    SEL.editor()?.focus()
    document.execCommand('selectAll', false)
    document.execCommand('delete', false)
  }
  const pasteText = async () => {
    const editor = await waitFor(SEL.editor, { label: 'ช่องพิมพ์' })
    editor.focus()
    // รอบก่อนส่งไม่สำเร็จอาจทิ้ง prompt ไว้ในช่อง อย่าวางต่อท้ายจนยาวเป็นสองเท่า
    clearEditor()
    if (text(SEL.editor())) return false
    // 23 พ.ย. 2026 Flow ไม่รับข้อความจาก paste event ที่สร้างเองแล้ว (กินเหตุการณ์แต่ช่องว่างเปล่า — รูปภาพยังรับอยู่)
    // → พิมพ์ด้วย insertText เป็นหลัก (ตรวจกับหน้าจริงแล้ว ยาว 25,000 ตัวอักษรก็ได้) · paste เหลือไว้เป็นทางสำรอง
    document.execCommand('insertText', false, prompt)
    await sleep(400)
    if (text(SEL.editor()) === want) return true
    clearEditor()
    if (text(SEL.editor())) return false
    const data = new DataTransfer()
    data.setData('text/plain', prompt)
    SEL.editor()?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    await sleep(800)
    return text(SEL.editor()) === want
  }
  // Flow รับงานแล้ว = มีปุ่ม Stop · การ์ดคำตอบขึ้นว่าผิดพลาด · หรือช่องพิมพ์ถูกล้าง
  const accepted = () => agentBusy() || agentFailed() || !text(SEL.editor())
  // ส่งแล้วต้องเห็นว่า Flow รับงานจริง ไม่ใช่แค่ช่องพิมพ์ว่าง — ว่างเพราะถูกปฏิเสธก็ว่างเหมือนกัน
  let failure = ''
  for (let round = 1; round <= 3; round++) {
    let pasted = false
    for (let attempt = 0; attempt < 3 && !pasted; attempt++) {
      pasted = await pasteText()
      if (!pasted) await sleep(1500)
    }
    if (!pasted) throw new Error('วาง prompt ลงช่องพิมพ์ของ Flow ไม่ได้')
    await waitFor(() => (SEL.send() && !SEL.send().disabled ? SEL.send() : null), { label: 'ปุ่มส่งพร้อมใช้งาน' })
    await chrome.storage.local.set({ [FLOW_LAST_PROMPT_KEY]: Date.now() })
    await trustedSend(await waitFor(SEL.editor, { label: 'ช่องพิมพ์' }), prompt)
    let took = await waitFor(accepted, { timeout: 8000, label: 'Flow รับ prompt' }).catch(() => false)
    // Enter ไม่ติด (ข้อความยังค้างในช่อง ไม่มีงานเดิน) → กดปุ่มลูกศรส่งด้วยเมาส์จริงแทน (เจอจริง 23 พ.ย. 2026 ทั้งสามระบบ)
    if (!took && text(SEL.editor()) === want && SEL.send() && !SEL.send().disabled) {
      console.warn('[cartoon-auto] Enter ไม่ส่ง prompt — กดปุ่มส่งแทน')
      await trustedSend(SEL.editor(), prompt, { click: true })
      took = await waitFor(accepted, { timeout: 15_000, label: 'Flow รับ prompt' }).catch(() => false)
    }
    if (!took) took = await waitFor(accepted, { timeout: 7000, label: 'Flow รับ prompt' }).catch(() => false)
    if (!took) throw new Error(`Flow ไม่รับ prompt หลังกด Enter และกดปุ่มส่งแล้ว (${sendDiagnosis()}) — เปิดแท็บ Flow ดูว่ามีอะไรค้างอยู่`)
    // รอให้การ์ดคำตอบนิ่งก่อนตัดสิน — Flow ขึ้น "เกิดข้อผิดพลาด" ภายในไม่กี่วินาทีเมื่อไม่รับงาน
    const failed = await waitFor(agentFailed, { timeout: 12_000, interval: 500, label: 'คำตอบของ Agent' }).catch(() => null)
    if (!failed) return
    failure = [labelText(failed), pageAlerts()].filter(Boolean).join(' · ').replace(/\s+/g, ' ').trim().slice(0, 220)
    // Flow กันบอต — ลองใหม่กี่ครั้งก็เหมือนเดิม และคลิปถัดไปก็เจอเหมือนกัน หยุดทั้งชุดดีกว่าไล่ทำต่อให้พังหมด
    if (L.unusualActivity.test(failure)) break
    await sleep(5000 * round)
  }
  const blocked = L.unusualActivity.test(failure)
  throw new Error(
    `FLOW_BLOCKED: Google Flow ไม่รับคำสั่งของ Agent — "${failure}"` +
    (blocked
      ? ' · Flow มองว่าการใช้งานผิดปกติ (มันเตือนเรื่องส่วนขยายที่แก้หน้าเว็บด้วย) หยุดสั่งงานอัตโนมัติสักพัก แล้วเปิดหน้า Flow สั่งสร้างภาพเองด้วยมือสักครั้งให้ผ่านก่อน ค่อยเริ่มผลิตใหม่'
      : ' · ลองส่งใหม่ครบ 3 ครั้งแล้วยังไม่ผ่าน เปิดหน้า Flow ดูว่ามีอะไรค้างอยู่')
  )
}

const agentBusy = () => !!byAria(L.stop).find(visible)
/** การ์ดคำตอบของ Agent บนหน้าโปรเจกต์ (ไม่ใช่แผงข้าง) */
const agentCard = () => $$('flow-agent-response-header').find(visible) ?? null
/**
 * Flow ตอบกลับทันทีว่ารับงานไม่ได้ — ช่องพิมพ์ว่างเหมือนส่งสำเร็จ แต่ไม่มีงานเดินสักอย่าง
 * ต้องมีทั้งข้อความผิดพลาดและปุ่ม "ลองอีกครั้ง" ถึงนับ ไม่งั้นคำตอบปกติที่บังเอิญมีคำว่าผิดพลาดจะโดนจับผิด
 * ไม่จับตรงนี้ = ไปรอภาพที่ไม่มีวันมาอีกสิบกว่านาที แล้วรายงานผิดเรื่อง (เจอจริง 20 พ.ย. 2026)
 */
const agentFailed = () => {
  const card = agentCard()
  if (!card || !L.agentFailed.test(text(card))) return null
  return $$('button', card).some((b) => visible(b) && L.tryAgain.test(text(b))) ? card : null
}
/** ข้อความเตือนของ Flow ที่ขึ้นบนหน้า (เช่นคำเตือนเรื่องการใช้งานผิดปกติ) */
const pageAlerts = () =>
  $$('[role="alert"], mat-snack-bar-container, flow-error-tile').filter(visible).map((el) => text(el)).filter(Boolean).join(' · ')

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
/**
 * src ของ tile เป็นภาพย่อ (…/asb/…=s512-rw → 286×512) — ขอภาพเต็มด้วย =s0 (768×1376)
 * ภาพย่อทำให้คลิปเบลอ และ Kie/Seedance ปฏิเสธภาพกว้างไม่ถึง 300px (ตรวจกับหน้าเว็บจริง ก.ย. 2026)
 */
const fullSize = (src) => (/^https:\/\/[^/]*(?:flow\.google\.com|googleusercontent\.com)\//.test(src) ? src.replace(/=[swh]\d+[^/=]*$/, '') + '=s0' : src)

async function imageAsPngBase64(src) {
  const blob = await fetch(fullSize(src)).then((r) => {
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
      if (type === 'PROGRESS' && res?.cancelled) throw new JobCancelled()
      if (res?.ok || type === 'PROGRESS') return res
      last = res?.error ?? 'bridge ไม่รับ'
    } catch (err) {
      if (err instanceof JobCancelled) throw err
      last = String(err?.message ?? err)
    }
    await sleep(1500 * (i + 1))
  }
  throw new Error(`ส่งภาพกลับโปรแกรมในเครื่องไม่สำเร็จ: ${last}`)
}
/** bridge ยกเลิกงานนี้แล้ว (โปรแกรมที่สั่งถูกปิด/เริ่มใหม่) → หยุดทันที ปล่อยแท็บให้งานถัดไป */
class JobCancelled extends Error {
  constructor() {
    super('งานนี้ถูกยกเลิกแล้ว')
  }
}
const PNG_BATCH = 4 // ส่งกลับทีละ 4 ใบ กัน payload ใหญ่เกิน
const RETRY_BATCH = 10 // สั่งซ้ำทีละไม่เกิน 10 ช็อต — ชุดใหญ่ทำให้ "The agent failed" บ่อย
const SAFE_AFTER = 2 // ช็อตที่ล้มเหลวครบกี่ครั้งแล้วให้ agent เขียนภาพใหม่ให้ปลอดภัยขึ้น
const MAX_STALLS = 3 // รอบติดกันที่ไม่ได้ภาพเพิ่มเลย → เลิก (autopilot จะเปิด project ใหม่สั่งต่อเอง)
const IDLE_MS = 75_000 // agent หยุดนิ่งนานเท่านี้ = จบรอบ (ระหว่างภาพปุ่ม Stop อาจหายแวบๆ)
const ROUND_MAX_MS = 45 * 60_000
// Flow คิวเต็ม ("The agent is experiencing high demand") → สั่งซ้ำทันทีก็โดนปฏิเสธอีก รอเว้นช่วงยาวขึ้นเรื่อยๆ (2 → 4 → 8 → 15 นาที)
const BUSY_WAITS_MS = [2, 4, 8, 15].map((m) => m * 60_000)
const BUSY_MAX_MS = 40 * 60_000 // รอรวมเกินนี้ → เลิก ให้ autopilot เปิด project ใหม่สั่งต่อ

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
/** agent ตอบกลับเป็นแผน/คำถาม ("ต้องการให้เริ่มสร้างภาพไหม") แทนที่จะสร้างภาพ → สั่งให้เริ่มเลย */
function goInstruction(shots, styleNote = '') {
  return `เริ่มสร้างภาพได้เลยทุกช็อตตาม shot list ที่ส่งไป ไม่ต้องถามยืนยันและไม่ต้องสรุปแผนอีก ใช้ Style Bible และ Character Bible เดิม (lock ตัวละคร)${styleNote ? `\n${styleNote}` : ''}
ตั้งชื่อแต่ละภาพเป็นชื่อไฟล์หน้าบรรทัดเป๊ะๆ เช่น "${shots[0].filename} SHOT" (ชื่อภาพเท่านั้น ห้ามเขียนลงในภาพ)`
}

// ลายเส้นต้องย้ำทุกคำสั่ง — คลิปยาวสั่งเป็นชุดละ 10 ช็อต ลายเส้นในข้อความแรกจางหาย แล้วได้ภาพถ่ายสมจริงปนการ์ตูน
function continueInstruction(batch, { remaining, safer, styleNote = '' }) {
  const style = styleNote ? `\n${styleNote}` : ''
  const naming = `ตั้งชื่อแต่ละภาพเป็นชื่อไฟล์ตามหน้าบรรทัดเป๊ะๆ เช่น "${batch[0].filename} SHOT" (ชื่อภาพเท่านั้น ห้ามเขียนชื่อไฟล์ เลข SHOT หรือ @TAG ลงในภาพ)`
  if (safer) {
    return `ช็อตต่อไปนี้สร้างไม่สำเร็จหลายครั้งแล้ว (Failed) — น่าจะติดตัวกรองเนื้อหา
ปรับภาพให้ปลอดภัยขึ้นแต่ยังเล่าเรื่องเดิม: ไม่มีเลือด บาดแผล อาวุธกระทบร่างกาย การทำร้าย หรือหน้าน่ากลัวแบบสมจริง
ใช้วิธีเล่าอ้อม เช่น เงา สัญลักษณ์ มุมกล้องไกล หรือท่าทางตกใจแบบการ์ตูน · Style Bible และ Character Bible เดิมทุกอย่าง (lock ตัวละคร)${style}
${naming}

${batch.map(shotLine).join('\n\n')}`
  }
  return `ยังขาดภาพอีก ${remaining} ช็อต — รอบนี้สร้าง ${batch.length} ช็อตนี้ก่อน ใช้ Style Bible และ Character Bible เดิมทุกอย่าง (lock ตัวละครเหมือนภาพที่ทำไปแล้ว)${style}
${naming}

${batch.map(shotLine).join('\n\n')}`
}

/** ภาพที่ Flow สร้างไม่สำเร็จ ("Sorry, this image failed to generate") + agent ล้มเหลวทั้งรอบ ("The agent failed") */
function failureCounts() {
  // grid เป็น virtual scroll → นับได้เฉพาะใบที่วาดอยู่ ใช้บอกสาเหตุใน log ไม่ได้ใช้ตัดสินใจ
  const imageFailed =
    $$('flow-error-tile').filter((el) => !el.closest('flow-agent-panel')).length +
    $$('flow-grid-tile-container').filter((t) => !t.querySelector('flow-error-tile') && L.failedTile.test(t.innerText ?? '')).length
  const panel = SEL.agentPanel()?.innerText ?? ''
  const agentFailed = (panel.match(/The agent failed/gi) ?? []).length
  const highDemand = (panel.match(L.highDemand) ?? []).length
  return { imageFailed, agentFailed, highDemand }
}

/** รอ agent ทำงานจนนิ่ง — คืนจำนวนภาพใหม่ของรอบนี้ */
async function waitAgentIdle(job, { before, expected, stage, onTick }) {
  const started = Date.now()
  let last = -1
  let idleSince = null
  for (let tick = 1; ; tick++) {
    await sleep(5000)
    // เก็บภาพที่ตั้งชื่อแล้วระหว่างที่ agent ยังวาดอยู่ทุก 15 วิ — ไม่ต้องรอให้ agent นิ่ง 75 วิก่อนค่อยเริ่มดึง
    if (onTick && tick % 3 === 0) await onTick().catch(() => {})
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
  const input = await waitFor(() => [...$$('input.editable-text-input'), ...byAria(L.editableText, document, 'input')].find(visible), { timeout: 15_000, label: 'ช่องชื่อ project' }).catch(() => null)
  if (!input || input.value === name) return
  input.focus()
  input.select()
  // 23 พ.ย. 2026 ตั้งค่าผ่าน setter แล้วชื่อไม่เปลี่ยน → พิมพ์ทับด้วย insertText แล้วกด Enter (ตรวจกับหน้าจริงแล้ว ต้องมี Enter ชื่อถึงบันทึก)
  // insertText ไม่ได้ผล → ตั้งผ่าน setter ของ input จริงแล้วยิง input/change ให้ครบเหมือนเดิม
  if (!document.execCommand('insertText', false, name) || input.value !== name) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, name)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  await sleep(200)
  for (const type of ['keydown', 'keyup']) input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
  input.blur()
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  await sleep(1500)
  if (!document.title.includes(name.slice(0, 20)) && input.value !== name) console.warn('[cartoon-auto] ตั้งชื่อ project ใน Flow ไม่สำเร็จ')
}

async function runImageJob(job) {
  const { prompt, shots, model = 'Nano Banana 2 Lite', aspect = '16:9', attachments = [], projectTitle, styleNote = '' } = job.payload
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
  // รูปตัวละครที่แนบไปกลายเป็น tile ใน project ด้วย — นับเป็นฐานใหม่ ไม่งั้นถูกนับว่าเป็น "ภาพใหม่ที่ยังไม่ตั้งชื่อ"
  await sleep(3000)
  const base = Math.max(before, collectTiles().size)
  let stalls = 0
  let nudges = 0
  const tries = new Map(shots.map((s) => [s.filename, 1])) // จำนวนครั้งที่สั่งแต่ละช็อตไปแล้ว
  const failuresAtStart = failureCounts()
  let seenHighDemand = failuresAtStart.highDemand
  let busyWaits = 0
  let busyWaited = 0
  for (let round = 1; ; round++) {
    const beforeRound = collectTiles().size
    await waitAgentIdle(job, { before, expected, stage: 'generate', onTick: () => saveNew(namedPicks(wanted)) })
    const newThisRound = collectTiles().size - beforeRound
    await scanAllTiles()
    let picks = namedPicks(wanted)

    // ยังไม่มีภาพใหม่เลย = agent หยุดถามยืนยัน/สรุปแผน → สั่งให้เริ่มสร้าง (ห้ามสั่งเปลี่ยนชื่อ เพราะไม่มีภาพให้เปลี่ยน)
    if (collectTiles().size - base <= 0 && !picks.size && nudges < 3) {
      nudges++
      if (agentBusy()) await waitFor(() => !agentBusy(), { timeout: 10 * 60_000, interval: 2000, label: 'Agent ว่าง' })
      await sendPrompt(goInstruction(shots, styleNote))
      continue
    }

    // มีภาพใหม่ที่ยังไม่ได้ตั้งชื่อ timecode → ให้ agent ตั้งชื่อก่อน
    const unnamed = collectTiles().size - base - picks.size
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

    // Flow คิวเต็ม → ไม่นับเป็นรอบที่ล้ม รอให้คิวว่างก่อนแล้วสั่งช็อตเดิมใหม่
    if (failures.highDemand > seenHighDemand) {
      seenHighDemand = failures.highDemand
      const wait = BUSY_WAITS_MS[Math.min(busyWaits++, BUSY_WAITS_MS.length - 1)]
      if (busyWaited + wait > BUSY_MAX_MS) break
      busyWaited += wait
      console.warn(`[cartoon-auto] Flow คิวเต็ม (high demand) — รอ ${wait / 60_000} นาทีแล้วลองใหม่`)
      for (const until = Date.now() + wait; Date.now() < until; ) {
        await toBridge('PROGRESS', { id: job.id, progress: { done: saved.size, total: expected, stage: 'busy', retryAt: until } }) // heartbeat กัน bridge คิดว่าแท็บหลุด
        await sleep(20_000)
      }
      if (agentBusy()) await waitFor(() => !agentBusy(), { timeout: 10 * 60_000, interval: 2000, label: 'Agent ว่าง' })
      await sendPrompt(continueInstruction(missing.slice(0, RETRY_BATCH), { remaining: missing.length, safer: false, styleNote }))
      continue
    }
    busyWaits = 0
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
    await sendPrompt(continueInstruction(batch, { remaining: missing.length, safer: useSafer, styleNote }))
  }

  if (!saved.size) throw new Error('Agent ไม่ได้สร้างภาพที่ตั้งชื่อเป็น timecode เลย — ดูในแท็บ Flow')
  await toBridge('RESULT', { id: job.id, files: [], meta: { generated: collectTiles().size - before, expected, named: saved.size } })
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // หน้าตรวจความพร้อม: เห็นปุ่ม New project หรืออยู่ใน project = ล็อกอินแล้ว · เห็นปุ่ม Sign in = ยัง
  if (msg.type === 'PING') {
    const signIn = $$('a, button').some((el) => visible(el) && /^\s*sign in\s*$|เข้าสู่ระบบ/i.test(text(el)))
    const inside = /\/project\//.test(location.pathname) || !!SEL.newProject()
    sendResponse({ ok: true, loggedIn: signIn ? false : inside ? true : null, url: location.href, running, translated: pageTranslated() })
    return
  }
  if (msg.type === 'RUN_JOB' && msg.job?.kind === 'generate-images') {
    // งานเก่ายังวิ่งอยู่ (เช่นกดเริ่มใหม่) → bridge ยกเลิกงานเก่าให้ภายใน ~2 นาที มันจะหยุดเองที่ heartbeat ถัดไป รอก่อนแทนการปัดตก
    const start = running ? waitFor(() => !running, { timeout: 3 * 60_000, interval: 2000, label: 'งาน Flow ก่อนหน้าหยุด' }) : Promise.resolve()
    // ผลและ error ส่งผ่าน toBridge เอง — service worker อาจถูกปิดระหว่างงาน 30 นาที ทำให้ sendResponse หาย
    start
      .then(() => {
        if (running) throw new Error('กำลังส่งงานให้ Flow อยู่แล้ว')
        running = true
        return runImageJob(msg.job).finally(() => (running = false))
      })
      .then(() => sendResponse({ ok: true }))
      .catch(async (err) => {
        const message = errorText(err)
        await toBridge('ERROR', { id: msg.job.id, message }).catch(() => {})
        sendResponse({ ok: true, reported: true })
      })
    return true
  }

  const reply = (fn) => {
    ;(async () => {
      try {
        sendResponse({ ok: true, ...(await fn()) })
      } catch (err) {
        sendResponse({ ok: false, error: errorText(err) })
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
      sendResponse({ ok: false, error: errorText(err) })
    } finally {
      running = false
    }
  })()
  return true
})
})()
