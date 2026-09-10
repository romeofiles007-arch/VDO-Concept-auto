/**
 * ขับ ChatGPT — ข้อ 1 ของสเปก: new chat → วาง prompt → enter → ดึงคำตอบกลับ
 *
 * งานที่รับ: { kind: 'prompt', payload: { prompt, newChat } }
 * ตอบกลับ: { text } ให้ฝั่ง pipeline เอาไปเขียนเป็นไฟล์เอง
 */
const { waitFor, typeInto, pressEnter, sleep, toBridge } = bridgeHelpers
const S = SELECTORS.chatgpt

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

async function runPrompt(prompt, { newChat = true } = {}) {
  if (newChat) await startNewChat()

  const input = await waitFor(() => pick(S.input), { label: 'ช่องพิมพ์ของ ChatGPT' })
  await typeInto(input, prompt)

  const send = pick(S.send)
  if (send && !send.disabled) send.click()
  else await pressEnter(input)

  // รอให้เริ่มตอบก่อน (ปุ่ม stop โผล่) แล้วค่อยรอให้ตอบจบ (ปุ่ม stop หาย)
  await sleep(1000)
  await waitFor(() => pick(S.stop) || pickAll(S.assistantTurns).length, { timeout: 60_000, label: 'ChatGPT เริ่มตอบ' })
  await waitFor(() => !pick(S.stop), { timeout: 15 * 60_000, interval: 1000, label: 'ChatGPT ตอบจบ' })
  await sleep(1500) // เผื่อ render ตัวอักษรท้ายๆ

  const turns = pickAll(S.assistantTurns)
  if (!turns.length) throw new Error('ไม่พบข้อความตอบกลับ — selector assistantTurns อาจเปลี่ยน')
  const text = turns.at(-1).innerText.trim()
  if (!text) throw new Error('ข้อความตอบกลับว่าง')
  return text
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'RUN_JOB') return
  const { job } = msg
  ;(async () => {
    try {
      if (job.kind !== 'prompt') throw new Error(`ChatGPT ไม่รู้จักงาน: ${job.kind}`)
      const text = await runPrompt(job.payload.prompt, job.payload)
      await toBridge('RESULT', { id: job.id, text })
      sendResponse({ ok: true })
    } catch (err) {
      sendResponse({ ok: false, error: String(err.message) })
    }
  })()
  return true // ตอบแบบ async
})
