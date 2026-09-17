/**
 * Service worker — วนรับงานจาก bridge แล้วส่งต่อให้ content script ของเว็บที่เกี่ยวข้อง
 *
 * ข้อควรระวังของ MV3: service worker ถูกฆ่าเมื่อ idle ~30 วิ
 * จึงตั้ง alarm ทุก 1 นาทีมาปลุกให้ poll ใหม่ และ long-poll ฝั่ง bridge ตั้งไว้ 25 วิ
 * เพื่อให้จบก่อนถูกฆ่า
 */

const NATIVE_HOST = 'com.cartoon_auto.bridge'

const AGENTS = {
  chatgpt: { match: 'https://chatgpt.com/', pattern: ['https://chatgpt.com/*', 'https://chat.openai.com/*'], key: 'chatTabId' },
  // Google Flow ย้ายจาก labs.google/fx/tools/flow มาที่ flow.google.com แล้ว
  flow: { match: 'https://flow.google.com/', pattern: 'https://flow.google.com/*', key: 'flowTabId' },
}

async function settings() {
  const { port = 8765, token = '', enabled = false } = await chrome.storage.local.get(['port', 'token', 'enabled'])
  return { base: `http://127.0.0.1:${port}`, token, enabled }
}

async function post(path, body) {
  const { base, token } = await settings()
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': token },
    body: JSON.stringify(body),
  })
}

/** ส่งผลลัพธ์ให้ bridge จนกว่าจะรับจริง — bridge อาจกำลังเปิดใหม่ หรือเน็ตในเครื่องสะดุดชั่วครู่ */
async function postReliable(path, body, { tries = 8 } = {}) {
  let lastError = ''
  for (let i = 0; i < tries; i++) {
    try {
      const res = await post(path, body)
      if (res.ok) return { ok: true }
      lastError = `bridge ตอบ ${res.status}: ${await res.text()}`
      if (res.status === 400 || res.status === 404) break // ส่งซ้ำก็ไม่ผ่าน
    } catch (err) {
      lastError = String(err?.message ?? err)
    }
    await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** i)))
  }
  return { ok: false, error: lastError }
}

async function setStatus(text) {
  await chrome.storage.local.set({ status: text, statusAt: Date.now() })
}

/**
 * หา tab ของเว็บเป้าหมาย — ใช้แท็บที่เปิดอยู่แล้วเสมอ (แท็บเดียวกับที่แผงข้างใช้) มีไม่มีจริงๆ ค่อยเปิดใหม่
 * เลขแท็บเก็บใน storage.session ร่วมกับแผงข้าง (chatTabId / flowTabId)
 */
const opening = {} // agent → Promise ระหว่างเปิดแท็บใหม่ กันเปิดซ้อนสองแท็บ
async function ensureTab(agent) {
  const { pattern, match, key } = AGENTS[agent]
  const tabs = await chrome.tabs.query({ url: pattern })
  const { [key]: savedId } = await chrome.storage.session.get(key)
  const existing = tabs.find((t) => t.id === savedId) ?? tabs.find((t) => !t.discarded) ?? tabs[0]
  if (existing) {
    if (existing.id !== savedId) await chrome.storage.session.set({ [key]: existing.id })
    return existing
  }
  if (opening[agent]) return opening[agent]
  opening[agent] = openTab(match, key).finally(() => delete opening[agent])
  return opening[agent]
}

async function openTab(match, key) {
  const tab = await chrome.tabs.create({ url: match, active: false })
  await chrome.storage.session.set({ [key]: tab.id })
  await new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(resolve, 30_000)
  })
  await new Promise((r) => setTimeout(r, 2000)) // เผื่อ SPA render ต่ออีกนิด
  return tab
}

async function handleJob(job) {
  await setStatus(`กำลังทำ ${job.kind}`)
  const tab = await ensureTab(job.payload.agent ?? jobAgent(job))
  const agent = job.payload.agent ?? jobAgent(job)

  // Flow: เริ่มจากหน้าแรกทุกครั้ง → content script กด New project ได้ project ใหม่ต่อคลิป
  if (agent === 'flow' && job.kind === 'generate-images') {
    // คลิปนี้เคยมี project ใน Flow แล้ว → กลับไป project เดิม (ตัวละครเดิม ไม่เปิด project ใหม่ทุกครั้งที่ลองซ้ำ)
    const url = /^https:\/\/flow\.google\.com\/project\//.test(job.payload.projectUrl ?? '') ? job.payload.projectUrl : AGENTS.flow.match
    await chrome.tabs.update(tab.id, { url, active: true })
    await new Promise((resolve) => {
      const listener = (id, info) => {
        if (id === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener)
          resolve()
        }
      }
      chrome.tabs.onUpdated.addListener(listener)
      setTimeout(resolve, 30_000)
    })
    await new Promise((r) => setTimeout(r, 3000))
  }

  const response = await chrome.tabs.sendMessage(tab.id, { type: 'RUN_JOB', job }).catch(async (err) => {
    // content script ยังไม่ถูกฉีด (เช่นเปิดหน้าค้างไว้ตั้งแต่ก่อนติดตั้ง) → ฉีดเองแล้วลองใหม่
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: agent === 'flow' ? ['content-flow-agent.js'] : ['selectors.js', 'content-common.js', 'content-chatgpt.js'],
    })
    return chrome.tabs.sendMessage(tab.id, { type: 'RUN_JOB', job })
  })

  if (response?.ok) {
    await setStatus(`เสร็จ ${job.kind}`)
  } else if (response) {
    await postReliable('/error', { id: job.id, message: response.error ?? 'ไม่มีคำตอบจาก content script' })
    await setStatus(`ล้มเหลว: ${response.error ?? 'ไม่ทราบสาเหตุ'}`)
  }
  // ไม่มี response = service worker ถูกปลุกใหม่ระหว่างรอ — content script ยังทำงานต่อและส่งผลเอง
}

function jobAgent(job) {
  return job.agent ?? 'chatgpt'
}

/**
 * แต่ละเว็บ (ChatGPT / Flow) มีคิวของตัวเอง — งาน Flow ที่ใช้ 30 นาทีต้องไม่บังงาน ChatGPT
 * และห้ามรับงานใหม่ของเว็บเดียวกันจนกว่างานเดิมจะจบ (ใช้แท็บเดียวกัน)
 */
const busy = new Set()
let polling = false
async function pollLoop() {
  if (polling) return
  polling = true
  try {
    for (;;) {
      const { base, token, enabled } = await settings()
      if (!enabled || !token) {
        await setStatus('ปิดอยู่')
        return
      }
      const free = Object.keys(AGENTS).filter((a) => !busy.has(a))
      if (!free.length) {
        await new Promise((r) => setTimeout(r, 5000))
        continue
      }
      const results = await Promise.all(
        free.map(async (agent) => {
          try {
            const res = await fetch(`${base}/job?agent=${agent}`, { headers: { 'x-bridge-token': token } })
            if (res.status === 401) return 'auth'
            if (res.status !== 200) return 'idle'
            const job = await res.json()
            busy.add(agent)
            handleJob({ ...job, agent })
              .catch((err) => postReliable('/error', { id: job.id, message: String(err?.message ?? err) }))
              .finally(() => busy.delete(agent))
            return 'job'
          } catch {
            return 'offline'
          }
        }),
      )
      if (results.includes('auth')) {
        await setStatus('token ไม่ตรงกับ .env')
        return
      }
      if (results.every((r) => r === 'offline')) {
        await setStatus('ต่อ bridge ไม่ได้ — รัน node bridge/server.js หรือยัง')
        await new Promise((r) => setTimeout(r, 5000))
      } else if (!results.includes('job') && !busy.size) {
        await setStatus('รองาน...')
      }
    }
  } finally {
    polling = false
  }
}

/**
 * แผงข้างเปิดมาแล้วพร้อมใช้: ให้ native host เปิด bridge (ถ้ายังไม่เปิด) และส่ง token มา
 * ตั้งค่าเองทั้งหมด — ผู้ใช้ไม่ต้องคัดลอกรหัสหรือรันไฟล์ใดๆ
 */
async function ensureApp() {
  let info
  try {
    info = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'ensure' })
  } catch (err) {
    const notInstalled = /not found|forbidden/i.test(String(err?.message))
    return {
      ok: false,
      error: notInstalled
        ? 'ยังไม่ได้ติดตั้ง — ดับเบิลคลิก ติดตั้งครั้งแรก.bat ในโฟลเดอร์โปรเจกต์ แล้วปิดเปิด Chrome ใหม่'
        : `ติดต่อโปรแกรมไม่ได้: ${err?.message ?? err}`,
    }
  }
  if (!info?.ok) return { ok: false, error: info?.error ?? 'เปิดโปรแกรมไม่สำเร็จ' }

  await chrome.storage.local.set({ port: info.port, token: info.token, enabled: true })
  pollLoop()
  return { ok: true, url: info.url, token: info.token }
}

/**
 * ทำคลิปอัตโนมัติจบ (สำเร็จหรือหยุดกลางทาง) → แจ้งเตือนบนเครื่อง แม้ปิดแผงข้างไปแล้ว
 * เช็กทุกนาทีพร้อม alarm ที่ปลุก service worker อยู่แล้ว
 */
async function checkAutopilot() {
  const { base, token, enabled } = await settings()
  if (!enabled || !token) return
  const a = await fetch(`${base}/api/autopilot`, { headers: { 'x-bridge-token': token } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  const st = a?.status
  // ตัวเลข % บนไอคอน extension
  const running = a?.run?.status === 'running' || st?.status === 'running'
  const badge = running ? `${a?.progress?.percent ?? 0}%` : st?.status === 'done' && Date.now() - st.updatedAt < 30 * 60_000 ? '✓' : ['failed', 'error'].includes(st?.status) ? '!' : ''
  chrome.action.setBadgeText({ text: badge }).catch(() => {})
  if (badge) chrome.action.setBadgeBackgroundColor({ color: running ? '#0a7488' : st?.status === 'done' ? '#2b7552' : '#b8432a' }).catch(() => {})
  if (!st || !['done', 'failed'].includes(st.status)) return
  const key = `${st.slug}:${st.updatedAt}`
  const { notifiedAutopilot } = await chrome.storage.local.get('notifiedAutopilot')
  if (notifiedAutopilot === key) return
  await chrome.storage.local.set({ notifiedAutopilot: key })
  if (Date.now() - st.updatedAt > 30 * 60_000) return // งานเก่าตั้งแต่ก่อนเปิด Chrome — ไม่ต้องเตือน
  const done = st.status === 'done'
  chrome.notifications.create(key, {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: done ? 'ทำคลิปเสร็จแล้ว 🎬' : 'ทำคลิปอัตโนมัติหยุดกลางทาง',
    message: done ? st.title : `${st.title}\n${st.error ?? ''}\nกดทำคลิปอัตโนมัติอีกครั้งเพื่อทำต่อ`,
    priority: 2,
    requireInteraction: true,
  })
}

chrome.notifications?.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id)
  const win = await chrome.windows.getLastFocused().catch(() => null)
  if (win) chrome.sidePanel.open({ windowId: win.id }).catch(() => {})
})

// กดไอคอน = เลื่อนแผงข้างออกมา
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('poll', { periodInMinutes: 1 })
  pollLoop()
})
chrome.runtime.onStartup.addListener(pollLoop)
chrome.alarms?.onAlarm.addListener(() => {
  pollLoop()
  checkAutopilot()
})
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ENSURE_APP') {
    ensureApp().then(sendResponse)
    return true
  }
  if (msg.type === 'WAKE') {
    pollLoop()
    sendResponse({ ok: true })
  }
  if (msg.type === 'PARTIAL' || msg.type === 'RESULT' || msg.type === 'ERROR') {
    const path = { PARTIAL: '/partial', RESULT: '/result', ERROR: '/error' }[msg.type]
    postReliable(path, msg.body).then(sendResponse)
    return true
  }
  // PROGRESS ทุก 20 วิ = heartbeat ด้วย — ปลุก service worker และบอก bridge ว่างานยังไม่หลุด
  if (msg.type === 'PROGRESS') {
    post('/progress', msg.body).catch(() => {})
    if (!polling) pollLoop()
    sendResponse({ ok: true })
  }
})
