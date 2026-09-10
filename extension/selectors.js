/**
 * รวม selector ของทุกเว็บไว้ที่เดียว — เวลาเว็บเปลี่ยน DOM แก้แค่ไฟล์นี้ไฟล์เดียว
 *
 * แต่ละอันเป็น "รายการตัวเลือก" เรียงตามความน่าเชื่อถือ ตัวแรกที่เจอชนะ
 * อันที่อิง data-testid มาก่อน เพราะเปลี่ยนน้อยกว่า class ที่ build ใหม่ทุกครั้ง
 *
 * ⚠️ ยังไม่ได้ verify กับหน้าจริง — ต้องเปิดหน้าเว็บแล้วรัน `bridgeInspect()`
 *    ใน DevTools console เพื่อดูว่าตัวไหนใช้ได้ (ดู content-common.js)
 */
const SELECTORS = {
  chatgpt: {
    url: 'https://chatgpt.com/',
    newChat: ['a[data-testid="create-new-chat-button"]', 'button[aria-label*="New chat" i]', 'a[href="/"]'],
    input: ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea[data-id]'],
    send: ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]'],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
    // ข้อความตอบล่าสุด — ใช้ตอนดึงผลลัพธ์
    assistantTurns: ['[data-message-author-role="assistant"]', 'div[data-testid^="conversation-turn"]'],
    // ปุ่ม copy ของข้อความ ใช้เป็นสัญญาณว่า gen เสร็จแล้ว
    copyButton: ['button[data-testid="copy-turn-action-button"]', 'button[aria-label*="Copy" i]'],
  },

  flow: {
    url: 'https://labs.google/fx/tools/flow',
    newProject: ['button[aria-label*="New project" i]', 'button:has-text("New project")'],
    modeSelector: ['button[aria-label*="mode" i]', '[data-testid="mode-selector"]'],
    agentModeOption: ['[role="option"][data-value*="agent" i]', 'li:has-text("Agent")'],
    input: ['textarea', 'div[contenteditable="true"]'],
    send: ['button[type="submit"]', 'button[aria-label*="Generate" i]', 'button[aria-label*="Send" i]'],
    // ภาพที่ gen เสร็จ — เรียงตามลำดับใน DOM = ลำดับ shot
    resultImages: ['img[src^="blob:"]', 'img[src*="googleusercontent"]', '[data-testid="generated-image"] img'],
    // ตัวบอกว่ายังทำงานอยู่
    busy: ['[role="progressbar"]', '[aria-busy="true"]', '.loading-spinner'],
  },
}

/** หา element ตัวแรกที่เจอจากรายการ selector */
function pick(list, root = document) {
  for (const sel of list) {
    try {
      const el = root.querySelector(sel)
      if (el) return el
    } catch {
      // selector บางตัว (เช่น :has-text) ไม่ใช่ CSS มาตรฐาน — ข้ามไป
    }
  }
  return null
}

function pickAll(list, root = document) {
  for (const sel of list) {
    try {
      const els = [...root.querySelectorAll(sel)]
      if (els.length) return els
    } catch {}
  }
  return []
}

globalThis.SELECTORS = SELECTORS
globalThis.pick = pick
globalThis.pickAll = pickAll
