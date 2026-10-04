(() => {
if (globalThis.__cartoon_meta_agent) return // ฉีดซ้ำ → ไม่เพิ่ม listener ซ้ำ
globalThis.__cartoon_meta_agent = true

/**
 * ขับ Meta AI (meta.ai) ให้ทำภาพเป็นวิดีโอสั้น — โหมดทดลอง ตรวจกับหน้าเว็บจริงแล้ว (ก.ย. 2026)
 *
 *   1. background เปิดหน้า meta.ai/create/ (หน้า Media — สั่งในแชตธรรมดาบางทีได้แอนิเมชัน HTML แทนวิดีโอ)
 *   2. แนบภาพผ่าน input[type=file] → รอปุ่ม "Remove image" ขึ้นในช่องพิมพ์
 *   3. พิมพ์ "สร้าง vdo จากภาพนี้ ..." ลงช่องพิมพ์ (Lexical) → กด Send → หน้าเปลี่ยนเป็น /prompt/<id>
 *   4. รอ <video> ในคำตอบ ([aria-label="Meta AI response"]) → fetch src (fbcdn ให้หน้า meta.ai โหลดได้) → ส่ง mp4 กลับ bridge
 *
 * งานที่รับ: { kind: 'animate-image', payload: { image: {name,type,base64}, prompt, filename } }
 * เต็มโควตา ("You reached your limit") → error ขึ้นต้น QUOTA ให้ pipeline หยุดสั่งช็อตต่อไป
 */
const VERSION = chrome.runtime.getManifest().version
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const visible = (el) => !!el && el.getBoundingClientRect().width > 0
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

async function waitFor(fn, { timeout = 20_000, interval = 300, label = 'หน้าเว็บ' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`รอ ${label} ไม่เจอ (${Math.round(timeout / 1000)} วิ) — หน้า Meta AI อาจเปลี่ยน`)
    await sleep(interval)
  }
}

const SEL = {
  editor: () => $$('[contenteditable="true"][data-lexical-editor="true"]').find(visible) ?? $$('[contenteditable="true"]').find(visible),
  fileInput: () => document.querySelector('input[type="file"]'),
  send: () => $$('button[aria-label="Send"]').find(visible),
  attached: () => $$('button[aria-label="Remove image"]').find(visible),
  responses: () => $$('[aria-label="Meta AI response"]'),
}

const QUOTA = /reached your limit|wait until tomorrow|เต็มโควต้า|เต็มโควตา|Upgrade to do more/i
const FAILED = /file unavailable|couldn't (?:create|generate)|can't create|ไม่สามารถสร้าง/i

async function attachImage(image) {
  const input = await waitFor(SEL.fileInput, { label: 'ช่องแนบไฟล์' })
  const dt = new DataTransfer()
  dt.items.add(new File([Uint8Array.from(atob(image.base64), (c) => c.charCodeAt(0))], image.name, { type: image.type }))
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await waitFor(SEL.attached, { timeout: 60_000, label: 'Meta AI รับภาพ' })
  await sleep(1000)
}

async function typePrompt(prompt) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const editor = await waitFor(SEL.editor, { label: 'ช่องพิมพ์' })
    editor.focus()
    document.execCommand('insertText', false, prompt)
    await sleep(600)
    if (editor.innerText.trim().length > 10) return
    await sleep(1000)
  }
  throw new Error('พิมพ์คำสั่งลงช่องของ Meta AI ไม่ได้')
}

/** วิดีโอในคำตอบใหม่ (หน้าแบบให้เลือก Response 1/2 ก็มีหลายคำตอบ — เอาอันแรกที่มีวิดีโอ) */
function responseVideo(before) {
  for (const r of SEL.responses().slice(before)) {
    const v = $$('video', r).find((x) => x.currentSrc || x.src)
    if (v) return v.currentSrc || v.src
  }
  return null
}

const responseText = (before) => SEL.responses().slice(before).map((r) => r.innerText).join('\n')

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** ส่งถึง bridge ผ่าน service worker — ลองใหม่ถ้า worker กำลังถูกปลุก */
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
  throw new Error(`ส่งคลิปกลับโปรแกรมในเครื่องไม่สำเร็จ: ${last}`)
}

async function runAnimateJob(job) {
  const { image, prompt, filename } = job.payload
  const progress = (stage) => toBridge('PROGRESS', { id: job.id, progress: { stage } }).catch(() => {})
  await progress('แนบภาพใน Meta AI')
  await waitFor(SEL.editor, { timeout: 30_000, label: 'ช่องพิมพ์ของ Meta AI (ล็อกอิน meta.ai แล้วหรือยัง)' })
  const before = SEL.responses().length
  await attachImage(image)
  await typePrompt(prompt)
  const send = await waitFor(() => (SEL.send() && !SEL.send().disabled ? SEL.send() : null), { label: 'ปุ่มส่ง' })
  send.click()

  await progress('Meta AI กำลังสร้างวิดีโอ')
  const heartbeat = setInterval(() => progress('Meta AI กำลังสร้างวิดีโอ'), 20_000)
  let src
  try {
    // ปกติ 30 วิ – 2 นาที · หน้าแบบ Response 1/2 ต้องรอทั้งสองคำตอบ
    src = await waitFor(() => {
      const found = responseVideo(before)
      if (found) return found
      const text = responseText(before)
      if (QUOTA.test(text)) throw new Error('QUOTA: Meta AI แจ้งว่าเต็มโควตาวันนี้ (You reached your limit)')
      return null
    }, { timeout: 5 * 60_000, interval: 3000, label: 'วิดีโอจาก Meta AI' })
  } catch (err) {
    const text = responseText(before)
    if (!/^QUOTA/.test(err.message) && FAILED.test(text)) throw new Error(`Meta AI สร้างวิดีโอไม่สำเร็จ: ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
    throw err
  } finally {
    clearInterval(heartbeat)
  }

  await progress('ดาวน์โหลดคลิป')
  const res = await fetch(src)
  if (!res.ok) throw new Error(`โหลดวิดีโอไม่ได้ (${res.status})`)
  const blob = await res.blob()
  if (!/video/.test(blob.type) || blob.size < 20_000) throw new Error(`ไฟล์ที่ได้ไม่ใช่วิดีโอ (${blob.type}, ${blob.size} bytes)`)
  await toBridge('RESULT', { id: job.id, files: [{ name: filename, base64: await toBase64(blob) }], meta: { bytes: blob.size, url: location.href.split('?')[0] } })
}

let running = false
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // หน้าตรวจความพร้อม: มีช่องพิมพ์ + ไม่มีปุ่ม Log in = ล็อกอินแล้ว
  if (msg.type === 'PING') {
    const login = $$('a, button').some((el) => visible(el) && /^\s*(log in|sign up|continue with facebook|เข้าสู่ระบบ)\s*$/i.test(el.innerText ?? ''))
    sendResponse({ ok: true, loggedIn: login ? false : SEL.editor() ? true : null, url: location.href, running })
    return
  }
  if (msg.type !== 'RUN_JOB') return
  if (running) {
    sendResponse({ ok: false, error: 'กำลังทำงาน Meta AI อยู่แล้ว' })
    return
  }
  if (msg.job.kind !== 'animate-image') {
    sendResponse({ ok: false, error: `Meta AI ไม่รู้จักงาน: ${msg.job.kind}` })
    return
  }
  running = true
  runAnimateJob(msg.job)
    .then(() => sendResponse({ ok: true }))
    .catch(async (err) => {
      await toBridge('ERROR', { id: msg.job.id, message: `${/^QUOTA/.test(err.message) ? '' : `[extension ${VERSION}] `}${err.message}` }).catch(() => {})
      sendResponse({ ok: true, reported: true })
    })
    .finally(() => (running = false))
  return true
})
})()
