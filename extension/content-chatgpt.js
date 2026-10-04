(() => {
if (globalThis.__cartoon_content_chatgpt) return // ฉีดซ้ำ → ไม่เพิ่ม listener ซ้ำ
globalThis.__cartoon_content_chatgpt = true

/**
 * ขับ ChatGPT — ข้อ 1 ของสเปก: new chat → วาง prompt → enter → ดึงคำตอบกลับ
 *
 * งานที่รับ: { kind: 'prompt', payload: { prompt, newChat } }
 * ตอบกลับ: { text } ให้ฝั่ง pipeline เอาไปเขียนเป็นไฟล์เอง
 */
const { typeInto, pressEnter, toBridge, heartbeat, pasteFiles } = bridgeHelpers
const S = SELECTORS.chatgpt

// ปุ่มหยุดในแผงข้าง → ตั้งธง stopped ให้ทุกจุดที่รออยู่เลิกรอทันที
let stopped = false
const guard = () => {
  if (stopped) throw new Error('หยุดแล้ว')
}
const waitFor = (fn, opts) => bridgeHelpers.waitFor(() => (guard(), fn()), opts)
const sleep = async (ms) => {
  await bridgeHelpers.sleep(ms)
  guard()
}

/**
 * เปิดแชตใหม่แล้วรอจนหน้าว่างจริง — SPA ลบแชตเก่าออกช้าได้หลายวินาที ถ้านับคำตอบตอนแชตเก่ายังค้าง
 * คำตอบใหม่ (ใบที่ 1) จะเท่ากับจำนวนเดิม → ไม่เคยรู้ว่าตอบจบ ค้างรอ 30 นาที (เจอจริง ก.ย. 2026)
 */
async function startNewChat() {
  const empty = () => location.pathname === '/' && !assistantTurns().length && pick(S.input)
  // service worker โหลดหน้าแรกให้ก่อนส่งงานแล้ว — หน้าว่างอยู่แล้วก็ไม่ต้องกดอะไร
  if (await waitFor(empty, { timeout: 8000, label: 'หน้าแชตใหม่' }).then(() => true, () => false)) return sleep(500)
  for (let attempt = 0; attempt < 2; attempt++) {
    // เจาะจงปุ่มที่มองเห็น — ในแถบข้างมีปุ่ม "New chat in <โปรเจกต์>" ซ่อนอยู่หลายปุ่ม กดผิดจะไปเปิดแชตในโปรเจกต์อื่น
    const btn = [...document.querySelectorAll('a[data-testid="create-new-chat-button"], button[aria-label="New chat" i]')].find((b) => b.offsetParent) ?? pick(S.newChat)
    if (btn) btn.click()
    else if (location.pathname !== '/') {
      // ไม่เจอปุ่ม → ไปหน้าแรกตรงๆ (SPA จะ reset เป็น chat ใหม่เอง)
      location.href = 'https://chatgpt.com/'
      await sleep(3000)
    }
    if (await waitFor(empty, { timeout: 10_000, label: 'แชตใหม่' }).then(() => true, () => false)) return sleep(500)
  }
  throw new Error('เปิดแชตใหม่ใน ChatGPT ไม่สำเร็จ — แชตเก่ายังค้างอยู่บนหน้า')
}

/**
 * ล้างช่องพิมพ์ก่อนวางงาน — ChatGPT จำไฟล์/รูปที่แนบค้างไว้ในช่องพิมพ์ข้ามการกด New chat ได้
 * (เคยมีรูปจากงานอื่นติดไปกับ prompt กำกับภาพ) และข้อความร่างที่ค้างอยู่ก็จะไปปนกับ prompt
 */
/**
 * อ่านบทสนทนา — รองรับ DOM สองรุ่น
 * รุ่นเก่า: กล่องข้อความมี [data-message-author-role] · ปุ่ม copy อยู่ใน article / conversation-turn
 * รุ่นใหม่ (ตรวจกับหน้าจริง ต.ค. 2026): ไม่มี attribute นั้นแล้ว คำตอบอยู่ในกล่องที่ครอบหัว sr-only
 *   h4[data-conversation-role="assistant"] ("ChatGPT said:") · แถบปุ่มใต้คำตอบ (.turn-action-controls) เป็นลูกตรงของกล่องกลุ่มที่ครอบทั้งคำถาม-คำตอบ
 *   ข้อความของผู้ใช้ก็มีปุ่ม Copy ของตัวเองอยู่ลึกลงไป — จึงต้องเจาะจงลูกตรงเท่านั้น ไม่งั้นเข้าใจว่าตอบจบตั้งแต่ยังไม่เริ่มพิมพ์
 */
const NEW_HEAD = 'h4[data-conversation-role="assistant"]'
const assistantTurns = () => {
  const old = pickAll(S.assistantTurns)
  return old.length ? old : [...document.querySelectorAll(NEW_HEAD)].map((h) => h.parentElement)
}
const userTurns = () => [...document.querySelectorAll('[data-message-author-role="user"], [data-user-message-bubble]')]
// คำตอบที่อ้างไฟล์แนบของ prompt ยาวจะมีป้าย "Pasted text" แทรกท้ายประโยค — ไม่ใช่เนื้อคำตอบ
const CITATION = /[ \t]*Pasted text(?:\([\d-]+\))?(?:\.txt)?/g
function turnText(turn) {
  let text = turn?.innerText ?? ''
  const head = turn?.querySelector(`:scope > ${NEW_HEAD}`)?.innerText
  if (head && text.startsWith(head)) text = text.slice(head.length)
  return text.replace(CITATION, '').trim()
}
function turnFinished(turn) {
  const old = turn.closest('article, [data-testid^="conversation-turn"]')
  if (old) return !!pick(S.copyButton, old)
  // กล่องกลุ่มอยู่เหนือคำตอบ 2-3 ชั้น (แต่ละบทสนทนาไม่เท่ากัน) — ไล่ขึ้นไปหาชั้นที่มีแถบปุ่มเป็นลูกตรง
  for (let el = turn.parentElement, i = 0; el && i < 5; el = el.parentElement, i++) {
    if (el.querySelector(':scope > [class*="turn-action-controls"] button[aria-label^="Copy" i]')) return true
  }
  return false
}

// ป้ายปุ่มลบไฟล์แนบเป็น "Remove <ชื่อไฟล์>" (เช่น Remove Pasted text.txt) — เดิมหา "Remove file" จึงไม่เจอ ไฟล์จากรอบที่ล้มค้างสะสม
const REMOVE = 'button[aria-label^="Remove" i]'
/** ของที่อยู่ในช่องพิมพ์ตอนนี้ — prompt ยาว ChatGPT แปลงเป็นไฟล์แนบ ช่องพิมพ์จึงว่างได้ทั้งที่วางสำเร็จ */
function composerState() {
  const input = pick(S.input)
  return { chars: input?.textContent.trim().length ?? 0, files: (input?.closest('form') ?? document).querySelectorAll(REMOVE).length }
}

/**
 * วาง prompt ลงช่องพิมพ์แล้วตรวจว่าลงจริง (เป็นข้อความ หรือเป็นไฟล์แนบเพิ่มขึ้น)
 * วางจากฝั่งหน้าเว็บก่อน (ผ่าน service worker) ไม่ลงค่อยใช้ typeInto ของ content script
 */
async function fillPrompt(input, prompt) {
  const before = composerState().files
  const filled = () => {
    const s = composerState()
    return s.chars > 0 || s.files > before
  }
  const landed = () => waitFor(filled, { timeout: 5000, interval: 200, label: 'prompt ลงช่องพิมพ์' }).then(() => true, () => false)
  input.focus()
  input.click()
  await chrome.runtime.sendMessage({ type: 'CHATGPT_PASTE', text: prompt, selectors: S.input }).catch(() => null)
  if (await landed()) return
  await typeInto(pick(S.input) ?? input, prompt)
  if (await landed()) return
  throw new Error('วาง prompt ลงช่องพิมพ์ของ ChatGPT ไม่ได้ — ช่องพิมพ์ยังว่างอยู่ · กด F5 ที่แท็บ ChatGPT แล้วสั่งใหม่')
}

async function clearComposer(input) {
  const form = input.closest('form') ?? document
  for (let i = 0; i < 20; i++) {
    const remove = form.querySelector(REMOVE)
    if (!remove) break
    remove.click()
    await sleep(300)
  }
  if (input.isContentEditable ? input.innerText.trim() : input.value) {
    input.focus()
    document.execCommand('selectAll')
    document.execCommand('delete')
    await sleep(200)
  }
  const left = form.querySelectorAll(REMOVE).length
  if (left) throw new Error(`ช่องพิมพ์ของ ChatGPT มีไฟล์แนบค้างอยู่ ${left} ไฟล์ที่เอาออกไม่ได้ — ลบในแท็บ ChatGPT เองแล้วสั่งใหม่`)
}

async function runPrompt(prompt, { newChat = true, attachments = [] } = {}) {
  if (newChat) await startNewChat()

  const input = await waitFor(() => pick(S.input), { label: 'ช่องพิมพ์ของ ChatGPT' })
  await clearComposer(input)
  // รูปตัวละคร: วางรูปก่อน แล้วรอให้ขึ้นเป็นไฟล์แนบ (ปุ่มส่งจะรอจนอัปโหลดเสร็จอีกชั้น)
  if (attachments.length) {
    const before = document.querySelectorAll('form img[src^="blob:"], form img[src^="https:"]').length
    pasteFiles(input, attachments)
    await waitFor(() => document.querySelectorAll('form img[src^="blob:"], form img[src^="https:"]').length >= before + attachments.length, {
      timeout: 30_000,
      label: 'ChatGPT รับรูปตัวละคร',
    }).catch(() => null)
    await sleep(1500)
  }
  await fillPrompt(input, prompt)

  // prompt ยาว ChatGPT แปลงเป็นไฟล์แนบ — รอจนปุ่มส่งพร้อม (แนบเสร็จ) ก่อนกด Enter
  await waitFor(() => {
    const btn = pick(S.send)
    return btn && !btn.disabled
  }, { timeout: 60_000, label: 'ปุ่มส่งของ ChatGPT พร้อม' }).catch(() => null)
  guard()
  await sleep(500)

  // ส่งแล้ว = ข้อความของเราขึ้นในแชต (หรือหน้าเปลี่ยนเป็น /c/...) — โหมดคิดนาน (High) ปุ่ม stop/คำตอบโผล่ช้า
  // ดูแค่สองอย่างนั้นเคยเข้าใจผิดว่ายังไม่ส่ง แล้วฟ้อง "กด Enter แล้วไม่ส่ง" ทั้งที่ส่งไปแล้ว
  // จำ element ของข้อความเดิมไว้ — คำตอบใหม่ = element ที่ไม่อยู่ในชุดนี้ (นับจำนวนพลาดได้ตอนแชตเก่ายังไม่หาย)
  const oldTurns = new Set(assistantTurns())
  const oldUsers = new Set(userTurns())
  const newTurns = () => assistantTurns().filter((t) => !oldTurns.has(t))
  const pathBefore = location.pathname
  const started = () =>
    pick(S.stop) ||
    newTurns().length ||
    userTurns().some((u) => !oldUsers.has(u)) ||
    (location.pathname !== pathBefore && location.pathname.startsWith('/c/'))
  let sent = false
  // สลับวิธี: Enter → คลิกปุ่มส่ง → Enter — ChatGPT บางจังหวะไม่รับ Enter ที่จำลองขึ้น
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    const box = pick(S.input) ?? input
    const sendBtn = pick(S.send)
    if (attempt === 1 && sendBtn && !sendBtn.disabled) sendBtn.click()
    else {
      box.focus()
      await pressEnter(box)
    }
    sent = await waitFor(started, { timeout: 8000, label: 'ChatGPT รับข้อความ' }).then(() => true, () => false)
  }
  guard()
  if (!sent) {
    const btn = pick(S.send)
    const why = !btn ? 'ไม่เจอปุ่มส่ง' : btn.disabled ? 'ปุ่มส่งกดไม่ได้ (ไฟล์แนบยังอัปโหลดไม่เสร็จ หรือมีหน้าต่างแจ้งเตือนบังอยู่)' : 'ChatGPT ไม่ตอบสนอง'
    const { chars, files } = composerState()
    throw new Error(`ส่งข้อความไป ChatGPT ไม่สำเร็จ — ${why} [ช่องพิมพ์: ${chars} ตัวอักษร, ไฟล์แนบ ${files}] · ดูที่แท็บ ChatGPT แล้วสั่งใหม่`)
  }

  // รอให้ตอบจบ — ห้ามดูแค่ "ปุ่ม stop หาย": โหมดคิดนาน (High) ปุ่มนั้นไม่ตรง selector เสมอ
  // ทำให้เคยดึงคำตอบกลางคัน (ได้แค่ "=== SHOT LIST === 00_01_33")
  // สัญญาณที่เชื่อได้ (ตรวจกับหน้าจริงแล้ว): ปุ่ม "Copy response" โผล่ใต้คำตอบเมื่อพิมพ์เสร็จเท่านั้น + ข้อความนิ่ง
  // โหมดคิดนานพิมพ์เป็นช่วงๆ เว้นได้เกิน 2 วิ → เคยดึงไปก่อนท่อนสุดท้าย (บทขาด "…พัฒนาเ" เสียงท้ายคลิปขาด)
  // จึงต้องนิ่ง 5 วิ · ปุ่ม stop โผล่ = นับใหม่ · ผ่านแล้วรออีก 1.5 วิเช็คซ้ำว่าไม่มีข้อความเพิ่ม
  const STABLE_MS = 5000
  let lastText = ''
  let stableSince = Date.now()
  const lastTurnText = () => turnText(newTurns().at(-1))
  for (;;) {
    await waitFor(
      () => {
        const last = newTurns().at(-1) ?? null
        const current = turnText(last)
        if (current !== lastText || pick(S.stop)) {
          lastText = current
          stableSince = Date.now()
        }
        const finished = !!last && turnFinished(last) && !pick(S.stop)
        return finished && current && Date.now() - stableSince >= STABLE_MS
      },
      { timeout: 30 * 60_000, interval: 1000, label: 'ChatGPT ตอบจบ' },
    )
    await sleep(1500)
    if (lastTurnText() === lastText && !pick(S.stop)) break
    stableSince = Date.now() // ยังพิมพ์ต่อ → รอรอบใหม่
  }

  const turns = newTurns()
  if (!turns.length) throw new Error('ไม่พบข้อความตอบกลับ — selector assistantTurns อาจเปลี่ยน')
  const text = turnText(turns.at(-1))
  if (!text) throw new Error('ข้อความตอบกลับว่าง')
  return text
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // หน้าตรวจความพร้อม: ChatGPT ใช้แบบไม่ล็อกอินได้ แต่โควตาน้อยและตอบยาวไม่ได้ → ถือว่ายังไม่พร้อม
  if (msg.type === 'PING') {
    const loginButton = document.querySelector('[data-testid="login-button"], a[href*="/auth/login"]')
    const input = pick(S.input)
    sendResponse({ ok: true, loggedIn: loginButton ? false : input ? true : null, url: location.href })
    return
  }
  // แผงข้างสั่งตรง — ส่ง prompt แล้วคืนคำตอบให้แผงเลย ไม่ผ่านโปรแกรมในเครื่อง
  if (msg.type === 'STOP') {
    stopped = true
    pick(S.stop)?.click() // สั่ง ChatGPT หยุดพิมพ์คำตอบด้วย
    sendResponse({ ok: true })
    return
  }
  if (msg.type === 'ASK') {
    stopped = false
    runPrompt(msg.prompt, { newChat: msg.newChat ?? true, attachments: msg.attachments ?? [] })
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message) }))
    return true
  }
  if (msg.type !== 'RUN_JOB') return
  const { job } = msg
  stopped = false
  ;(async () => {
    const stopBeat = heartbeat(job.id, () => {
      stopped = true // pipeline ไม่รอแล้ว → เลิกรอคำตอบ ปล่อยแท็บให้งานถัดไป
      pick(S.stop)?.click()
    })
    try {
      if (job.kind !== 'prompt') throw new Error(`ChatGPT ไม่รู้จักงาน: ${job.kind}`)
      const text = await runPrompt(job.payload.prompt, job.payload)
      // ส่งผลเองผ่าน RESULT (ลองซ้ำจนได้) — ไม่พึ่ง sendResponse เพราะ service worker อาจถูกปิดไปแล้วระหว่างรอ
      await toBridge('RESULT', { id: job.id, text })
      sendResponse({ ok: true })
    } catch (err) {
      await toBridge('ERROR', { id: job.id, message: String(err.message) }).catch(() => {})
      sendResponse({ ok: true, reported: true })
    } finally {
      stopBeat()
    }
  })()
  return true // ตอบแบบ async
})
})()
