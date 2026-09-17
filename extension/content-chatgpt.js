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

async function startNewChat() {
  const btn = pick(S.newChat)
  if (btn) {
    btn.click()
    await sleep(1200)
    return
  }
  // ไม่เจอปุ่ม → ไปหน้าแรกตรงๆ (SPA จะ reset เป็น chat ใหม่เอง)
  if (location.pathname !== '/') {
    location.href = 'https://chatgpt.com/'
    await sleep(3000)
  }
}

async function runPrompt(prompt, { newChat = true, attachments = [] } = {}) {
  if (newChat) await startNewChat()

  const input = await waitFor(() => pick(S.input), { label: 'ช่องพิมพ์ของ ChatGPT' })
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
  await typeInto(input, prompt)

  // prompt ยาว ChatGPT แปลงเป็นไฟล์แนบ — รอจนปุ่มส่งพร้อม (แนบเสร็จ) ก่อนกด Enter
  await waitFor(() => {
    const btn = pick(S.send)
    return btn && !btn.disabled
  }, { timeout: 30_000, label: 'ปุ่มส่งของ ChatGPT พร้อม' }).catch(() => null)
  guard()
  await sleep(500)

  // กด Enter เสมอ — ถ้ายังไม่ส่ง (ไม่มีปุ่ม stop / คำตอบใหม่) ให้กดซ้ำ
  const turnsBefore = pickAll(S.assistantTurns).length
  const started = () => pick(S.stop) || pickAll(S.assistantTurns).length > turnsBefore
  let sent = false
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    const box = pick(S.input) ?? input
    box.focus()
    await pressEnter(box)
    sent = await waitFor(started, { timeout: 5000, label: 'ChatGPT รับข้อความ' }).then(() => true, () => false)
  }
  guard()
  if (!sent) throw new Error('กด Enter แล้ว ChatGPT ไม่ส่งข้อความ')

  // รอให้ตอบจบ — ห้ามดูแค่ "ปุ่ม stop หาย": โหมดคิดนาน (High) ปุ่มนั้นไม่ตรง selector เสมอ
  // ทำให้เคยดึงคำตอบกลางคัน (ได้แค่ "=== SHOT LIST === 00_01_33")
  // สัญญาณที่เชื่อได้ (ตรวจกับหน้าจริงแล้ว): ปุ่ม "Copy response" โผล่ใต้คำตอบเมื่อพิมพ์เสร็จเท่านั้น + ข้อความนิ่ง
  let lastText = ''
  let stableSince = Date.now()
  await waitFor(
    () => {
      const turns = pickAll(S.assistantTurns)
      const last = turns.length > turnsBefore ? turns.at(-1) : null
      const current = last?.innerText ?? ''
      if (current !== lastText) {
        lastText = current
        stableSince = Date.now()
      }
      const turn = last?.closest('article, [data-testid^="conversation-turn"]')
      const finished = !!turn && !!pick(S.copyButton, turn) && !pick(S.stop)
      return finished && current.trim() && Date.now() - stableSince >= 2000
    },
    { timeout: 30 * 60_000, interval: 1000, label: 'ChatGPT ตอบจบ' },
  )

  const turns = pickAll(S.assistantTurns)
  if (!turns.length) throw new Error('ไม่พบข้อความตอบกลับ — selector assistantTurns อาจเปลี่ยน')
  const text = turns.at(-1).innerText.trim()
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
    const stopBeat = heartbeat(job.id)
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
