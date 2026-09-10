/**
 * Service worker — วนรับงานจาก bridge แล้วส่งต่อให้ content script ของเว็บที่เกี่ยวข้อง
 *
 * ข้อควรระวังของ MV3: service worker ถูกฆ่าเมื่อ idle ~30 วิ
 * จึงตั้ง alarm ทุก 1 นาทีมาปลุกให้ poll ใหม่ และ long-poll ฝั่ง bridge ตั้งไว้ 25 วิ
 * เพื่อให้จบก่อนถูกฆ่า
 */

const AGENTS = {
  chatgpt: { match: 'https://chatgpt.com/', pattern: 'https://chatgpt.com/*' },
  flow: { match: 'https://labs.google/fx/tools/flow', pattern: 'https://labs.google/fx/tools/flow*' },
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

async function setStatus(text) {
  await chrome.storage.local.set({ status: text, statusAt: Date.now() })
}

/** หา tab ของเว็บเป้าหมาย ถ้าไม่มีให้เปิดใหม่แล้วรอโหลดเสร็จ */
async function ensureTab(agent) {
  const { pattern, match } = AGENTS[agent]
  const [existing] = await chrome.tabs.query({ url: pattern })
  if (existing) return existing

  const tab = await chrome.tabs.create({ url: match, active: false })
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

  const response = await chrome.tabs.sendMessage(tab.id, { type: 'RUN_JOB', job }).catch(async (err) => {
    // content script ยังไม่ถูกฉีด (เช่นเปิดหน้าค้างไว้ตั้งแต่ก่อนติดตั้ง) → ฉีดเองแล้วลองใหม่
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['selectors.js', 'content-common.js', `content-${jobAgent(job)}.js`],
    })
    return chrome.tabs.sendMessage(tab.id, { type: 'RUN_JOB', job })
  })

  if (response?.ok) {
    await setStatus(`เสร็จ ${job.kind}`)
  } else {
    await post('/error', { id: job.id, message: response?.error ?? 'ไม่มีคำตอบจาก content script' })
    await setStatus(`ล้มเหลว: ${response?.error ?? 'ไม่ทราบสาเหตุ'}`)
  }
}

let currentAgent = 'chatgpt'
function jobAgent(job) {
  return job.agent ?? currentAgent
}

let polling = false
async function pollLoop() {
  if (polling) return
  polling = true
  try {
    for (;;) {
      const { base, token, enabled } = await settings()
      if (!enabled || !token) {
        await setStatus('ปิดอยู่ — เปิดสวิตช์ใน popup')
        return
      }
      for (const agent of Object.keys(AGENTS)) {
        currentAgent = agent
        let res
        try {
          res = await fetch(`${base}/job?agent=${agent}`, { headers: { 'x-bridge-token': token } })
        } catch {
          await setStatus('ต่อ bridge ไม่ได้ — รัน node bridge/server.js หรือยัง')
          await new Promise((r) => setTimeout(r, 5000))
          continue
        }
        if (res.status === 401) {
          await setStatus('token ไม่ตรงกับ .env')
          return
        }
        if (res.status === 200) {
          const job = await res.json()
          await handleJob({ ...job, agent })
        } else {
          await setStatus('รองาน...')
        }
      }
    }
  } finally {
    polling = false
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('poll', { periodInMinutes: 1 })
  pollLoop()
})
chrome.runtime.onStartup.addListener(pollLoop)
chrome.alarms?.onAlarm.addListener(pollLoop)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'WAKE') {
    pollLoop()
    sendResponse({ ok: true })
  }
  if (msg.type === 'PARTIAL') {
    post('/partial', msg.body).then((r) => sendResponse({ ok: r.ok }))
    return true
  }
  if (msg.type === 'RESULT') {
    post('/result', msg.body).then((r) => sendResponse({ ok: r.ok }))
    return true
  }
  if (msg.type === 'PROGRESS') {
    post('/progress', msg.body)
    sendResponse({ ok: true })
  }
})
