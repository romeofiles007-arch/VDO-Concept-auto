/**
 * ขับ Google Flow — ข้อ 5-7 ของสเปก
 *
 * งานที่รับ: {
 *   kind: 'generate-images',
 *   payload: {
 *     prompt,            // ข้อความนำ + AGENT BRIEF + SHOT LIST ทั้งก้อน
 *     shots: [{ filename }],  // ลำดับต้องตรงกับลำดับ shot ใน prompt
 *     newProject, agentMode, askAgentToRename
 *   }
 * }
 *
 * เรื่องชื่อไฟล์: เราตั้งชื่อเองจากลำดับ shot ตอนเซฟ (ภาพใบที่ n → shots[n].filename)
 * จึงไม่ต้องขอให้ agent เปลี่ยนชื่อก่อนโหลด ซึ่งเป็นขั้นที่พังง่ายที่สุดในสเปกเดิม
 * ถ้าอยากได้ชื่อถูกฝั่ง Flow ด้วย เปิด askAgentToRename ใน config
 */
const { waitFor, typeInto, pressEnter, urlToBase64, sleep, toBridge } = bridgeHelpers
const S = SELECTORS.flow

const BATCH = 4 // ส่งกลับทีละ 4 ใบ กัน payload ใหญ่เกิน

async function startNewProject() {
  const btn = pick(S.newProject)
  if (!btn) throw new Error('ไม่พบปุ่ม New project — selector อาจเปลี่ยน (รัน bridgeInspect() ดู)')
  btn.click()
  await sleep(2500)
}

async function selectAgentMode() {
  const selector = pick(S.modeSelector)
  if (!selector) return false // บาง layout เป็น agent อยู่แล้ว ไม่มีตัวเลือกให้กด
  selector.click()
  await sleep(800)
  const option = pick(S.agentModeOption)
  if (!option) throw new Error('ไม่พบตัวเลือกโหมด Agent')
  option.click()
  await sleep(800)
  return true
}

async function submitPrompt(prompt) {
  const input = await waitFor(() => pick(S.input), { label: 'ช่องพิมพ์ของ Flow' })
  await typeInto(input, prompt)
  await sleep(500)
  const send = pick(S.send)
  if (send && !send.disabled) send.click()
  else await pressEnter(input)
}

/** รอจนจำนวนภาพหยุดเพิ่มและตัวบอกสถานะทำงานหายไป */
async function waitForImages(expected, { id }) {
  let lastCount = 0
  let stableRounds = 0
  const deadline = Date.now() + 45 * 60_000 // agent batch 30-40 ใบใช้เวลานาน

  while (Date.now() < deadline) {
    await sleep(5000)
    const count = pickAll(S.resultImages).length
    if (count !== lastCount) {
      lastCount = count
      stableRounds = 0
      await toBridge('PROGRESS', { id, progress: { done: count, total: expected } })
    } else if (count > 0 && !pick(S.busy)) {
      stableRounds++
      // นิ่ง 3 รอบ (15 วิ) และไม่มี spinner → ถือว่าจบ
      if (stableRounds >= 3) return pickAll(S.resultImages)
    }
    if (count >= expected && !pick(S.busy)) return pickAll(S.resultImages)
  }
  throw new Error(`รอภาพเกินเวลา — ได้ ${lastCount}/${expected} ใบ`)
}

async function generateImages(payload, jobId) {
  const { prompt, shots, newProject = true, agentMode = true, askAgentToRename = false } = payload

  if (newProject) await startNewProject()
  if (agentMode) await selectAgentMode()
  await submitPrompt(prompt)

  const imgs = await waitForImages(shots.length, { id: jobId })

  if (imgs.length !== shots.length) {
    // ไม่ throw — เก็บเท่าที่ได้ไว้ก่อน ดีกว่าทิ้งงานที่ agent ใช้เวลาเป็นสิบนาที
    console.warn(`[bridge] ได้ภาพ ${imgs.length} ใบ แต่สั่งไป ${shots.length} ช็อต`)
  }

  if (askAgentToRename) {
    await submitPrompt(
      'เปลี่ยนชื่อ แต่ละ shot ให้ตรงตาม prompt ที่ส่งให้ เช่น\n\n' +
        '00_00_00.png SHOT 01 | Chars: @you | Env: white background | Action: ... | Frame: wide\n\n' +
        'ก็แก้ชื่อเป็น 00_00_00.png SHOT 01',
    )
    await sleep(15_000)
  }

  // ส่งกลับทีละชุด — ตั้งชื่อตามลำดับ shot ไม่ใช่ตามชื่อที่ Flow ตั้งให้
  let sent = 0
  for (let i = 0; i < imgs.length; i += BATCH) {
    const slice = imgs.slice(i, i + BATCH)
    const files = []
    for (let k = 0; k < slice.length; k++) {
      const shot = shots[i + k]
      if (!shot) break
      files.push({ name: shot.filename, base64: await urlToBase64(slice[k].src) })
    }
    if (!files.length) continue
    const isLast = i + BATCH >= imgs.length
    if (isLast) await toBridge('RESULT', { id: jobId, files, meta: { generated: imgs.length, expected: shots.length } })
    else await toBridge('PARTIAL', { id: jobId, files })
    sent += files.length
  }
  if (!sent) throw new Error('ไม่มีภาพส่งกลับเลย')
  return sent
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'RUN_JOB') return
  const { job } = msg
  ;(async () => {
    try {
      if (job.kind !== 'generate-images') throw new Error(`Flow ไม่รู้จักงาน: ${job.kind}`)
      await generateImages(job.payload, job.id)
      sendResponse({ ok: true })
    } catch (err) {
      sendResponse({ ok: false, error: String(err.message) })
    }
  })()
  return true
})
