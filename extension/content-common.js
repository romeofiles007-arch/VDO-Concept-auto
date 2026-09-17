(() => {
/**
 * เครื่องมือร่วมของ content script ทุกเว็บ
 *
 * หลักการ: พิมพ์และคลิกให้เหมือนคนจริงที่สุด เพราะ React ไม่รับรู้การ set .value ตรงๆ
 */

/** รอจนกว่า fn() จะคืนค่าจริง หรือหมดเวลา */
async function waitFor(fn, { timeout = 60_000, interval = 300, label = 'เงื่อนไข' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`รอ ${label} เกิน ${Math.round(timeout / 1000)} วิ`)
    await new Promise((r) => setTimeout(r, interval))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** รอจนหน้าหยุดเปลี่ยนแปลง — ใช้แทนการเดาว่า SPA render เสร็จหรือยัง */
async function waitStable(el, { quietMs = 1500, timeout = 20 * 60_000, label = 'หน้าหยุดนิ่ง' } = {}) {
  return new Promise((resolve, reject) => {
    let timer
    const observer = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(finish, quietMs)
    })
    const hardStop = setTimeout(() => {
      observer.disconnect()
      reject(new Error(`รอ ${label} เกินเวลา`))
    }, timeout)
    function finish() {
      clearTimeout(hardStop)
      observer.disconnect()
      resolve(true)
    }
    observer.observe(el ?? document.body, { childList: true, subtree: true, characterData: true })
    timer = setTimeout(finish, quietMs)
  })
}

/**
 * พิมพ์ข้อความลงช่อง input — รองรับทั้ง textarea และ contenteditable
 * ใช้วิธี set ผ่าน native setter + ยิง input event เพื่อให้ React เห็นการเปลี่ยนแปลง
 */
async function typeInto(el, text) {
  el.focus()
  el.click()

  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    ).set
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else {
    // contenteditable — วางผ่าน clipboard event เพื่อให้ editor จัดการ newline เอง
    const data = new DataTransfer()
    data.setData('text/plain', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    await sleep(150)
    if (!el.textContent.trim()) {
      // บาง editor ไม่รับ paste event สังเคราะห์ → ใช้ execCommand เป็นทางสำรอง
      document.execCommand('insertText', false, text)
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
    }
  }
  await sleep(200)
  return el
}

async function pressEnter(el) {
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
  }
}

/** โหลดภาพจาก URL (รวม blob:) แล้วแปลงเป็น base64 เพื่อส่งผ่าน bridge */
async function urlToBase64(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`โหลดภาพไม่ได้: ${res.status}`)
  const buf = await res.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * ส่งข้อความถึง bridge ผ่าน service worker — ลองใหม่ถ้า worker กำลังถูกปลุก (Could not establish connection)
 * RESULT/PARTIAL ต้องได้ ok จริง ไม่งั้นโยน error ให้ผู้เรียกรู้
 */
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
  throw new Error(`ส่งผลกลับโปรแกรมในเครื่องไม่สำเร็จ: ${last}`)
}

/** heartbeat ทุก 20 วิระหว่างทำงานยาว — คืนฟังก์ชันหยุด */
function heartbeat(id) {
  const timer = setInterval(() => toBridge('PROGRESS', { id }, { tries: 1 }).catch(() => {}), 20_000)
  return () => clearInterval(timer)
}

/**
 * เครื่องมือ debug selector — เปิดหน้าเว็บแล้วพิมพ์ bridgeInspect() ใน console
 * จะบอกว่า selector ตัวไหนในไฟล์ selectors.js ยังใช้ได้อยู่บ้าง
 */
globalThis.bridgeInspect = function bridgeInspect(site) {
  const key = site ?? (location.host.includes('chatgpt') ? 'chatgpt' : 'flow')
  const table = []
  for (const [name, list] of Object.entries(SELECTORS[key])) {
    if (!Array.isArray(list)) continue
    const hit = list.find((sel) => {
      try {
        return document.querySelector(sel)
      } catch {
        return false
      }
    })
    table.push({ ชื่อ: name, ใช้ได้: hit ?? '❌ ไม่เจอสักตัว', จำนวนตัวเลือก: list.length })
  }
  console.table(table)
  return table
}

/** แนบรูปเข้าช่องพิมพ์ด้วย paste event — เหมือนผู้ใช้กด Ctrl+V รูป */
function pasteFiles(el, attachments) {
  const dt = new DataTransfer()
  for (const a of attachments ?? []) {
    const bytes = Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0))
    dt.items.add(new File([bytes], a.name, { type: a.type }))
  }
  if (!dt.files.length) return false
  el.focus()
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  return true
}

globalThis.bridgeHelpers = { waitFor, waitStable, typeInto, pressEnter, urlToBase64, sleep, toBridge, heartbeat, pasteFiles }
})()
