/**
 * แผงข้างของ Chrome — สั่ง ChatGPT ตรงๆ จากแผงนี้ ไม่ต้องติดตั้งหรือเปิดโปรแกรมอะไรเพิ่ม
 *
 *   1 หัวข้อ + 2 บทพากย์  → คุยกับแท็บ ChatGPT โดยตรง เก็บผลใน storage ของ extension
 *   3–7 เสียง ภาพ วิดีโอ   → ต้องใช้โปรแกรมในเครื่อง (native host เปิดให้) แล้วแสดงในแผงนี้
 *
 * prompt ใช้ชุดเดียวกับ pipeline/ (extension/prompts.js) ผลจึงเหมือนรันจาก terminal
 */
import { BLUEPRINT_FILE, topicsPrompt, scriptPrompt, parseTopics, cleanScript, estimateMinutes, slugify, scoredTopicsPrompt, parseScoredTopics, GENRES } from './prompts.js'
import { initIcons, setIconLabel } from './icons.js'
import { portrait, DEPARTMENTS, HANDOFF, AGENT_WORD, elapsed } from './agents.js'

initIcons()

const $ = (id) => document.getElementById(id)
const CHATGPT_URL = 'https://chatgpt.com/'
const WORDS_PER_MINUTE = 150
const S = { topics: [], selected: null, script: null, titleLanguage: 'en', language: 'th', minutes: 10, emotion: 'calm', speed: 1 }
let busy = false

// ── เก็บสถานะไว้ใน extension — ปิดแผงแล้วเปิดใหม่ยังอยู่ ──
async function load() {
  Object.assign(S, (await chrome.storage.local.get('panel')).panel ?? {})
}
const save = () => chrome.storage.local.set({ panel: S })

function setStatus(id, text, kind = '') {
  const el = $(id)
  el.className = 'status' + (kind === 'error' ? ' err' : kind === 'ok' ? ' ok' : '')
  el.textContent = ''
  if (kind === 'busy') el.append(Object.assign(document.createElement('span'), { className: 'spinner' }))
  el.append(text)
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// ── คุยกับ ChatGPT ──
let blueprintText = null
async function blueprint() {
  blueprintText ??= await (await fetch(chrome.runtime.getURL(encodeURIComponent(BLUEPRINT_FILE)))).text()
  return blueprintText
}

function waitTabLoaded(tabId) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve()
    }
    const listener = (id, info) => id === tabId && info.status === 'complete' && done()
    const timer = setTimeout(done, 30_000)
    chrome.tabs.onUpdated.addListener(listener)
  })
}

/**
 * แท็บ ChatGPT ของแผงนี้โดยเฉพาะ — ไม่ยืมแท็บที่ผู้ใช้คุยค้างอยู่ เพราะต้องโหลดหน้าใหม่ทุกครั้ง
 * การโหลด chatgpt.com/ ใหม่ = เริ่มแชตใหม่ ไม่ต้องหาปุ่ม New chat ซึ่ง selector เปลี่ยนบ่อย
 */
/**
 * แท็บเว็บที่ใช้ร่วมกับ background — แท็บที่จำไว้ > แท็บที่เปิดอยู่แล้ว > เปิดใหม่ (มีไม่มีจริงๆ เท่านั้น)
 * ไม่ต้องเปิดแท็บ ChatGPT/Flow เพิ่มทุกครั้งที่สั่งงาน
 */
async function reuseTab(key, patterns) {
  const { [key]: savedId } = await chrome.storage.session.get(key)
  const saved = savedId ? await chrome.tabs.get(savedId).catch(() => null) : null
  if (saved) return saved
  const tabs = await chrome.tabs.query({ url: patterns })
  const tab = tabs.find((t) => !t.discarded) ?? tabs[0] ?? null
  if (tab) await chrome.storage.session.set({ [key]: tab.id })
  return tab
}

async function freshChatTab() {
  let tab = await reuseTab('chatTabId', ['https://chatgpt.com/*', 'https://chat.openai.com/*'])
  if (tab) await chrome.tabs.update(tab.id, { url: CHATGPT_URL })
  else {
    tab = await chrome.tabs.create({ url: CHATGPT_URL, active: false })
    await chrome.storage.session.set({ chatTabId: tab.id })
  }
  await waitTabLoaded(tab.id)
  await new Promise((r) => setTimeout(r, 2500)) // หน้า SPA render ช่องพิมพ์ต่ออีกนิด
  return tab.id
}

async function askChatGPT(prompt, attachments) {
  const tabId = await freshChatTab()
  stopIfRequested()
  const send = () => chrome.tabs.sendMessage(tabId, { type: 'ASK', prompt, newChat: false, attachments })
  let res = await send().catch(() => null)
  if (!res) {
    stopIfRequested()
    // content script ยังไม่อยู่ในหน้า (เช่นเพิ่งติดตั้ง extension) → ฉีดเองแล้วลองใหม่
    await chrome.scripting.executeScript({ target: { tabId }, files: ['selectors.js', 'content-common.js', 'content-chatgpt.js'] })
    res = await send().catch((err) => ({ ok: false, error: String(err.message) }))
  }
  if (!res?.ok) throw new Error(res?.error ?? 'ChatGPT ไม่ตอบกลับ')
  return res.text
}

// ── ปุ่มหยุด ──
class Stopped extends Error {}
let stopRequested = false
let rejectRun = null
function stopIfRequested() {
  if (stopRequested) throw new Stopped()
}

async function stopRun() {
  if (!busy) return
  stopRequested = true
  rejectRun?.(new Stopped()) // ปล่อยแผงทันที ไม่ต้องรอแท็บตอบ
  const { chatTabId } = await chrome.storage.session.get('chatTabId')
  if (chatTabId) chrome.tabs.sendMessage(chatTabId, { type: 'STOP' }).catch(() => {})
}

/** ล็อกปุ่มระหว่างรอ + นับเวลา — ChatGPT ตอบได้ทีละงาน กดหยุดได้ตลอด */
async function withBusy(statusId, runningText, fn) {
  busy = true
  stopRequested = false
  render()
  const started = Date.now()
  const tick = () => setStatus(statusId, `${runningText}… (${fmtTime(Math.round((Date.now() - started) / 1000))})`, 'busy')
  tick()
  const timer = setInterval(tick, 1000)
  try {
    const run = fn()
    run.catch(() => {}) // กดหยุดแล้ว งานเดิมที่ค้างจะ error ตามมาทีหลัง — ไม่ต้องแจ้ง
    return await Promise.race([run, new Promise((_, reject) => (rejectRun = reject))])
  } finally {
    clearInterval(timer)
    rejectRun = null
    busy = false
    render()
  }
}

const failStatus = (id, err) =>
  err instanceof Stopped ? setStatus(id, 'หยุดแล้ว — กดเริ่มใหม่ได้') : setStatus(id, err.message, 'error')

$('stopTopics').addEventListener('click', stopRun)
$('stopScript').addEventListener('click', stopRun)

// ── 1 หัวข้อ ──
$('askTopics').addEventListener('click', async () => {
  $('topicsRawBox').hidden = true
  try {
    const text = await withBusy('topicsStatus', 'ChatGPT กำลังคิดหัวข้อ', async () =>
      askChatGPT(topicsPrompt(await blueprint(), { titleLanguage: S.titleLanguage, genre: S.genre })),
    )
    const topics = parseTopics(text)
    if (!topics.length) {
      $('topicsRaw').textContent = text.slice(0, 3000)
      $('topicsRawBox').hidden = false
      return setStatus('topicsStatus', 'อ่านตารางหัวข้อจากคำตอบไม่ออก', 'error')
    }
    Object.assign(S, { topics, selected: null, script: null })
    await save()
    setStatus('topicsStatus', `ได้ ${topics.length} หัวข้อ — คลิกเลือก`, 'ok')
  } catch (err) {
    failStatus('topicsStatus', err)
  }
  render()
})

async function selectTopic(t) {
  if (S.selected?.title !== t.title) S.script = null
  S.selected = { n: t.n, title: t.title }
  await save()
  render()
  $('scriptSection').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ── 2 บทพากย์ ──
$('askScript').addEventListener('click', async () => {
  $('scriptRawBox').hidden = true
  S.minutes = Math.min(60, Math.max(1, Number($('minutes').value) || 10))
  const opts = { language: S.language, targetMinutes: S.minutes, wordsPerMinute: WORDS_PER_MINUTE }
  try {
    const text = await withBusy('scriptStatus', 'ChatGPT กำลังเขียนบท (บทยาว ใช้เวลาหลายนาที)', async () =>
      askChatGPT(scriptPrompt(await blueprint(), S.selected.title, opts)),
    )
    const script = cleanScript(text)
    if (!script) {
      $('scriptRaw').textContent = text.slice(0, 3000)
      $('scriptRawBox').hidden = false
      return setStatus('scriptStatus', 'ChatGPT ไม่ได้ส่งบทกลับมา', 'error')
    }
    S.script = { text: script, language: S.language, minutes: S.minutes }
    await save()
    setStatus('scriptStatus', 'เขียนบทเสร็จแล้ว', 'ok')
  } catch (err) {
    failStatus('scriptStatus', err)
  }
  render()
})

$('copyScript').addEventListener('click', async () => {
  await navigator.clipboard.writeText(S.script.text)
  setStatus('scriptStatus', 'คัดลอกแล้ว', 'ok')
})

$('downloadScript').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([S.script.text], { type: 'text/plain;charset=utf-8' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: `script_${slugify(S.selected.title)}.txt` })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
})

// ── โปรแกรมในเครื่อง (bridge) ──
async function api(app, path, body) {
  const res = await fetch(`${app.url}${path.slice(1)}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-bridge-token': app.token },
    body: body && JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `โปรแกรมในเครื่องตอบ ${res.status}`)
  return data
}

/** เปิดโปรแกรมในเครื่อง แล้วส่งหัวข้อและบทที่ทำในแผงนี้ไปเป็นไฟล์ในโฟลเดอร์โปรเจกต์ */
async function connectApp() {
  const app = await chrome.runtime.sendMessage({ type: 'ENSURE_APP' })
  if (!app?.ok) throw new Error(app?.error ?? 'เปิดโปรแกรมไม่สำเร็จ')
  await api(app, '/api/import', {
    topics: S.topics, n: S.selected.n, script: S.script.text, language: S.script.language, targetMinutes: S.script.minutes,
  })
  return app
}

// ── 3 เสียงพากย์ด้วยเสียงของเรา ──
let voiceRunning = false
let trainRunning = false
/** งานในเครื่อง (สร้างเสียง/เทรน) ใช้การ์ดจอเต็ม และ bridge รันได้ทีละงาน */
const localBusy = () => voiceRunning || trainRunning || shotsRunning || flowRunning || renderRunning || autoRunning
let voiceTimer = null

function showVoiceLog(lines) {
  $('voiceLog').textContent = lines.slice(-40).join('\n')
  $('voiceLogBox').hidden = !lines.length
}

/** ติดตามงานสร้างเสียงจาก bridge จนจบ — ปิดแผงแล้วเปิดใหม่ก็ตามต่อได้ */
function watchVoice(app) {
  clearInterval(voiceTimer)
  voiceRunning = true
  render()
  const tick = async () => {
    let st
    try {
      st = await api(app, '/api/state')
    } catch (err) {
      return setStatus('voiceStatus', `ติดต่อโปรแกรมในเครื่องไม่ได้: ${err.message}`, 'error')
    }
    const run = st.run
    if (run?.step !== 'tts') return
    showVoiceLog(run.lines)
    if (run.status === 'running') {
      const secs = Math.round((Date.now() - run.startedAt) / 1000)
      const last = run.lines.at(-1)?.trim() || 'เริ่มงาน'
      return setStatus('voiceStatus', `${last} (${fmtTime(secs)})`, 'busy')
    }
    clearInterval(voiceTimer)
    voiceRunning = false
    if (run.status === 'done' && st.project?.audio) {
      $('voiceAudio').src = `${app.url}${st.project.audio.url.slice(1)}&k=${app.token}`
      $('voiceAudio').hidden = false
      loadTranscript(app)
      setStatus('voiceStatus', `สร้างเสียงเสร็จ ใช้เวลา ${fmtTime(Math.round((run.endedAt - run.startedAt) / 1000))}`, 'ok')
    } else if (run.status === 'stopped') {
      setStatus('voiceStatus', 'หยุดแล้ว — กดเริ่มใหม่ได้')
    } else {
      $('voiceLogBox').open = true
      setStatus('voiceStatus', 'สร้างเสียงไม่สำเร็จ — ดูรายละเอียดด้านล่าง', 'error')
    }
    render()
  }
  tick()
  voiceTimer = setInterval(tick, 1500)
}

$('startVoice').addEventListener('click', async () => {
  S.speed = Math.min(1.5, Math.max(0.7, Number($('speed').value) || 1))
  await save()
  voiceRunning = true
  render()
  $('voiceAudio').hidden = true
  setStatus('voiceStatus', 'กำลังเปิดโปรแกรมในเครื่อง…', 'busy')
  try {
    const app = await connectApp()
    await api(app, '/api/myvoice', { emotion: S.emotion, speed: S.speed })
    await api(app, '/api/run', { step: 'tts' })
    watchVoice(app)
  } catch (err) {
    voiceRunning = false
    setStatus('voiceStatus', err.message, 'error')
    render()
  }
})

$('stopVoice').addEventListener('click', async () => {
  const app = await chrome.runtime.sendMessage({ type: 'ENSURE_APP' })
  if (app?.ok) await api(app, '/api/run/stop', {}).catch(() => {})
})

// ── เปิด project เก่ามาทำต่อ ──
const STEP_CHIPS = [['script', 'บท'], ['audio', 'เสียง'], ['timecode', 'Timecode'], ['shotlist', 'Shot List'], ['images', 'ภาพ'], ['render', 'วิดีโอ']]

$('openProjects').addEventListener('click', async () => {
  const list = $('projectList')
  if (!list.hidden) {
    list.hidden = true
    return
  }
  $('openProjects').disabled = true
  setStatus('projectsStatus', 'กำลังอ่านรายการ project…', 'busy')
  try {
    const app = await chrome.runtime.sendMessage({ type: 'ENSURE_APP' })
    if (!app?.ok) throw new Error(app?.error ?? 'เปิดโปรแกรมในเครื่องไม่สำเร็จ')
    const { projects } = await api(app, '/api/projects')
    list.textContent = ''
    if (!projects.length) {
      setStatus('projectsStatus', 'ยังไม่มี project ในโฟลเดอร์ projects/')
      return
    }
    setStatus('projectsStatus', `${projects.length} project — เรียงจากที่ทำล่าสุด`)
    for (const p of projects) {
      const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'project' })
      const chips = Object.assign(document.createElement('div'), { className: 'chips' })
      for (const [key, label] of STEP_CHIPS) {
        const text = key === 'images' && p.images?.expected ? `${label} ${p.images.count}/${p.images.expected}` : label
        chips.append(Object.assign(document.createElement('span'), { className: `chip${p.done[key] ? ' done' : ''}`, textContent: `${p.done[key] ? '✓ ' : ''}${text}` }))
      }
      chips.append(Object.assign(document.createElement('span'), { className: `chip${p.cover ? ' done' : ''}`, textContent: p.cover ? '✓ ปก' : 'ปก' }))
      const info = document.createElement('div')
      info.append(
        Object.assign(document.createElement('div'), { className: 'title', textContent: p.title }),
        Object.assign(document.createElement('div'), { className: 'meta', textContent: `แก้ล่าสุด ${new Date(p.updatedAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}` }),
        chips,
        Object.assign(document.createElement('div'), { className: 'next', textContent: `ต่อ: ${p.next}` }),
      )
      if (p.cover) {
        const img = Object.assign(document.createElement('img'), { src: mediaUrl(app, p.cover), alt: `ภาพปก ${p.title}`, loading: 'lazy' })
        img.addEventListener('load', () => img.naturalHeight > img.naturalWidth && img.classList.add('portrait'))
        btn.append(Object.assign(document.createElement('div'), { className: 'projectCover' }))
        btn.lastChild.append(img, info)
      } else {
        btn.append(info)
      }
      btn.addEventListener('click', () => openProject(app, p.slug))

      // ปุ่มปก อยู่นอกปุ่มเปิด project (ปุ่มซ้อนปุ่มไม่ได้)
      const coverActions = Object.assign(document.createElement('div'), { className: 'coverActions' })
      const status = Object.assign(document.createElement('span'), { className: 'status', role: 'status' })
      if (p.cover) {
        const dl = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: '🖼 ดาวน์โหลดปก' })
        dl.addEventListener('click', () => downloadCover(app, p.cover, p.title).catch((err) => setStatus('projectsStatus', err.message, 'error')))
        coverActions.append(dl)
      } else if (p.done.shotlist) {
        const mk = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: '🖼 สร้างปก' })
        mk.title = 'ให้ Google Flow สร้างภาพปกคลิปจากเนื้อเรื่อง (แนวเดียวกับคลิป)'
        mk.addEventListener('click', async () => {
          if (localBusy()) return setStatus('projectsStatus', 'มีงานอื่นทำอยู่ — รอให้เสร็จก่อน', 'error')
          mk.disabled = true
          try {
            await makeCover(app, p.slug, (text) => setStatus('projectsStatus', text, 'busy'))
            setStatus('projectsStatus', `ได้ภาพปกของ "${p.title}" แล้ว — กดเปิด project เก่าอีกครั้งเพื่อดู`, 'ok')
          } catch (err) {
            setStatus('projectsStatus', err.message, 'error')
            mk.disabled = false
          }
        })
        coverActions.append(mk)
      }
      const li = Object.assign(document.createElement('li'), { className: 'projectRow' })
      li.append(btn)
      if (coverActions.childElementCount) li.append(coverActions)
      list.append(li)
    }
    list.hidden = false
  } catch (err) {
    setStatus('projectsStatus', err.message, 'error')
  } finally {
    $('openProjects').disabled = busy || localBusy()
  }
})

async function openProject(app, slug) {
  setStatus('projectsStatus', 'กำลังเปิด project…', 'busy')
  try {
    const data = await api(app, '/api/open', { slug })
    const topic = { n: 1, title: data.title }
    Object.assign(S, {
      topics: S.topics.some((t) => t.title === data.title) ? S.topics : [topic],
      selected: S.topics.find((t) => t.title === data.title) ?? topic,
      script: data.script ? { text: data.script, language: data.language, minutes: data.targetMinutes } : null,
      language: data.language ?? S.language,
      minutes: data.targetMinutes ?? S.minutes,
    })
    await save()
    $('projectList').hidden = true
    setStatus('projectsStatus', '')
    setStatus('topicsStatus', '')
    setStatus('scriptStatus', data.script ? 'บทเดิมของ project นี้' : 'project นี้ยังไม่มีบท — กดเขียนบทพากย์', data.script ? 'ok' : '')
    setStatus('voiceStatus', '')
    setStatus('shotsStatus', '')
    $('voiceAudio').hidden = true
    await loadShots(app)
    await loadTranscript(app)
    render()
    if (data.project?.audio) {
      $('voiceAudio').src = `${app.url}${data.project.audio.url.slice(1)}&k=${app.token}`
      $('voiceAudio').hidden = false
      setStatus('voiceStatus', data.project.audio.stale ? 'บทถูกแก้หลังทำเสียง — ควรสร้างเสียงใหม่' : 'เสียงพากย์ที่ทำไว้แล้ว', data.project.audio.stale ? 'error' : 'ok')
    }
    // เลื่อนไปขั้นที่ต้องทำต่อ
    const target = !data.script ? 'scriptSection' : !data.project?.audio ? 'voiceSection' : !data.project?.images ? 'imageSection' : 'renderSection'
    $(target).scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (err) {
    setStatus('projectsStatus', err.message, 'error')
  }
}

// ── 4 prompt ภาพสำหรับ Google Flow (OUTPUT 5) ──
// bridge คำนวณช่องช็อตจากเสียงพากย์ แล้วบอก prompt ทีละรอบ (รอบละ ≤40 ช็อต) — แผงนี้ส่งให้ ChatGPT แล้วส่งคำตอบกลับ
let shotsRunning = false
let shotsData = null
const ROUNDS_PER_CLICK = 8

function showShots(data) {
  shotsData = data?.rounds ? data : null
  $('shotsResult').hidden = !shotsData
  if (!shotsData) return
  const { total, withPrompt, missing, rounds, agentBrief, shots } = shotsData
  $('shotsFacts').textContent = `ได้ prompt ${withPrompt}/${total} ช็อต · ขอ ChatGPT ไป ${rounds} รอบ`
  $('shotsMissing').hidden = !missing.length
  $('shotsMissing').textContent = `ยังขาด ${missing.length} ช็อต: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}`
  $('resumeShots').hidden = !missing.length
  $('shotsBible').textContent = agentBrief.split(/^=== SHOT LIST ===$/m)[0].trim() || '(ยังไม่มี)'
  $('shotsCount').textContent = `${withPrompt}/${total}`
  const list = $('shotsList')
  list.textContent = ''
  for (const s of shots) {
    const li = document.createElement('li')
    if (!s.prompt) li.className = 'miss'
    li.append(
      Object.assign(document.createElement('div'), { className: 'fn', textContent: s.filename }),
      Object.assign(document.createElement('div'), { className: 'say', textContent: s.narration }),
      Object.assign(document.createElement('div'), { textContent: s.prompt ?? '— ยังไม่มี prompt —' }),
    )
    list.append(li)
  }
}

async function runShots(resume) {
  shotsRunning = true
  render()
  setStatus('shotsStatus', 'กำลังคำนวณ timecode และช่องช็อตจากเสียงพากย์…', 'busy')
  try {
    const app = await connectApp()
    let data = await api(app, '/api/shotlist/start', { resume })
    showShots(data)
    for (let i = 0; data.next && i < ROUNDS_PER_CLICK; i++) {
      const { round, batch, remaining, prompt, attachments } = data.next
      const text = await withBusy('shotsStatus', `ChatGPT กำลังเขียน prompt ภาพ รอบ ${round} · ${batch} ช็อต (เหลือ ${remaining})${attachments?.length ? ' · แนบรูปตัวละคร' : ''}`, () => askChatGPT(prompt, attachments))
      data = await api(app, '/api/shotlist/round', { raw: text })
      showShots(data)
    }
    if (data.missing.length) setStatus('shotsStatus', `ยังขาด ${data.missing.length} ช็อต — กด "ขอช็อตที่ขาดต่อ"`, 'error')
    else setStatus('shotsStatus', `prompt ภาพครบ ${data.total} ช็อตแล้ว — คัดลอกไปวางใน Google Flow ได้เลย`, 'ok')
  } catch (err) {
    failStatus('shotsStatus', err)
  } finally {
    shotsRunning = false
    render()
  }
}

$('startShots').addEventListener('click', () => {
  if (shotsData && !confirm('สร้าง prompt ภาพใหม่ทั้งหมด? prompt เดิมของ project นี้จะถูกแทนที่')) return
  runShots(false)
})
$('resumeShots').addEventListener('click', () => runShots(true))
$('stopShots').addEventListener('click', stopRun)

$('copyFlow').addEventListener('click', async () => {
  await navigator.clipboard.writeText(shotsData.flowPrompt)
  setStatus('shotsStatus', 'คัดลอก prompt แล้ว — ไปวางใน Google Flow ได้เลย', 'ok')
})

$('downloadFlow').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([shotsData.flowPrompt], { type: 'text/plain;charset=utf-8' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: `flow_prompt_${slugify(S.selected.title)}.txt` })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
})

/** prompt ภาพที่ทำไว้แล้วของ project ที่เลือก — ตอนเปิดแผง / เปิด project เก่า */
async function loadShots(app) {
  showShots(await api(app, '/api/shotlist').catch(() => null))
}

// ── 5 สร้างภาพใน Google Flow (Agent) ──
const FLOW_HOME = 'https://flow.google.com/'
const FLOW_MODEL = 'Nano Banana 2 Lite'
let flowRunning = false
let flowTimer = null

/** แท็บ Flow ของแผงนี้ — เปิดหน้าแรกทุกครั้ง เพื่อให้ได้ project ใหม่ต่อคลิป */
async function flowHomeTab() {
  let tab = await reuseTab('flowTabId', ['https://flow.google.com/*'])
  if (tab) await chrome.tabs.update(tab.id, { url: FLOW_HOME, active: true })
  else {
    tab = await chrome.tabs.create({ url: FLOW_HOME, active: true })
    await chrome.storage.session.set({ flowTabId: tab.id })
  }
  await waitTabLoaded(tab.id)
  await new Promise((r) => setTimeout(r, 3000)) // หน้าแรกของ Flow ขึ้น "Loading..." ก่อนมีปุ่ม New project
  return tab.id
}

async function flowMessage(tabId, msg) {
  const send = () => chrome.tabs.sendMessage(tabId, msg)
  let res = await send().catch(() => null)
  if (!res) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-flow-agent.js'] })
    res = await send().catch((err) => ({ ok: false, error: String(err.message) }))
  }
  return res
}

function stopFlowWatch(message, kind = '') {
  clearInterval(flowTimer)
  flowTimer = null
  flowRunning = false
  if (message) setStatus('flowStatus', message, kind)
  render()
}

function watchFlow(tabId, { expected, imagesBefore, started }) {
  clearInterval(flowTimer)
  let lastCount = -1
  let lastChange = Date.now()
  const tick = async () => {
    const st = await chrome.tabs.sendMessage(tabId, { type: 'FLOW_AGENT_STATUS' }).catch(() => null)
    if (!st?.ok) return setStatus('flowStatus', 'ติดต่อแท็บ Google Flow ไม่ได้ — อย่าปิดแท็บระหว่างสร้างภาพ', 'error')
    const made = Math.max(0, st.images - imagesBefore)
    if (made !== lastCount) {
      lastCount = made
      lastChange = Date.now()
    }
    const secs = Math.round((Date.now() - started) / 1000)
    if (made >= expected && !st.busy) {
      stopFlowWatch(`Flow สร้างภาพครบ ${made}/${expected} ใบแล้ว (${fmtTime(secs)})`, 'ok')
      return saveFlowImages(tabId)
    }
    // ไม่มีภาพเพิ่มนาน 10 นาที → เลิกติดตาม (agent อาจหยุดถามอะไรบางอย่าง ดูข้อความล่าสุด)
    if (!st.busy && Date.now() - lastChange > 10 * 60_000) {
      return stopFlowWatch(`ไม่มีภาพเพิ่มมา 10 นาที — ได้ ${made}/${expected} ใบ ดูในแท็บ Flow ว่า Agent ถามอะไรอยู่ไหม แล้วกด "ตั้งชื่อ + บันทึกภาพ" ได้`, 'error')
    }
    setStatus('flowStatus', `Flow Agent ${st.busy ? 'กำลังสร้างภาพ' : 'หยุดรอ'} ${made}/${expected} ใบ · ${fmtTime(secs)}`, 'busy')
  }
  tick()
  flowTimer = setInterval(tick, 5000)
}

$('startFlow').addEventListener('click', async () => {
  if (!shotsData?.flowPrompt) return
  const expected = shotsData.withPrompt
  if (shotsData.missing.length && !confirm(`prompt ภาพยังขาด ${shotsData.missing.length} ช็อต — ส่งเท่าที่มี ${expected} ช็อตไปก่อน?`)) return
  flowRunning = true
  render()
  try {
    setStatus('flowStatus', 'กำลังเปิด Google Flow…', 'busy')
    const tabId = await flowHomeTab()
    $('flowLinks').hidden = false
    setStatus('flowStatus', `สร้าง project ใหม่ → ตรวจว่า ${FLOW_MODEL} · x1 ใช้ 0 credits → ตั้งค่า Agent → ส่ง prompt…`, 'busy')
    const res = await flowMessage(tabId, { type: 'FLOW_AGENT_RUN', prompt: shotsData.flowPrompt, expected, model: FLOW_MODEL, aspect: shotsData.aspect ?? '16:9', attachments: (await api(await localApp(), '/api/character?attachments=1').catch(() => ({}))).attachments ?? [] })
    if (!res?.ok) throw new Error(res?.error ?? 'Google Flow ไม่ตอบกลับ')
    setStatus('flowStatus', `ส่ง prompt ${expected} ช็อตแล้ว · ${res.credits} credits · Agent: ${res.agent.model} ${res.agent.ratio} ${res.agent.count}`, 'ok')
    watchFlow(tabId, { expected, imagesBefore: res.imagesBefore, started: Date.now() })
  } catch (err) {
    stopFlowWatch(err.message, 'error')
  }
})

$('stopFlow').addEventListener('click', () => stopFlowWatch('หยุดติดตามแล้ว — Flow Agent ยังทำงานต่อในแท็บของมัน'))

/** ข้อความสั่ง agent เปลี่ยนชื่อ — รูปแบบเดียวกับที่ใช้เองในแชต Flow */
function renamePrompt() {
  const first = shotsData.shots.find((s) => s.prompt)
  return `เปลี่ยนชื่อ แต่ละ shot ให้ตรงตาม prompt ที่ส่งให้ เช่น

${first.filename} ${first.prompt}

ก็แก้ชื่อเป็น ${first.filename} ${(/SHOT\s*\d+/i.exec(first.prompt) ?? ['SHOT 01'])[0]}

ห้ามสร้างภาพใหม่ แค่เปลี่ยนชื่อภาพที่มีอยู่ให้ครบทุกภาพ ใช้ชื่อไฟล์ตาม shot list เป๊ะๆ`
}

/** ตั้งชื่อภาพผ่าน agent → อ่านชื่อ timecode → โหลดเป็น PNG → บันทึกลง 05_images/ */
async function saveFlowImages(tabId) {
  flowRunning = true
  render()
  $('flowMissing').hidden = true
  try {
    const app = await localApp()
    setStatus('flowStatus', 'สั่ง Flow Agent เปลี่ยนชื่อภาพเป็น "00_00_00.png SHOT 01"… (ภาพเยอะใช้เวลาหลายนาที)', 'busy')
    const renamed = await flowMessage(tabId, { type: 'FLOW_AGENT_RENAME', prompt: renamePrompt() })
    if (!renamed?.ok) throw new Error(renamed?.error ?? 'Flow ไม่ตอบกลับ')

    setStatus('flowStatus', 'กำลังอ่านรายการภาพใน project…', 'busy')
    const list = await flowMessage(tabId, { type: 'FLOW_AGENT_LIST' })
    if (!list?.ok) throw new Error(list?.error ?? 'อ่านรายการภาพไม่ได้')

    // grid เรียงใหม่สุดก่อน → ชื่อซ้ำให้ใช้ใบแรกที่เจอ (ใบล่าสุด)
    const wanted = new Set(shotsData.shots.filter((s) => s.prompt).map((s) => s.filename))
    const picks = new Map()
    for (const img of list.images) if (img.filename && wanted.has(img.filename) && !picks.has(img.filename)) picks.set(img.filename, img.id)
    // ภาพปกคลิป — ไม่นับรวมในจำนวนช็อต
    const coverImg = list.images.find((i) => i.filename?.toLowerCase() === 'cover.png')
    if (coverImg) picks.set('cover.png', coverImg.id)

    let saved = 0
    for (const [filename, id] of picks) {
      setStatus('flowStatus', `บันทึกภาพ ${saved + 1}/${picks.size}: ${filename}`, 'busy')
      const img = await flowMessage(tabId, { type: 'FLOW_AGENT_IMAGE', id })
      if (!img?.ok) throw new Error(`${filename}: ${img?.error ?? 'โหลดภาพไม่ได้'}`)
      await api(app, '/api/images/save', { name: filename, base64: img.base64 })
      saved++
    }

    const missing = [...wanted].filter((f) => !picks.has(f))
    const unnamed = list.images.filter((i) => !i.filename).length
    if (missing.length) {
      $('flowMissing').hidden = false
      $('flowMissing').textContent = `ไม่มีภาพของ ${missing.length} ช็อต: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}${unnamed ? ` · มีภาพที่ยังไม่ได้ตั้งชื่อ ${unnamed} ใบ (กดตั้งชื่อ + บันทึกภาพอีกครั้งได้)` : ''}`
    }
    setStatus('flowStatus', `บันทึกภาพ ${saved}/${wanted.size} ใบลง 05_images/ แล้ว`, missing.length ? 'error' : 'ok')
  } catch (err) {
    setStatus('flowStatus', err.message, 'error')
  } finally {
    flowRunning = false
    render()
  }
}

$('saveFlowImages').addEventListener('click', async () => {
  const { flowTabId } = await chrome.storage.session.get('flowTabId')
  const tab = flowTabId && (await chrome.tabs.get(flowTabId).catch(() => null))
  if (!tab) return setStatus('flowStatus', 'ไม่พบแท็บ Google Flow ของงานนี้ — เปิด project ใน Flow ไว้ก่อน', 'error')
  stopFlowWatch()
  saveFlowImages(tab.id)
})


$('showFlowTab').addEventListener('click', async () => {
  const { flowTabId } = await chrome.storage.session.get('flowTabId')
  const tab = flowTabId && (await chrome.tabs.get(flowTabId).catch(() => null))
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.windows.update(tab.windowId, { focused: true })
  }
})

// ── นำเข้าเสียงพากย์จากที่อื่น + ข้อความพร้อมเวลา (แบบ SayToWords) ──
let importLang = 'th'
let importRunning = false

$('importLang').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b || importRunning) return
  importLang = b.dataset.value
  for (const x of $('importLang').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b))
})

/** โหลดข้อความ + เวลาของ project ที่เลือก — ไฟล์ .srt/.txt ดาวน์โหลดตรงจากโปรแกรมในเครื่อง */
async function loadTranscript(app) {
  const t = await api(app, '/api/transcript').catch(() => null)
  $('transcriptBox').hidden = !t?.available
  if (!t?.available) return
  if (document.activeElement !== $('transcriptText')) $('transcriptText').value = t.text
  $('transcriptText').readOnly = !t.editable
  $('saveTranscript').hidden = !t.editable
  $('transcriptNote').textContent = t.editable
    ? 'ถอดจากไฟล์เสียงที่นำเข้า — แก้คำที่ถอดผิดได้ (เวลาแก้ได้ด้วย) แล้วกดบันทึก ก่อนไปทำ prompt ภาพ'
    : 'เวลาจริงของแต่ละประโยคจากเสียงที่ระบบสร้าง (แม่นทุกมิลลิวินาที) — แก้ข้อความที่บทแล้วทำเสียงใหม่'
  const slug = slugify(S.selected?.title ?? '')
  $('downloadSrt').href = `${app.url}${t.files.srt.slice(1)}&k=${app.token}`
  $('downloadSrt').download = `subtitle_${slug}.srt`
  $('downloadSegTxt').href = `${app.url}${t.files.txt.slice(1)}&k=${app.token}`
  $('downloadSegTxt').download = `segments_${slug}.txt`
}

$('saveTranscript').addEventListener('click', async () => {
  $('saveTranscript').disabled = true
  setStatus('transcriptStatus', 'กำลังบันทึกและคำนวณช็อตใหม่…', 'busy')
  try {
    const app = await localApp()
    const { segments } = await api(app, '/api/transcript', { text: $('transcriptText').value })
    await loadTranscript(app)
    setStatus('transcriptStatus', `บันทึกแล้ว ${segments} ประโยค${shotsData ? ' — prompt ภาพเดิมอาจไม่ตรงแล้ว ควรสร้าง prompt ภาพใหม่' : ''}`, shotsData ? 'error' : 'ok')
  } catch (err) {
    setStatus('transcriptStatus', err.message, 'error')
  } finally {
    $('saveTranscript').disabled = false
  }
})

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  const title = $('importTitle').value.trim()
  if (!S.selected && !title) return setStatus('importStatus', 'ตั้งชื่อเรื่องก่อน', 'error')
  if (S.selected && !title && !confirm(`นำเข้าเสียงนี้เป็นเสียงพากย์ของ "${S.selected.title}"? เสียงพากย์เดิมของเรื่องนี้จะถูกแทนที่`)) return

  importRunning = voiceRunning = true
  render()
  try {
    const app = await localApp()
    setStatus('importStatus', `กำลังส่งไฟล์ ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`, 'busy')
    const params = new URLSearchParams({ name: file.name, language: importLang, ...(title ? { title } : {}) })
    const res = await fetch(`${app.url}api/audio/import?${params}`, {
      method: 'POST',
      headers: { 'x-bridge-token': app.token, 'content-type': 'application/octet-stream' },
      body: file,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `ส่งไฟล์ไม่สำเร็จ (${res.status})`)

    // รอ bridge แปลงไฟล์ + ถอดเสียง
    const started = Date.now()
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500))
      const st = await api(app, '/api/state')
      const run = st.run
      if (run?.step !== 'importAudio') continue
      const last = run.lines.at(-1)?.trim() ?? ''
      if (run.status === 'running') {
        setStatus('importStatus', `${last || 'กำลังเริ่ม'} (${fmtTime(Math.round((Date.now() - started) / 1000))})`, 'busy')
        continue
      }
      if (run.status !== 'done') throw new Error(`ถอดเสียงไม่สำเร็จ: ${run.lines.slice(-3).join(' · ')}`)
      break
    }

    // เปิด project นั้นในแผง (บท เสียง ข้อความพร้อมเวลา)
    const { projects } = await api(app, '/api/projects')
    const target = projects.find((p) => p.slug === data.slug)
    voiceRunning = false
    if (target) await openProject(app, target.slug)
    $('importTitle').value = ''
    setStatus('importStatus', 'ถอดเสียงเสร็จแล้ว — ตรวจแก้ข้อความด้านล่าง แล้วไปทำ prompt ภาพต่อ', 'ok')
    $('transcriptBox').scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (err) {
    setStatus('importStatus', err.message, 'error')
  } finally {
    importRunning = voiceRunning = false
    render()
  }
})

// ── 6 สร้างวิดีโอ + หน้าต่างสำเร็จ + คลังวิดีโอ ──
let renderRunning = false
let renderTimer = null
let modalVideo = null // { slug, file } ของวิดีโอที่เปิดในหน้าต่าง

const fmtDuration = (sec) => (Number.isFinite(sec) ? fmtTime(Math.round(sec)) : '–')
const fmtDate = (ms) => new Date(ms).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
const mediaUrl = (app, url) => `${app.url}${url.slice(1)}&k=${app.token}`

/** ดาวน์โหลดภาพปก — ไฟล์อยู่บนโปรแกรมในเครื่องคนละ origin จึงโหลดเป็น blob ก่อนแล้วค่อยสั่งบันทึก */
async function downloadCover(app, coverUrl, title) {
  const res = await fetch(mediaUrl(app, coverUrl))
  if (!res.ok) throw new Error('โหลดภาพปกไม่ได้')
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: `ปก - ${String(title).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.png` })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** สั่ง Flow สร้างเฉพาะภาพปกของ project ที่เลือก แล้วรอจนเสร็จ */
async function makeCover(app, slug, onStatus) {
  await api(app, '/api/open', { slug })
  await api(app, '/api/run', { step: 'cover' })
  chrome.runtime.sendMessage({ type: 'WAKE' }).catch(() => {})
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000))
    const r = (await api(app, '/api/state').catch(() => null))?.run
    if (r?.step !== 'cover') continue
    if (r.status === 'running') {
      onStatus?.(`Google Flow กำลังสร้างภาพปก… ${r.lines.at(-1) ?? ''}`)
      continue
    }
    if (r.status !== 'done') throw new Error(r.lines.at(-1) ?? 'สร้างภาพปกไม่สำเร็จ')
    if (!r.lines.some((l) => l.includes('ได้ภาพปกคลิปแล้ว'))) throw new Error('Flow ยังไม่ได้ภาพปก — ลองกดสร้างอีกครั้ง')
    return
  }
}

const SHOWN_DONE_KEY = 'shownDoneVideo'

function showVideoModal(app, video, file, { success }) {
  modalMediaUrl = mediaUrl(app, file.url)
  if (success) chrome.storage.local.set({ [SHOWN_DONE_KEY]: `${video.slug}:${file.createdAt}` }).catch(() => {})
  $('videoModalCover').hidden = !video.cover
  $('videoModalCover').onclick = () => downloadCover(app, video.cover, video.title).catch((err) => alert(err.message))
  modalVideo = { slug: video.slug, file: file.name }
  $('successMark').hidden = !success
  $('videoModalTitle').textContent = success ? 'สร้างวิดีโอสำเร็จ' : video.title
  $('videoModalName').textContent = success ? video.title : file.main ? 'ไฟล์หลัก' : file.name
  $('videoModalPlayer').src = mediaUrl(app, file.url)
  $('videoModalFacts').textContent = `ยาว ${fmtDuration(file.seconds)} · ${file.mb} MB · ภาพ ${video.images}${video.shots ? `/${video.shots}` : ''} ช็อต · ${fmtDate(file.createdAt)}`
  $('videoModalLibrary').hidden = !success
  $('videoModal').hidden = false
  $('videoModalClose').focus()
}

let modalMediaUrl = null

/** คลิปจากทำคลิปอัตโนมัติเสร็จ → เปิดหน้าต่างวิดีโอ · once = ไม่เปิดซ้ำถ้าเคยแสดงคลิปไฟล์นี้แล้ว */
async function showFinishedVideo(app, slug, { once = false } = {}) {
  const { videos } = await api(app, '/api/videos')
  const video = videos.find((v) => v.slug === slug)
  const file = video?.files.find((f) => f.main) ?? video?.files[0]
  if (!video || !file) return false
  if (once) {
    const { [SHOWN_DONE_KEY]: shown } = await chrome.storage.local.get(SHOWN_DONE_KEY)
    if (shown === `${video.slug}:${file.createdAt}`) return false
  }
  showVideoModal(app, video, file, { success: true })
  return true
}

function closeVideoModal() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  $('videoModalPlayer').pause()
  $('videoModalPlayer').removeAttribute('src')
  $('videoModal').hidden = true
  modalVideo = null
}

$('videoModalClose').addEventListener('click', closeVideoModal)
$('videoModalFullscreen').addEventListener('click', () => {
  $('videoModalPlayer').requestFullscreen?.().then(() => $('videoModalPlayer').play().catch(() => {})).catch(() => {})
})
$('videoModalTab').addEventListener('click', () => {
  if (!modalMediaUrl) return
  $('videoModalPlayer').pause()
  chrome.tabs.create({ url: modalMediaUrl }).catch(() => {})
})
$('videoModal').addEventListener('click', (e) => e.target === $('videoModal') && closeVideoModal())
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (document.fullscreenElement) return // Esc ออกจากเต็มจอก่อน ไม่ปิดหน้าต่าง
  if (!$('videoModal').hidden) closeVideoModal()
  else if (!$('bookSheet').hidden) closeBookSheet()
  else if (!$('checklist').hidden) $('checklist').hidden = true
  else if (!$('library').hidden) $('library').hidden = true
})
$('videoModalReveal').addEventListener('click', async () => {
  if (!modalVideo) return
  await api(await localApp(), '/api/videos/reveal', modalVideo).catch((err) => alert(err.message))
})
$('videoModalLibrary').addEventListener('click', () => {
  closeVideoModal()
  openLibrary()
})

$('startRender').addEventListener('click', async () => {
  renderRunning = true
  render()
  $('renderLogBox').hidden = true
  setStatus('renderStatus', 'กำลังเตรียม…', 'busy')
  try {
    const app = await connectApp()
    const run = await api(app, '/api/run', { step: 'render' })
    const started = run.startedAt ?? Date.now()
    clearInterval(renderTimer)
    await new Promise((resolve, reject) => {
      renderTimer = setInterval(async () => {
        const st = await api(app, '/api/state').catch(() => null)
        const r = st?.run
        if (r?.step !== 'render') return
        $('renderLog').textContent = r.lines.slice(-30).join('\n')
        $('renderLogBox').hidden = !r.lines.length
        if (r.status === 'running') {
          return setStatus('renderStatus', `กำลังประกอบวิดีโอ… (${fmtTime(Math.round((Date.now() - started) / 1000))})`, 'busy')
        }
        clearInterval(renderTimer)
        if (r.status === 'done') resolve()
        else if (r.status === 'stopped') reject(new Error('หยุดแล้ว — กดสร้างวิดีโอใหม่ได้'))
        else {
          $('renderLogBox').open = true
          reject(new Error('สร้างวิดีโอไม่สำเร็จ — ดูรายละเอียดด้านล่าง'))
        }
      }, 1500)
    })

    const { videos } = await api(app, '/api/videos')
    const video = videos.find((v) => v.slug === slugify(S.selected.title))
    const file = video?.files.find((f) => f.main) ?? video?.files[0]
    setStatus('renderStatus', 'สร้างวิดีโอสำเร็จ', 'ok')
    if (video && file) showVideoModal(app, video, file, { success: true })
  } catch (err) {
    setStatus('renderStatus', err.message, err.message.startsWith('หยุด') ? '' : 'error')
  } finally {
    renderRunning = false
    render()
  }
})

$('stopRender').addEventListener('click', async () => {
  const app = await localApp().catch(() => null)
  if (app) await api(app, '/api/run/stop', {}).catch(() => {})
})

// ── ⚡ ทำคลิปอัตโนมัติ — bridge รัน pipeline/autopilot.mjs ส่วนแผงนี้แค่แสดงความคืบหน้าของแต่ละแผนก ──
const DEPTS = [
  ['script', 'แผนกเขียนบท', 'ChatGPT'],
  ['voice', 'แผนกเสียงพากย์', 'ในเครื่อง'],
  ['art', 'แผนกกำกับภาพ', 'ChatGPT'],
  ['images', 'แผนกวาดภาพ', 'Google Flow'],
  ['edit', 'แผนกตัดต่อ', 'ในเครื่อง'],
]
const DEPT_MARK = { waiting: '', working: '', done: '✓', failed: '!' }
let autoRunning = false
let autoTimer = null
let agentAutopilot = null

/** เวลาที่น่าจะเหลือ — ชุดเดียวกับ pipeline/lib/progress.mjs */
const formatEta = (sec) => {
  if (sec == null) return ''
  if (sec < 60) return `~${Math.max(5, Math.round(sec / 5) * 5)} วินาที`
  const min = Math.round(sec / 60)
  return min >= 60 ? `~${Math.floor(min / 60)} ชม. ${min % 60} นาที` : `~${min} นาที`
}
/** "63% · ขั้น 4/5 วาดภาพ 28/57 ภาพ · เหลือ ~12 นาที" */
function progressText(p, status) {
  if (!p) return ''
  if (status === 'done' || p.status === 'done') return 'เสร็จแล้ว'
  const parts = [p.step ? `ขั้น ${p.step}/${p.steps} ${p.label}` : p.label, p.count, p.etaSec != null ? `เหลือ ${formatEta(p.etaSec)}` : '']
  return parts.filter(Boolean).join(' · ')
}
function setBar(trackId, barId, percent) {
  $(barId).style.width = `${percent}%`
  $(trackId).setAttribute('aria-valuenow', String(percent))
  $(trackId).setAttribute('aria-valuetext', `${percent}%`)
}
/** ตัวเลขบนไอคอน extension — ดูได้โดยไม่ต้องเปิดแผง */
function setBadge(auto) {
  if (!chrome.action?.setBadgeText) return
  const st = auto?.status
  const text = st === 'running' ? `${auto.progress?.percent ?? 0}%` : st === 'done' ? '✓' : ['failed', 'error'].includes(st) ? '!' : ''
  const color = st === 'done' ? '#2b7552' : ['failed', 'error'].includes(st) ? '#b8432a' : '#0a7488'
  chrome.action.setBadgeText({ text }).catch?.(() => {})
  if (text) chrome.action.setBadgeBackgroundColor({ color }).catch?.(() => {})
}

function showAuto(status, run, progress) {
  agentAutopilot = status
  // ความคืบหน้ารวม
  $('autoProgress').hidden = !status
  if (status) {
    const pct = status.status === 'done' ? 100 : progress?.percent ?? 0
    $('autoPct').textContent = `${pct}%`
    $('autoProgressText').textContent = progressText(progress, status.status) || ({ stopped: 'หยุดไว้', failed: 'ติดปัญหา' }[status.status] ?? '')
    setBar('autoProgressBar', 'autoBar', pct)
  }
  const list = $('autoDepts')
  list.hidden = !status
  if (status) {
    list.textContent = ''
    for (const [id, label, who] of DEPTS) {
      const d = status.departments?.[id] ?? { status: 'waiting' }
      const li = document.createElement('li')
      li.className = `dept ${d.status}`
      const name = Object.assign(document.createElement('div'), { className: 'name', textContent: label })
      name.append(Object.assign(document.createElement('small'), { textContent: who }))
      li.append(
        Object.assign(document.createElement('span'), { className: 'mark', textContent: DEPT_MARK[d.status] ?? '', ariaHidden: 'true' }),
        name,
        Object.assign(document.createElement('div'), { className: 'detail', textContent: d.detail || { waiting: 'รอคิว', working: 'กำลังทำ…', done: 'เสร็จ', failed: 'ไม่สำเร็จ' }[d.status] }),
      )
      // % ของแผนกนี้ (มีตัวเลขจริงเฉพาะแผนกที่นับชิ้นงานได้)
      const pct = d.status === 'done' ? 100 : progress?.departments?.[id]
      if (pct != null && d.status !== 'waiting') {
        name.prepend(Object.assign(document.createElement('span'), { className: 'pct', textContent: `${pct}%` }))
        if (d.status === 'working') {
          const track = Object.assign(document.createElement('div'), { className: 'progressTrack miniTrack' })
          const bar = document.createElement('i')
          bar.style.width = `${pct}%`
          track.append(bar)
          li.append(track)
        }
      }
      li.setAttribute('aria-label', `${label}: ${d.detail || d.status}`)
      list.append(li)
    }
  }
  if (run?.lines) {
    $('autoLog').textContent = run.lines.slice(-40).join('\n')
    $('autoLogBox').hidden = !run.lines.length
  }
}

/** รอจน autopilot จบ — resolve เมื่อได้วิดีโอ, reject เมื่อหยุดหรือพัง */
function watchAuto(app, slug) {
  clearInterval(autoTimer)
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const a = await api(app, slug ? `/api/autopilot?slug=${encodeURIComponent(slug)}` : '/api/autopilot').catch(() => null)
      if (!a) return
      // ระบบเลือกหัวข้อเองเสร็จแล้ว → รู้ชื่อคลิป ติดตามต่อด้วย slug นั้น
      if (!slug && a.run?.slug) {
        slug = a.run.slug
        if (a.run.title) $('autoTitle').value = a.run.title
      }
      showAuto(a.status, a.run, a.progress)
      const st = a.status
      if (a.run?.status === 'running' || st?.status === 'running') {
        const secs = Math.round((Date.now() - (st?.startedAt ?? started)) / 1000)
        const cur = DEPTS.find(([id]) => id === st?.current)
        return setStatus('autoStatus', `${a.progress ? `${a.progress.percent}% · ` : ''}${cur ? cur[1] : slug ? 'กำลังเริ่ม' : 'แผนกคิดหัวข้อ'}กำลังทำงาน · ผ่านไป ${fmtTime(secs)}`, 'busy')
      }
      clearInterval(autoTimer)
      if (st?.status === 'done') resolve({ ...st, slug: st.slug ?? slug })
      else if (a.run?.status === 'stopped' || st?.status === 'stopped') reject(new Error('หยุดแล้ว — กดทำคลิปอัตโนมัติอีกครั้งเพื่อทำต่อจากที่ค้าง'))
      else {
        $('autoLogBox').open = true
        reject(new Error(st?.error ? `${st.error} — กดอีกครั้งเพื่อทำต่อจากจุดนี้` : 'ทำคลิปไม่สำเร็จ — ดูรายละเอียดด้านล่าง'))
      }
    }
    autoTimer = setInterval(tick, 2000)
    tick()
  })
}

async function runAuto(app, slug) {
  autoRunning = true
  render()
  try {
    const st = await watchAuto(app, slug)
    slug = st.slug ?? slug
    setStatus('autoStatus', 'ทำคลิปเสร็จแล้ว', 'ok')
    await openProject(app, slug).catch(() => {})
    if (!(await showFinishedVideo(app, slug).catch(() => false))) setStatus('autoStatus', `ทำคลิปเสร็จแล้ว: ${st.video ?? ''}`, 'ok')
  } catch (err) {
    setStatus('autoStatus', err.message.startsWith('หยุด') ? 'หยุดไว้แล้ว — กด ▶ ทำต่อ เมื่อพร้อม (แผนกที่เสร็จแล้วไม่ทำซ้ำ)' : `${err.message}`, err.message.startsWith('หยุด') ? '' : 'error')
    const app2 = await localApp().catch(() => null)
    const a = app2 ? await api(app2, slug ? `/api/autopilot?slug=${encodeURIComponent(slug)}` : '/api/autopilot').catch(() => null) : null
    autoRunning = false
    setResume(a?.status ?? { status: 'stopped', title: $('autoTitle').value.trim(), slug }, a?.last)
  } finally {
    autoRunning = false
    render()
  }
}

$('startAuto').addEventListener('click', async () => {
  const autoTopic = S.autoTopicMode === 'auto'
  const title = autoTopic ? '' : $('autoTitle').value.trim()
  if (!title && !autoTopic) {
    setStatus('autoStatus', S.autoTopicMode === 'suggest' ? 'เลือกหัวข้อจากรายการที่ AI เสนอก่อน' : 'พิมพ์หัวข้อคลิปก่อน', 'error')
    return S.autoTopicMode === 'suggest' ? $('suggestTopics').focus() : $('autoTitle').focus()
  }
  S.autoTitle = title
  autoResume = null // เริ่มคลิปใหม่ ไม่ต้องทำต่อคลิปเก่า
  S.minutes = Number($('autoMinutes').value) || S.minutes
  await save()
  autoRunning = true
  render()
  setStatus('autoStatus', 'กำลังเริ่ม…', 'busy')
  try {
    const app = await localApp()
    const { slug } = await api(app, '/api/autopilot', { title, autoTopic, genre: S.genre, language: S.language, minutes: S.minutes })
    // เปิดแท็บ ChatGPT ไว้ก่อน — ถ้ายังไม่ได้ล็อกอินจะเห็นทันที
    if (!(await reuseTab('chatTabId', ['https://chatgpt.com/*', 'https://chat.openai.com/*']))) {
      const tab = await chrome.tabs.create({ url: CHATGPT_URL, active: false })
      await chrome.storage.session.set({ chatTabId: tab.id })
    }
    chrome.runtime.sendMessage({ type: 'WAKE' }).catch(() => {})
    await runAuto(app, slug)
  } catch (err) {
    autoRunning = false
    setStatus('autoStatus', err.message, 'error')
    render()
  }
})

// ── ปุ่มเดียว: ระหว่างทำ = ⏸ หยุด · หยุดไว้/ติดปัญหา = ▶ ทำต่อ (ข้ามแผนกที่เสร็จแล้ว) ──
let autoResume = null // { title, slug, stage } คลิปที่หยุดไว้ ทำต่อได้

function setResume(status, last) {
  const resumable = status && ['stopped', 'failed', 'error'].includes(status.status)
  autoResume = resumable ? { title: status.title, slug: status.slug, language: last?.language, minutes: last?.minutes, stage: DEPTS.find(([id]) => status.departments?.[id]?.status !== 'done')?.[1] } : null
  render()
}

$('stopAuto').addEventListener('click', async () => {
  const app = await localApp().catch(() => null)
  if (!app) return setStatus('autoStatus', 'เปิดโปรแกรมในเครื่องไม่ได้', 'error')

  if (autoRunning) {
    $('stopAuto').disabled = true
    setStatus('autoStatus', 'กำลังหยุด…', 'busy')
    await api(app, '/api/run/stop', {}).catch(() => {})
    // สั่ง ChatGPT หยุดพิมพ์คำตอบที่ค้างอยู่ด้วย
    const { chatTabId } = await chrome.storage.session.get('chatTabId')
    if (chatTabId) chrome.tabs.sendMessage(chatTabId, { type: 'STOP' }).catch(() => {})
    return
  }

  if (!autoResume?.title) return
  // ทำต่อ = สั่งทำคลิปอัตโนมัติด้วยหัวข้อเดิม ระบบข้ามแผนกที่เสร็จแล้วเอง
  const r = autoResume
  $('autoTitle').value = r.title
  S.autoTitle = r.title
  if (S.autoTopicMode === 'auto') S.autoTopicMode = 'manual' // เลือกหัวข้อไปแล้ว ไม่ต้องคิดใหม่
  await save()
  autoResume = null
  autoRunning = true
  render()
  setStatus('autoStatus', `ทำต่อจาก${r.stage ?? 'จุดที่ค้าง'}…`, 'busy')
  try {
    const { slug } = await api(app, '/api/autopilot', { title: r.title, language: r.language ?? S.language, minutes: r.minutes ?? S.minutes })
    chrome.runtime.sendMessage({ type: 'WAKE' }).catch(() => {})
    await runAuto(app, slug)
  } catch (err) {
    autoRunning = false
    setStatus('autoStatus', err.message, 'error')
    render()
  }
})

$('autoTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('startAuto').disabled) $('startAuto').click()
})
$('autoMinutes').addEventListener('change', async () => {
  S.minutes = Math.min(30, Math.max(1, Number($('autoMinutes').value) || S.minutes))
  await save()
  render()
})
$('autoLang').addEventListener('click', async (e) => {
  const b = e.target.closest('button')
  if (!b || busy || localBusy()) return
  S.language = b.dataset.value
  await save()
  render()
})

// ── เลือกหัวข้อ: พิมพ์เอง / ให้ AI เสนอพร้อมคะแนน / ให้ระบบเลือกคะแนนสูงสุดเอง ──
function renderTopicMode() {
  const mode = S.autoTopicMode ?? 'manual'
  for (const b of $('autoTopicMode').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.value === mode))
    b.disabled = busy || localBusy()
  }
  $('topicSuggestBox').hidden = mode !== 'suggest'
  $('genreBox').hidden = mode === 'manual'
  $('topicGenre').disabled = busy || localBusy()
  $('topicGenre').value = S.genre ?? 'mix'
  $('topicAutoHint').hidden = mode !== 'auto'
  $('autoTitleBox').hidden = mode === 'auto' && !autoRunning
  $('suggestTopics').disabled = busy || localBusy()
  $('suggestTopics').textContent = S.scoredTopics?.length ? '💡 เสนอหัวข้อใหม่' : '💡 เสนอ 5 หัวข้อพร้อมคะแนน'

  const list = $('scoredTopics')
  list.textContent = ''
  if (mode !== 'suggest') return
  for (const [i, t] of (S.scoredTopics ?? []).entries()) {
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'scoredTopic' })
    btn.setAttribute('role', 'radio')
    btn.setAttribute('aria-checked', String($('autoTitle').value.trim() === t.title))
    btn.disabled = busy || localBusy()
    const badge = Object.assign(document.createElement('span'), { className: 'scoreBadge' })
    badge.style.setProperty('--score', Math.max(0, Math.min(100, t.score)))
    badge.append(Object.assign(document.createElement('span'), { textContent: t.score }))
    const name = Object.assign(document.createElement('span'), { className: 't', textContent: t.title })
    if (t.genre) name.append(Object.assign(document.createElement('span'), { className: 'genreTag', textContent: t.genre }))
    if (i === 0) name.append(Object.assign(document.createElement('span'), { className: 'best', textContent: 'แนะนำ' }))
    const parts = [['ดึงดูด', t.hook], ['คนสนใจ', t.search], ['เล่าด้วยภาพ', t.visual]].filter(([, v]) => v != null)
    btn.append(
      badge,
      name,
      Object.assign(document.createElement('span'), { className: 'sub', textContent: parts.map(([k, v]) => `${k} ${v}/10`).join(' · ') }),
      Object.assign(document.createElement('span'), { className: 'why', textContent: t.why ?? '' }),
    )
    btn.setAttribute('aria-label', `${t.title} คะแนน ${t.score} ${t.why ?? ''}`)
    btn.addEventListener('click', async () => {
      $('autoTitle').value = t.title
      S.autoTitle = t.title
      await save()
      renderTopicMode()
    })
    const li = document.createElement('li')
    li.append(btn)
    list.append(li)
  }
}

// ── แนวคลิป: สุ่มหลากหลาย หรือเจาะแนวเดียว ──
for (const g of ['mix', ...GENRES]) {
  $('topicGenre').append(Object.assign(document.createElement('option'), { value: g, textContent: g === 'mix' ? '🎲 สุ่มหลากหลายแนว (แนะนำ)' : g }))
}
$('topicGenre').addEventListener('change', async () => {
  S.genre = $('topicGenre').value
  await save()
})

$('autoTopicMode').addEventListener('click', async (e) => {
  const b = e.target.closest('button')
  if (!b || busy || localBusy()) return
  S.autoTopicMode = b.dataset.value
  await save()
  renderTopicMode()
})

$('suggestTopics').addEventListener('click', async () => {
  try {
    // หัวข้อที่ทำไปแล้ว → ห้ามเสนอซ้ำ (ถ้าโปรแกรมในเครื่องยังไม่เปิดก็ข้ามไป)
    const app = await localApp().catch(() => null)
    const avoid = app ? ((await api(app, '/api/projects').catch(() => ({}))).projects ?? []).map((p) => p.title) : []
    const text = await withBusy('suggestStatus', 'ChatGPT กำลังคิดหัวข้อและให้คะแนน', async () =>
      askChatGPT(scoredTopicsPrompt(await blueprint(), { titleLanguage: S.language, minutes: S.minutes, avoid, genre: S.genre })),
    )
    const topics = parseScoredTopics(text)
    if (!topics.length) return setStatus('suggestStatus', 'อ่านตารางหัวข้อจากคำตอบไม่ออก — กดเสนอใหม่อีกครั้ง', 'error')
    S.scoredTopics = topics
    // เลือกเรื่องคะแนนสูงสุดไว้ก่อน เปลี่ยนได้ด้วยการกดเรื่องอื่น
    $('autoTitle').value = topics[0].title
    S.autoTitle = topics[0].title
    await save()
    setStatus('suggestStatus', `ได้ ${topics.length} หัวข้อ — เลือกเรื่องที่คะแนนสูงสุดไว้ให้แล้ว กดเรื่องอื่นเพื่อเปลี่ยน`, 'ok')
  } catch (err) {
    failStatus('suggestStatus', err)
  }
  render()
})
$('autoTitle').addEventListener('input', () => S.autoTopicMode === 'suggest' && renderTopicMode())

/** เปิดแผงใหม่ระหว่างที่ autopilot ทำงานอยู่ → แสดงต่อ; จบไปแล้ว → แสดงผลล่าสุด */
async function resumeAuto() {
  const app = await localApp().catch(() => null)
  if (!app) return
  const a = await api(app, '/api/autopilot').catch(() => null)
  if (a?.run?.status === 'running' && !a.status) return runAuto(app, a.slug) // ยังอยู่ในแผนกคิดหัวข้อ
  if (!a?.status) return
  if (a.run?.status === 'running') {
    if (!$('autoTitle').value && a.status?.title) $('autoTitle').value = a.status.title
    return runAuto(app, a.slug)
  }
  setResume(a.status, a.last)
  // เสร็จตอนแผงปิดอยู่ (หรือตอนแผงไม่ได้ติดตาม) → เปิดแผงมาเห็นวิดีโอเลย ครั้งเดียวต่อคลิป
  if (a.status.status === 'done' && Date.now() - (a.status.updatedAt ?? 0) < 6 * 3600_000) {
    showFinishedVideo(app, a.slug, { once: true }).catch(() => {})
  }
  if (a.status.title === S.autoTitle || autoResume) {
    showAuto(a.status, null, a.progress)
    if (autoResume) setStatus('autoStatus', `"${autoResume.title}" หยุดไว้ที่${autoResume.stage ?? 'กลางทาง'} — กด ▶ ทำต่อ`, a.status.status === 'stopped' ? '' : 'error')
    if (a.status.status === 'done') setStatus('autoStatus', 'คลิปล่าสุดทำเสร็จแล้ว — ดูได้ในคลังวิดีโอ', 'ok')
    else if (a.status.error && !autoResume) setStatus('autoStatus', `ค้างที่ ${a.status.error} — กดอีกครั้งเพื่อทำต่อ`, 'error')
  }
}

// ── ตั้งค่าคลิป (แนวภาพ · ซับไตเติล · ช่วงเงียบ) — เก็บใน config ของโปรแกรมในเครื่อง ──
let clip = null

function renderClipSettings() {
  if (!clip) return
  for (const b of $('clipOrientation').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === clip.orientation))
  const sel = $('clipSubtitles')
  if (!sel.options.length) for (const o of clip.options.subtitles) sel.append(new Option(o.label, o.id))
  sel.value = clip.subtitles
  const pause = $('clipPause')
  if (!pause.childElementCount) {
    for (const o of clip.options.pause) {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: o.label })
      b.dataset.value = o.id
      pause.append(b)
    }
  }
  for (const b of pause.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === clip.pause))
  // โปรแกรมในเครื่องรุ่นเก่าไม่ส่งตัวเลือกนี้มา → ซ่อน
  const motion = $('clipMotion')
  const motionOptions = clip.options.motion ?? []
  motion.parentElement.hidden = !motionOptions.length
  if (!motion.childElementCount) {
    for (const o of motionOptions) {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: o.label })
      b.dataset.value = o.id
      motion.append(b)
    }
  }
  for (const b of motion.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === clip.motion))
  const motionLabel = motionOptions.find((o) => o.id === clip.motion)?.label
  const subLabel = clip.options.subtitles.find((o) => o.id === clip.subtitles)?.label
  const pauseLabel = clip.options.pause.find((o) => o.id === clip.pause)?.label
  const summary = `${clip.orientation === 'portrait' ? 'แนวตั้ง 9:16' : 'แนวนอน 16:9'} · ซับไตเติล${subLabel}${motionLabel ? ` · ${motionLabel}` : ''} · เงียบ${pauseLabel}`
  $('clipSettingsSummary').textContent = `ตั้งค่าคลิป: ${summary}${character?.active ? ' · ตัวละครของฉัน' : ''}`
  $('renderSettingsHint').textContent = `ซับไตเติล: ${subLabel}${motionLabel ? ` · ${motionLabel}` : ''} · แนวภาพตามภาพที่สร้างไว้ (เปลี่ยนได้ที่ ⚡ ตั้งค่าคลิป)`
  for (const el of [...$('clipOrientation').querySelectorAll('button'), sel, ...pause.querySelectorAll('button'), ...motion.querySelectorAll('button')]) el.disabled = localBusy()
}

async function saveClipSettings(change) {
  try {
    clip = await api(await localApp(), '/api/clip-settings', change)
  } catch (err) {
    setStatus('autoStatus', err.message, 'error')
  }
  renderClipSettings()
}

$('clipOrientation').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (b && !localBusy()) saveClipSettings({ orientation: b.dataset.value })
})
$('clipPause').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (b && !localBusy()) saveClipSettings({ pause: b.dataset.value })
})
$('clipMotion').addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (b && !localBusy()) saveClipSettings({ motion: b.dataset.value })
})
$('clipSubtitles').addEventListener('change', (e) => saveClipSettings({ subtitles: e.target.value }))

localApp()
  .then((app) => api(app, '/api/clip-settings'))
  .then((data) => {
    clip = data
    renderClipSettings()
  })
  .catch(() => {})

// ปรับช่วงเงียบของคลิปที่ทำไปแล้ว → ตัดต่อใหม่ต่อทันที
$('retimeAudio').addEventListener('click', async () => {
  if (!confirm('ตัดช่วงเงียบของคลิปนี้ให้ชิดตามที่ตั้งไว้ ย้ายเวลาภาพตาม แล้วตัดต่อใหม่?\n(ของเดิมสำรองไว้ในโฟลเดอร์ 02_audio)')) return
  renderRunning = true
  render()
  setStatus('renderStatus', 'กำลังปรับช่วงเงียบ…', 'busy')
  try {
    const app = await connectApp()
    await api(app, '/api/run', { step: 'retime' })
    await new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        const r = (await api(app, '/api/state').catch(() => null))?.run
        if (r?.step !== 'retime') return
        $('renderLog').textContent = r.lines.slice(-30).join('\n')
        $('renderLogBox').hidden = !r.lines.length
        if (r.status === 'running') return
        clearInterval(timer)
        if (r.status === 'done') resolve()
        else reject(new Error(r.lines.at(-1) ?? 'ปรับช่วงเงียบไม่สำเร็จ'))
      }, 1500)
    })
    setStatus('renderStatus', 'ปรับช่วงเงียบแล้ว — กำลังตัดต่อใหม่', 'ok')
    renderRunning = false
    $('startRender').disabled = false
    $('startRender').click()
  } catch (err) {
    renderRunning = false
    setStatus('renderStatus', err.message, 'error')
    render()
  }
})

// ── ตัวละครของฉัน — วางรูปด้วย Ctrl+V · ไม่มี = ใช้ตัวละครตาม Blueprint ──
let character = null

function renderCharacter() {
  if (!character) return
  const list = $('charThumbs')
  list.textContent = ''
  for (const p of character.previews) {
    const li = document.createElement('li')
    const del = Object.assign(document.createElement('button'), { type: 'button', textContent: '✕', title: 'ลบรูปนี้' })
    del.setAttribute('aria-label', 'ลบรูปตัวละครนี้')
    del.addEventListener('click', () => charCall('/api/character/image/delete', { name: p.name }))
    li.append(Object.assign(document.createElement('img'), { src: p.dataUrl, alt: 'รูปตัวละคร' }), del)
    list.append(li)
  }
  if (document.activeElement !== $('charDesc')) $('charDesc').value = character.description
  $('charEnabled').checked = character.enabled
  const has = character.images.length || character.description
  $('charEnabled').disabled = !has
  $('charClear').disabled = !has
  $('charHint').textContent = !has
    ? 'ยังไม่ได้ตั้ง — ใช้ตัวละครตาม Blueprint'
    : character.active
      ? `ใช้ตัวละครนี้กับคลิปใหม่ (${character.images.length} รูป${character.description ? ' + คำอธิบาย' : ''}) — บันทึกไว้แล้ว`
      : 'ปิดไว้ — คลิปใหม่ใช้ตัวละครตาม Blueprint (ตัวละครยังบันทึกไว้)'
  $('charHint').className = `hint${character.active ? ' ok' : ''}`
}

async function charCall(path, body) {
  try {
    character = await api(await localApp(), path, body)
  } catch (err) {
    $('charHint').textContent = err.message
    $('charHint').className = 'hint status error'
    return
  }
  renderCharacter()
}

/** ย่อรูปให้ด้านยาวไม่เกิน 1024px ก่อนเก็บ — แนบไป ChatGPT/Flow ได้เร็ว */
async function imageToUpload(file) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type, quality: 0.92 })).arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { type, base64: btoa(binary) }
}

async function addCharacterFiles(files) {
  const images = [...files].filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type))
  if (!images.length) return false
  $('charHint').textContent = 'กำลังบันทึกรูป…'
  for (const f of images) {
    await charCall('/api/character/image', await imageToUpload(f))
    if (!character?.enabled) await charCall('/api/character', { enabled: true }) // วางรูปใหม่ = ตั้งใจใช้
  }
  return true
}

// Ctrl+V ได้ทั้งในกล่องวางและช่องคำอธิบาย — รูปเป็นรูปตัวละคร ข้อความเป็นคำอธิบาย
for (const el of [$('charPaste'), $('charDesc')]) {
  el.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files ?? [])]
    if (files.length) {
      e.preventDefault()
      await addCharacterFiles(files)
      return
    }
    if (el === $('charPaste')) {
      const text = e.clipboardData?.getData('text/plain')?.trim()
      if (text) {
        e.preventDefault()
        $('charDesc').value = [$('charDesc').value.trim(), text].filter(Boolean).join('\n')
        await charCall('/api/character', { description: $('charDesc').value, enabled: true })
      }
    }
  })
}
$('charPaste').addEventListener('click', (e) => {
  if (!e.target.closest('label')) $('charPaste').focus()
})
$('charPaste').addEventListener('dragover', (e) => {
  e.preventDefault()
  $('charPaste').classList.add('drag')
})
$('charPaste').addEventListener('dragleave', () => $('charPaste').classList.remove('drag'))
$('charPaste').addEventListener('drop', async (e) => {
  e.preventDefault()
  $('charPaste').classList.remove('drag')
  await addCharacterFiles(e.dataTransfer?.files ?? [])
})
$('charFile').addEventListener('change', async (e) => {
  await addCharacterFiles(e.target.files)
  e.target.value = ''
})
$('charDesc').addEventListener('change', () => charCall('/api/character', { description: $('charDesc').value, ...($('charDesc').value.trim() && { enabled: true }) }))
$('charEnabled').addEventListener('change', (e) => charCall('/api/character', { enabled: e.target.checked }))
$('charClear').addEventListener('click', () => {
  if (confirm('ล้างรูปและคำอธิบายตัวละคร? คลิปใหม่จะกลับไปใช้ตัวละครตาม Blueprint')) charCall('/api/character/clear', {})
})

localApp()
  .then((app) => api(app, '/api/character'))
  .then((data) => {
    character = data
    renderCharacter()
  })
  .catch(() => {})

// ── 🧰 ตรวจความพร้อม — ของในเครื่องถามโปรแกรมในเครื่อง ส่วนการล็อกอินเว็บตรวจจากแท็บเอง ──
const CHECK_ICON = { ok: '✓', missing: '✕', warn: '!', info: 'i' }
let checklistTimer = null

async function pingSite(pattern) {
  const [tab] = await chrome.tabs.query({ url: pattern })
  if (!tab) return { open: false }
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }).catch(() => null)
  return { open: true, tabId: tab.id, loggedIn: res?.loggedIn ?? null, responds: !!res }
}

function siteCheck(id, label, site, url, need = 'required') {
  if (!site.open) {
    return { id, group: 'บัญชีเว็บ', label, need, status: 'warn', detail: 'ยังไม่ได้เปิดแท็บ — เปิดเพื่อตรวจว่าล็อกอินแล้วหรือยัง', fix: { text: 'เปิดหน้าเว็บ แล้วกดตรวจใหม่', url, urlLabel: 'เปิดหน้าเว็บ ↗' } }
  }
  if (!site.responds) {
    return { id, group: 'บัญชีเว็บ', label, need, status: 'warn', detail: 'แท็บเปิดอยู่แต่ extension ยังไม่ได้เชื่อมกับหน้านี้', fix: { text: 'รีเฟรชแท็บนั้น (F5) แล้วกดตรวจใหม่', focus: site.tabId } }
  }
  if (site.loggedIn === false) {
    return { id, group: 'บัญชีเว็บ', label, need, status: 'missing', detail: 'ยังไม่ได้ล็อกอิน', fix: { text: 'ล็อกอินด้วยบัญชีของคุณเองในแท็บนั้น แล้วกดตรวจใหม่', focus: site.tabId } }
  }
  return { id, group: 'บัญชีเว็บ', label, need, status: site.loggedIn ? 'ok' : 'info', detail: site.loggedIn ? 'ล็อกอินแล้ว' : 'เปิดอยู่ — ตรวจสถานะล็อกอินไม่ได้ ลองดูในแท็บเอง', fix: null }
}

function checkItem(item) {
  const li = document.createElement('li')
  li.className = `check ${item.status}`
  const label = Object.assign(document.createElement('div'), { className: 'label', textContent: item.label })
  label.append(Object.assign(document.createElement('small'), { textContent: item.need === 'required' ? 'จำเป็น' : 'ทางเลือก' }))
  li.append(
    Object.assign(document.createElement('span'), { className: 'icon', textContent: CHECK_ICON[item.status] ?? '', ariaHidden: 'true' }),
    label,
    Object.assign(document.createElement('div'), { className: 'detail', textContent: item.detail ?? '' }),
  )
  li.setAttribute('aria-label', `${item.label}: ${{ ok: 'พร้อม', missing: 'ยังขาด', warn: 'ควรตรวจ', info: 'ข้อมูล' }[item.status]}`)
  const fix = item.fix
  if (fix && item.status !== 'ok') {
    const box = Object.assign(document.createElement('div'), { className: 'fix', textContent: `วิธีแก้: ${fix.text}` })
    if (fix.command) {
      const code = Object.assign(document.createElement('code'), { textContent: fix.command })
      box.append(document.createElement('br'), code)
    }
    const row = Object.assign(document.createElement('div'), { className: 'controls' })
    if (fix.action === 'setupTts') {
      const b = Object.assign(document.createElement('button'), { className: 'primary', textContent: '▶ ติดตั้งให้เลย' })
      b.addEventListener('click', () => runSetupTts(b))
      row.append(b)
    }
    if (fix.url) {
      const b = Object.assign(document.createElement('button'), { className: 'ghost', textContent: fix.urlLabel ?? 'เปิดหน้าดาวน์โหลด ↗' })
      b.addEventListener('click', () => chrome.tabs.create({ url: fix.url }))
      row.append(b)
    }
    if (fix.focus) {
      const b = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'ไปที่แท็บนั้น' })
      b.addEventListener('click', () => chrome.tabs.update(fix.focus, { active: true }))
      row.append(b)
    }
    if (fix.command) {
      const b = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'คัดลอกคำสั่ง' })
      b.addEventListener('click', async () => {
        await navigator.clipboard.writeText(fix.command).catch(() => {})
        b.textContent = 'คัดลอกแล้ว ✓'
      })
      row.append(b)
    }
    if (row.childElementCount) box.append(row)
    li.append(box)
  }
  return li
}

async function runSetupTts(button) {
  button.disabled = true
  try {
    const app = await localApp()
    await api(app, '/api/run', { step: 'setupTts' })
    clearInterval(checklistTimer)
    checklistTimer = setInterval(async () => {
      const r = (await api(app, '/api/state').catch(() => null))?.run
      if (r?.step !== 'setupTts') return
      if (r.status === 'running') return setStatus('checklistStatus', `กำลังติดตั้งระบบเสียง… ${r.lines.at(-1) ?? ''}`, 'busy')
      clearInterval(checklistTimer)
      setStatus('checklistStatus', r.status === 'done' ? 'ติดตั้งระบบเสียงเสร็จแล้ว' : `ติดตั้งไม่สำเร็จ: ${r.lines.slice(-3).join(' ')}`, r.status === 'done' ? 'ok' : 'error')
      loadChecklist()
    }, 3000)
  } catch (err) {
    button.disabled = false
    setStatus('checklistStatus', err.message, 'error')
  }
}

async function loadChecklist() {
  setStatus('checklistStatus', 'กำลังตรวจ…', 'busy')
  const items = [
    { id: 'extension', group: 'พื้นฐาน', label: 'Extension Cartoon Auto', need: 'required', status: 'ok', detail: `เวอร์ชัน ${chrome.runtime.getManifest().version}` },
  ]
  const app = await chrome.runtime.sendMessage({ type: 'ENSURE_APP' }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
  items.push(
    app?.ok
      ? { id: 'native', group: 'พื้นฐาน', label: 'โปรแกรมในเครื่อง (bridge)', need: 'required', status: 'ok', detail: app.url }
      : {
          id: 'native', group: 'พื้นฐาน', label: 'โปรแกรมในเครื่อง (bridge)', need: 'required', status: 'missing', detail: app?.error ?? 'เปิดไม่ได้',
          fix: { text: 'ลง Node.js ก่อน (ถ้ายังไม่มี) แล้วดับเบิลคลิก ติดตั้งครั้งแรก.bat ในโฟลเดอร์โปรเจกต์ จากนั้นปิดเปิด Chrome', url: 'https://nodejs.org/' },
        },
  )
  const [chat, flow, machine] = await Promise.all([
    pingSite(['https://chatgpt.com/*', 'https://chat.openai.com/*']),
    pingSite('https://flow.google.com/*'),
    app?.ok ? api(app, '/api/checklist').catch((err) => ({ error: err.message })) : null,
  ])
  items.push(siteCheck('chatgpt', 'ChatGPT (เขียนบท กำกับภาพ)', chat, CHATGPT_URL), siteCheck('flow', 'Google Flow (วาดภาพ 0 credits)', flow, 'https://flow.google.com/'))
  if (machine?.items) items.push(...machine.items)
  else if (machine?.error) setStatus('checklistStatus', machine.error, 'error')

  const body = $('checklistBody')
  body.textContent = ''
  const order = ['พื้นฐาน', 'บัญชีเว็บ', 'Extension', 'เสียงพากย์', 'โมเดล (ดาวน์โหลดเองอัตโนมัติ)', 'ตัวเลือกเสริม']
  const groups = [...new Set([...order, ...items.map((i) => i.group)])].filter((g) => items.some((i) => i.group === g))
  for (const g of groups) {
    body.append(Object.assign(document.createElement('h3'), { className: 'checkGroup', textContent: g }))
    const ul = Object.assign(document.createElement('ul'), { className: 'checks' })
    // ข้อที่ขาดขึ้นก่อน
    const rank = { missing: 0, warn: 1, info: 2, ok: 3 }
    for (const item of items.filter((i) => i.group === g).sort((a, b) => rank[a.status] - rank[b.status])) ul.append(checkItem(item))
    body.append(ul)
  }
  const missing = items.filter((i) => i.need === 'required' && i.status === 'missing')
  const warns = items.filter((i) => i.status === 'warn')
  const summary = $('checklistSummary')
  summary.hidden = false
  summary.className = `summary ${missing.length ? 'missing' : 'ok'}`
  summary.textContent = missing.length
    ? `ยังขาด ${missing.length} อย่างที่จำเป็น: ${missing.map((i) => i.label).join(', ')}`
    : `พร้อมใช้งาน${warns.length ? ` · มี ${warns.length} ข้อที่ควรดู` : ''}`
  if (!checklistTimer) setStatus('checklistStatus', `ตรวจเมื่อ ${new Date().toLocaleTimeString('th-TH')}`)
}

$('openChecklist').addEventListener('click', () => {
  $('checklist').hidden = false
  $('closeChecklist').focus()
  loadChecklist()
})
$('closeChecklist').addEventListener('click', () => {
  $('checklist').hidden = true
})
$('recheck').addEventListener('click', loadChecklist)

// ── แบนเนอร์สถานะทีมงาน: ตัวละครที่กำลังทำงานตัวใหญ่ + หัวข้อ + แถวทีมงาน (ใช้ข้อมูลรอบเดียวกับรายละเอียด ไม่ถามเพิ่ม) ──
const studioHero = (() => {
  const hero = $('studioHero')
  const actor = $('heroActor')
  const crew = new Map()
  let actorId = null
  let pinned = null // { id, until } แผนกที่ผู้ใช้กดดู
  let last = null // ข้อมูลรอบล่าสุด — กดดูแล้วแสดงทันทีโดยไม่ต้องถามโปรแกรมในเครื่องใหม่

  for (const d of DEPARTMENTS) {
    const b = Object.assign(document.createElement('button'), { type: 'button' })
    b.dataset.state = 'offline'
    b.append(portrait(d.id))
    b.addEventListener('click', () => {
      pinned = pinned?.id === d.id ? null : { id: d.id, until: Date.now() + 20_000 }
      if (last) update(...last)
    })
    const li = document.createElement('li')
    li.append(b)
    $('heroCrew').append(li)
    crew.set(d.id, b)
  }
  const setActor = (id, state) => {
    if (id !== actorId) {
      actor.replaceChildren(portrait(id))
      actorId = id
    }
    actor.dataset.state = state
    hero.dataset.department = id
  }
  const text = (id, value) => {
    if ($(id).textContent !== value) $(id).textContent = value
  }
  const pauseScene = () => (hero.dataset.hidden = String(document.hidden))
  document.addEventListener('visibilitychange', pauseScene)
  pauseScene()
  // พ้นจอแล้วหยุดเฉพาะภาพ ไม่เพิ่มการถามสถานะ
  const sceneObserver = new IntersectionObserver(([entry]) => {
    hero.dataset.offscreen = String(!entry.isIntersecting)
  })
  sceneObserver.observe(hero)

  // ติดปัญหา → กดแบนเนอร์ไปดูรายละเอียดในกล่องทำคลิปอัตโนมัติ
  hero.querySelector('.heroBanner').addEventListener('click', () => {
    if (hero.dataset.mood !== 'failed') return
    const details = $('autoLogBox')
    if (!details.hidden) details.open = true
    $('autoSection').scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  function update(agents, auto) {
    last = [agents, auto]
    if (pinned && Date.now() > pinned.until) pinned = null
    const byId = new Map(agents.map((a) => [a.id, { ...DEPARTMENTS.find((d) => d.id === a.id), ...a }]))
    const stageIndex = HANDOFF.findIndex((s) => s.key === auto?.current)
    const stage = HANDOFF[stageIndex]
    const failed = ['failed', 'error'].includes(auto?.status)
    const working = agents.filter((a) => a.state === 'working')
    const waiting = agents.filter((a) => a.state === 'waiting')
    const autoRunning = auto?.status === 'running' && !failed
    // ตัวเอกต้องเป็นตัวเดียวกับที่ขยับในแถวทีมงาน: แผนกของขั้นปัจจุบัน (ถ้ากำลังทำ) > แผนกที่กำลังทำจริง > แผนกของขั้นปัจจุบัน > รอคิว > เต่า
    // เช่นขั้นวาดภาพที่ ChatGPT ทำปกอยู่ — ถ้ายึดแผนกของขั้น ตัวบนจะนิ่งทั้งที่ตัวล่างขยับ
    const stageLead = byId.get(stage?.id)
    const lead = byId.get(pinned?.id) ?? (stageLead?.state === 'working' ? stageLead : null) ?? byId.get(working[0]?.id) ?? stageLead ?? byId.get(waiting[0]?.id) ?? byId.get('chatgpt')
    const who = lead ? `${lead.animal} · ${lead.name}` : ''

    let mood = 'idle'
    let title = 'ทีมงานพร้อมเริ่ม'
    let sub = 'สถานะจะอัปเดตเมื่อทีมเริ่มทำงาน'
    if (pinned && lead) {
      // ดูแผนกที่กดเลือก
      mood = lead.state === 'working' ? 'working' : lead.state === 'waiting' ? 'waiting' : lead.state === 'offline' ? 'offline' : 'idle'
      title = `${lead.animal} · ${lead.name}`
      const t = lead.state === 'working' ? elapsed(lead.since) : ''
      sub = `${lead.role} · ${AGENT_WORD[lead.state] ?? 'ไม่ได้ต่อ'}${lead.doing && lead.doing !== 'ว่าง' ? ` · ${lead.doing}` : ''}${t ? ` · ${t}` : ''}`
    } else if (failed) {
      mood = 'failed'
      title = `ติดปัญหาที่${stage?.label ?? 'ทำคลิปอัตโนมัติ'}`
      sub = 'กดทำคลิปอัตโนมัติอีกครั้งเพื่อทำต่อจากจุดนี้ · ดูรายละเอียดด้านล่าง'
    } else if (auto?.status === 'done') {
      mood = 'done'
      title = 'ทำคลิปเสร็จแล้ว 🎉'
      sub = auto.title ?? ''
    } else if (lead?.state === 'working' || autoRunning) {
      // ทำคลิปอัตโนมัติยังวิ่งอยู่ = ทีมกำลังทำงาน แม้ช่วงสั้นๆ ระหว่างงานที่ยังไม่มีแผนกไหนรับงาน
      mood = 'working'
      title = (lead?.state === 'working' && lead.doing) || auto?.departments?.[stage?.key]?.detail || `${lead?.name ?? 'ทีมงาน'}กำลังทำงาน`
      const t = elapsed(lead.since)
      sub = `${who} กำลังทำงาน${t ? ` · ${t}` : ''}`
    } else if (waiting.length) {
      mood = 'waiting'
      title = 'มีงานรอคิว'
      sub = lead?.doing ?? ''
    } else if (agents.every((a) => a.state === 'offline')) {
      mood = 'offline'
      title = 'ทีมงานยังไม่เข้างาน'
      sub = 'เปิดโปรแกรมในเครื่อง หรือกดรีโหลด extension'
    }
    hero.dataset.mood = mood
    // ภาพและสีตามตัวละครที่แสดง ใช้สถานะเดิม ไม่ถามเพิ่ม
    const deptColor = DEPARTMENTS.some(d => d.id === lead?.id) ? lead.id : null
    if (deptColor) document.documentElement.dataset.dept = deptColor
    else delete document.documentElement.dataset.dept
    setActor(lead?.id ?? 'chatgpt', mood === 'working' ? 'working' : mood === 'waiting' ? 'waiting' : mood === 'offline' ? 'offline' : 'idle')
    text('heroTitle', title)
    text('heroSub', sub)
    const p = auto?.progress
    const step = auto ? `⚡ ${auto.title ?? 'ทำคลิปอัตโนมัติ'}${p?.step ? ` · ขั้น ${p.step}/${p.steps} ${p.label}` : stage ? ` · ${stage.label}` : ''}` : ''
    text('heroStep', step)
    $('heroStep').hidden = !step
    // แถบความคืบหน้ารวม: ระหว่างทำคลิปอัตโนมัติ / หยุดไว้ / เสร็จ
    const pct = auto?.status === 'done' ? 100 : p?.percent
    $('heroProgress').hidden = !auto || pct == null
    if (auto && pct != null) {
      text('heroPct', `${pct}%`)
      setBar('heroProgressBar', 'heroBar', pct)
      if (mood === 'working' && !pinned) sub = [p.count, p.etaSec != null ? `เหลือ ${formatEta(p.etaSec)}` : '', sub].filter(Boolean).join(' · ')
      text('heroSub', sub)
    }
    setBadge(auto)

    for (const [id, b] of crew) {
      const a = byId.get(id)
      const state = Object.hasOwn(AGENT_WORD, a?.state) ? a.state : 'offline'
      b.dataset.state = state
      b.dataset.failed = String(failed && stage?.id === id)
      if (id === lead?.id && (pinned || (mood !== 'idle' && mood !== 'offline'))) b.setAttribute('aria-current', 'true')
      else b.removeAttribute('aria-current')
      const label = `${a?.animal ?? ''} · ${a?.name ?? id}: ${AGENT_WORD[state]}${a?.doing ? ` · ${a.doing}` : ''}`
      b.title = label
      b.setAttribute('aria-label', label)
    }

    // แถบติดขอบบนใช้ข้อความและตัวละครชุดเดียวกัน
    text('agentStickyText', `${auto && pct != null ? `${pct}% · ` : ''}${title}${step ? ` · ${step.replace('⚡ ', '')}` : ''}`)
    const dots = $('agentStickyDots')
    if (dots.dataset.lead !== (lead?.id ?? '')) {
      dots.replaceChildren(portrait(lead?.id ?? 'chatgpt'))
      dots.dataset.lead = lead?.id ?? ''
    }
  }
  return { update }
})()

// ── ใครทำอะไรอยู่ — ถามโปรแกรมในเครื่องทุก 3 วิ เฉพาะตอนแผงเปิดอยู่ (อ่านสถานะในหน่วยความจำ ไม่กวนงาน) ──
let agentApp = null
let agentFailAt = 0
let sawAutoRunning = false // รอบก่อนมีทำคลิปอัตโนมัติวิ่งอยู่ไหม — ใช้จับจังหวะที่งานจบ
let agentRefreshing = false

async function refreshAgents() {
  if (document.hidden || agentRefreshing) return
  agentRefreshing = true
  try {
    if (!agentApp) {
      if (Date.now() - agentFailAt < 30_000) return // โปรแกรมในเครื่องยังไม่เปิด — ไม่ต้องถามถี่
      agentApp = await chrome.runtime.sendMessage({ type: 'ENSURE_APP' }).then((a) => (a?.ok ? a : null)).catch(() => null)
      if (!agentApp) agentFailAt = Date.now()
    }
    const data = agentApp ? await api(agentApp, '/api/agents').catch(() => null) : null
    if (!data && agentApp) {
      agentApp = null
      agentFailAt = Date.now()
    }
    const agents = data?.agents ?? [
      { id: 'chatgpt', name: 'ChatGPT', role: 'เขียนบท · กำกับภาพ', state: 'offline', doing: 'โปรแกรมในเครื่องยังไม่เปิด' },
      { id: 'flow', name: 'Google Flow', role: 'วาดภาพ', state: 'offline', doing: 'โปรแกรมในเครื่องยังไม่เปิด' },
      { id: 'voice', name: 'เสียงพากย์', role: 'ในเครื่อง', state: 'offline', doing: '' },
      { id: 'edit', name: 'ตัดต่อ', role: 'ในเครื่อง', state: 'offline', doing: '' },
    ]
    // งานที่แผงสั่งเว็บตรงๆ ไม่ผ่านคิว → เติมจากสถานะของแผง
    const chat = agents.find((a) => a.id === 'chatgpt')
    if (busy && chat && chat.state !== 'working') Object.assign(chat, { state: 'working', doing: 'แผงข้างกำลังถาม ChatGPT' })
    const flowAgent = agents.find((a) => a.id === 'flow')
    if (flowRunning && flowAgent && flowAgent.state !== 'working') Object.assign(flowAgent, { state: 'working', doing: 'แผงข้างกำลังสั่ง Flow' })

    // ใช้ผลที่แผงได้รับอยู่แล้ว เพื่อคงป้ายปัญหาหลังงานหยุด ไม่ถามเพิ่ม
    const finished = agentAutopilot?.title === S.autoTitle && ['failed', 'error', 'done', 'stopped'].includes(agentAutopilot?.status) ? agentAutopilot : null
    if (!document.hidden) {
      studioHero.update(agents, data?.autopilot ?? finished)
    }
    if (data) {
      const nowRunning = data.autopilot?.status === 'running'
      if (sawAutoRunning && !nowRunning && !autoRunning && agentApp) {
        const a = await api(agentApp, '/api/autopilot').catch(() => null)
        if (a?.status?.status === 'done') showFinishedVideo(agentApp, a.slug, { once: true }).catch(() => {})
        else if (a?.status) setResume(a.status, a.last)
      }
      sawAutoRunning = nowRunning
    }
  } finally {
    agentRefreshing = false
  }
}
setInterval(refreshAgents, 3000)
document.addEventListener('visibilitychange', refreshAgents)
refreshAgents()

// แถบเล็กติดขอบบนเมื่อเลื่อนจนแบนเนอร์สถานะพ้นจอ — กดแล้วกลับขึ้นไปดู
{
  const hero = $('studioHero')
  const sticky = $('agentSticky')
  const syncSticky = () => {
    sticky.hidden = hero.getBoundingClientRect().bottom > 0
  }
  addEventListener('scroll', syncSticky, { passive: true })
  addEventListener('resize', syncSticky, { passive: true })
  syncSticky()
  sticky.addEventListener('click', () => hero.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

// คลังวิดีโอ
async function openLibrary() {
  $('library').hidden = false
  $('closeLibrary').focus()
  await loadLibrary()
}

let libraryVideos = []
let libraryApp = null

async function loadLibrary() {
  const list = $('videoList')
  setStatus('libraryStatus', 'กำลังโหลดรายการวิดีโอ…', 'busy')
  try {
    libraryApp = await localApp()
    libraryVideos = (await api(libraryApp, '/api/videos')).videos
    setStatus('libraryStatus', libraryVideos.length ? `${libraryVideos.length} เรื่อง · เรียงจากล่าสุด · กดปกเพื่อดูและจัดการ` : 'ยังไม่มีวิดีโอ — สร้างวิดีโอในขั้นที่ 6 ก่อน')
    renderShelf()
  } catch (err) {
    list.textContent = ''
    setStatus('libraryStatus', err.message, 'error')
  }
}

const libEl = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('aria-') || key.startsWith('data-')) node.setAttribute(key, value)
    else node[key] = value
  }
  node.append(...children)
  return node
}

/** ปกหนึ่งเล่ม — ไม่มีปกใช้ภาพช็อตแทน ไม่มีภาพเลยแสดงชื่อเรื่อง */
function bookCover(app, video, { seconds, button = true } = {}) {
  const node = libEl(button ? 'button' : 'div', button ? { type: 'button', className: 'book' } : { className: 'book' })
  if (video.thumb) {
    node.style.setProperty('--thumb', `url("${mediaUrl(app, video.thumb)}")`)
    node.append(libEl('img', { src: mediaUrl(app, video.thumb), alt: '', loading: 'lazy' }))
  } else {
    node.append(libEl('span', { className: 'noCover', textContent: video.title }))
  }
  if (seconds != null) node.append(libEl('span', { className: 'dur', textContent: fmtDuration(seconds) }))
  return node
}

/** แบ่งเล่มเป็นแถวตามความกว้างแผง — แต่ละแถวมีแผ่นไม้ของตัวเอง */
function renderShelf() {
  const list = $('videoList')
  if (!libraryApp) return
  const width = list.clientWidth || 380
  const cols = Math.max(2, Math.min(6, Math.floor((width - 20) / 118)))
  list.style.setProperty('--cols', cols)
  list.textContent = ''
  for (let i = 0; i < libraryVideos.length; i += cols) {
    const row = libraryVideos.slice(i, i + cols)
    const books = libEl('div', { className: 'shelfBooks' })
    const labels = libEl('div', { className: 'shelfLabels', 'aria-hidden': 'true' })
    for (const video of row) {
      const file = video.files.find((f) => f.main) ?? video.files[0]
      const book = bookCover(libraryApp, video, { seconds: file?.seconds })
      book.setAttribute('aria-label', `${video.title} · ยาว ${fmtDuration(file?.seconds)}`)
      book.title = video.title
      book.addEventListener('click', () => openBookSheet(libraryApp, video, book))
      books.append(book)
      labels.append(libEl('span', { textContent: video.title }))
    }
    list.append(libEl('li', { className: 'shelfRow' }, books, libEl('div', { className: 'plank', 'aria-hidden': 'true' }), labels))
  }
}
new ResizeObserver(() => {
  if (!$('library').hidden && libraryVideos.length) renderShelf()
}).observe($('videoList'))

let bookReturnFocus = null

function closeBookSheet() {
  $('bookSheet').hidden = true
  bookReturnFocus?.focus?.()
  bookReturnFocus = null
}
$('bookSheet').addEventListener('click', (e) => e.target === $('bookSheet') && closeBookSheet())

/** แผ่นรายละเอียดของเล่มที่กด: ปก ชื่อ ข้อมูลไฟล์ เวอร์ชัน และปุ่มจัดการทั้งหมด */
function openBookSheet(app, video, opener) {
  const el = libEl
  let file = video.files.find((f) => f.main) ?? video.files[0]
  bookReturnFocus = opener
  const cover = bookCover(app, video, { seconds: file.seconds, button: false })
  const dur = cover.querySelector('.dur')
  const meta = el('p', { className: 'meta' })
  const updateMeta = () => {
    meta.textContent = `${fmtDate(file.createdAt)} · ${file.mb} MB · ภาพ ${video.images}${video.shots ? `/${video.shots}` : ''} ช็อต`
    if (dur) dur.textContent = fmtDuration(file.seconds)
  }
  updateMeta()
  const info = el('div', {}, el('h2', { id: 'bookSheetTitle', textContent: video.title }), meta)
  const body = el('div', {})
  if (video.files.length > 1) {
    const select = el('select', { title: 'เลือกเวอร์ชัน' })
    select.setAttribute('aria-label', 'เลือกเวอร์ชันของวิดีโอ')
    for (const [i, f] of video.files.entries()) select.append(new Option(`${f.main ? 'ไฟล์หลัก' : f.name} · ${fmtDuration(f.seconds)} · ${f.mb} MB`, i))
    select.value = String(video.files.indexOf(file))
    select.addEventListener('change', () => {
      file = video.files[Number(select.value)]
      updateMeta()
    })
    info.append(select)
  }

  const btn = (text, className, onClick, title) => {
    const b = el('button', { type: 'button', className, textContent: text, title: title ?? '' })
    const name = text.startsWith('▶') ? 'play' : text.startsWith('📂') ? 'folder' : text.startsWith('🗑') ? 'trash' : text.startsWith('🖼') ? 'image' : 'edit'
    setIconLabel(b, name, text === '📂' ? 'เปิดโฟลเดอร์' : text)
    b.addEventListener('click', onClick)
    return b
  }
  const act = async (fn) => {
    try {
      await fn()
    } catch (err) {
      setStatus('libraryStatus', err.message, 'error')
    }
  }

  body.append(
    el(
      'div',
      { className: 'controls' },
      btn('▶ ดู', 'primary', () => {
        closeBookSheet()
        showVideoModal(app, video, file, { success: false })
      }),
      btn('✎ แก้ไข', 'ghost', () => act(async () => {
        await openProject(app, video.slug)
        closeBookSheet()
        $('library').hidden = true
      }), 'เปิดเรื่องนี้ในแผง แก้บท เสียง ภาพ แล้วสร้างวิดีโอใหม่'),
      btn('✏️ เปลี่ยนชื่อ', 'ghost', () => act(async () => {
        const title = prompt('ชื่อเรื่องใหม่', video.title)?.trim()
        if (!title || title === video.title) return
        const res = await api(app, '/api/videos/rename', { slug: video.slug, title })
        if (S.selected?.title === video.title) {
          S.selected = { ...S.selected, title: res.title }
          S.topics = S.topics.map((t) => (t.title === video.title ? { ...t, title: res.title } : t))
          await save()
          render()
        }
        closeBookSheet()
        await loadLibrary()
        setStatus('libraryStatus', `เปลี่ยนชื่อเป็น "${res.title}" แล้ว`, 'ok')
      })),
      ...(video.cover ? [btn('🖼 ดาวน์โหลดปก', 'ghost', () => act(() => downloadCover(app, video.cover, video.title)), 'บันทึกภาพปกคลิป (cover.png)')] : []),
      btn(video.cover ? '🖼 สร้างปกใหม่' : '🖼 สร้างปก', 'ghost', () => act(async () => {
            if (localBusy()) throw new Error('มีงานอื่นทำอยู่ — รอให้เสร็จก่อน')
            if (video.cover && !confirm('สร้างปกใหม่แบบ YouTube thumbnail? ปกเดิมจะถูกแทนที่')) return
            closeBookSheet()
            await makeCover(app, video.slug, (text) => setStatus('libraryStatus', text, 'busy'))
            setStatus('libraryStatus', `ได้ภาพปกของ "${video.title}" แล้ว`, 'ok')
            closeBookSheet()
        await loadLibrary()
          }), 'ให้ Google Flow สร้างภาพปกคลิปจากเนื้อเรื่อง (แนวเดียวกับคลิป)'),
      btn('📂', 'ghost', () => act(() => api(app, '/api/videos/reveal', { slug: video.slug, file: file.name })), 'เปิดโฟลเดอร์ของไฟล์นี้'),
      btn('🗑 ลบไฟล์นี้', 'danger', () => act(async () => {
        if (!confirm(`ลบวิดีโอ "${file.main ? 'ไฟล์หลัก' : file.name}" ของเรื่อง "${video.title}"?\n\nไฟล์จะถูกย้ายไปที่ projects/_trash (กู้คืนได้)`)) return
        await api(app, '/api/videos/delete', { slug: video.slug, file: file.name })
        closeBookSheet()
        await loadLibrary()
        setStatus('libraryStatus', 'ย้ายวิดีโอไปถังขยะแล้ว (projects/_trash)', 'ok')
      })),
      btn('🗑 ลบทั้งเรื่อง', 'danger', () => act(async () => {
        if (!confirm(`ลบทั้งเรื่อง "${video.title}"?\n\nบท เสียง ภาพ และวิดีโอทุกเวอร์ชันจะถูกย้ายไปที่ projects/_trash (กู้คืนได้)`)) return
        await api(app, '/api/videos/delete', { slug: video.slug, wholeProject: true })
        if (S.selected?.title === video.title) {
          Object.assign(S, { selected: null, script: null })
          await save()
          render()
        }
        closeBookSheet()
        await loadLibrary()
        setStatus('libraryStatus', `ย้าย "${video.title}" ไปถังขยะแล้ว (projects/_trash)`, 'ok')
      })),
    ),
  )

  const close = el('button', { type: 'button', className: 'primary sheetClose', textContent: 'ปิด' })
  close.addEventListener('click', closeBookSheet)
  $('bookSheetBody').replaceChildren(el('div', { className: 'sheetHead' }, cover, info), body, close)
  $('bookSheet').hidden = false
  close.focus()
}

$('openLibrary').addEventListener('click', openLibrary)
$('closeLibrary').addEventListener('click', () => {
  $('library').hidden = true
})

// ── คลังเสียง: เลือกเสียงที่ใช้ + เทรนเสียงใหม่ ──
const V = { voices: [], selected: null, choice: null, edge: null, gemini: null, training: null, epochs: 40, loaded: false }
const NEW_VOICE = '__new__'
const STATUS_TEXT = { draft: 'ยังไม่เทรน', training: 'หยุดกลางคัน', failed: 'เทรนไม่สำเร็จ' }
let trainTimer = null
let uploading = false

async function localApp() {
  const app = await chrome.runtime.sendMessage({ type: 'ENSURE_APP' })
  if (!app?.ok) throw new Error(app?.error ?? 'เปิดโปรแกรมในเครื่องไม่สำเร็จ')
  return app
}

async function loadVoices(app) {
  Object.assign(V, await api(app, '/api/voices'), { loaded: true })
  if (V.training && !trainRunning) watchTrain(app, V.training)
  render()
}

function renderVoices() {
  const pick = $('voicePick')
  const target = $('trainTarget')
  const keepTarget = target.value
  pick.textContent = ''
  target.textContent = ''
  if (!V.loaded) pick.append(new Option('กำลังเชื่อมโปรแกรมในเครื่อง…', ''))
  // ช่องเลือกเสียงรวมทุกแหล่ง ค่าเป็น "<engine>:<id>"
  const group = (label) => Object.assign(document.createElement('optgroup'), { label })
  const mine = group('เสียงของเรา (ในเครื่อง)')
  for (const v of V.voices) {
    const note = v.ready ? '' : ` — ${v.id === V.training ? 'กำลังเทรน' : (STATUS_TEXT[v.status] ?? v.status)}`
    const opt = new Option(v.label + note, `my-voice:${v.id}`)
    opt.disabled = !v.ready
    mine.append(opt)
    if (!v.ready) target.append(new Option(v.label + note, v.id))
  }
  if (V.voices.length) pick.append(mine)
  if (V.edge) {
    // พากย์ไทย: ซ่อนเสียงอังกฤษล้วน — อ่านไทยไม่ออก (Microsoft ไม่ส่งเสียงกลับมา) · พากย์อังกฤษ: แสดงครบทุกเสียง
    const thai = (S.language ?? V.language) !== 'en'
    const EDGE_GROUPS = [
      ['thai', 'Edge — เสียงไทย'],
      ['multi', 'Edge — หลายภาษา (พากย์ไทยและอังกฤษได้)'],
      ...(thai ? [] : [['english', 'Edge — อังกฤษ']]),
    ]
    for (const [key, label] of EDGE_GROUPS) {
      const voices = V.edge.voices.filter((v) => (v.group ?? 'english') === key)
      if (!voices.length) continue
      const g = group(label)
      for (const v of voices) {
        const opt = new Option(v.label, `edge:${v.id}`)
        opt.disabled = !V.edge.ready
        g.append(opt)
      }
      pick.append(g)
    }
  }
  if (V.gemini) {
    const g = group(`Gemini — ออนไลน์${V.gemini.hasKey ? '' : ' (ต้องใส่ API key)'}`)
    for (const v of V.gemini.voices) g.append(new Option(v.label, `gemini:${v.id}`))
    pick.append(g)
  }
  const choiceShown = !V.choice || [...pick.options].some((o) => o.value === V.choice)
  if (V.choice && choiceShown) pick.value = V.choice
  const engine = pick.value.split(':')[0]
  $('voiceNote').textContent = {
    'my-voice': 'ปรับได้ทั้งอารมณ์และความเร็ว · ใช้การ์ดจอ',
    edge: 'ปรับได้แค่ความเร็ว (Edge ไม่มีอารมณ์เสียงภาษาไทย) · เร็วมาก ไม่ใช้การ์ดจอ',
    gemini: `อารมณ์และความเร็วส่งเป็นคำสั่งให้ Gemini · โควตาฟรีจำกัดต่อวัน · รุ่น ${V.gemini?.model ?? ''}`,
  }[engine] ?? ''
  // เสียงที่ตั้งไว้เป็นอังกฤษล้วนแต่ตอนนี้พากย์ไทย → ขั้นเสียงจะใช้ Niwat แทนให้เอง บอกให้รู้
  if (!choiceShown) $('voiceNote').textContent = `เสียงที่ตั้งไว้ (${V.choice.split(':').pop()}) พากย์ไทยไม่ได้ — ระบบจะใช้ Niwat แทน หรือเลือกเสียงใหม่จากรายการ`
  $('geminiKeyRow').hidden = !(engine === 'gemini' && !V.gemini?.hasKey)
  $('previewVoice').hidden = engine === 'my-voice' || !V.loaded
  target.prepend(new Option('＋ สร้างเสียงใหม่', NEW_VOICE))
  target.value = [...target.options].some((o) => o.value === keepTarget) ? keepTarget : (V.training ?? NEW_VOICE)

  const locked = busy || localBusy() || uploading
  pick.disabled = locked || !V.loaded
  target.disabled = locked
  const isNew = target.value === NEW_VOICE
  $('newVoiceRow').hidden = !isNew
  $('newVoiceName').disabled = locked

  const voice = V.voices.find((v) => v.id === target.value)
  const list = $('trainFileList')
  list.textContent = ''
  for (const f of voice?.raw ?? []) {
    const li = document.createElement('li')
    const del = Object.assign(document.createElement('button'), { type: 'button', title: 'เอาไฟล์นี้ออก' })
    del.setAttribute('aria-label', `เอาไฟล์ ${f.name} ออก`)
    del.dataset.icon = 'close'
    del.disabled = locked
    del.addEventListener('click', () => removeTrainFile(voice.id, f.name))
    li.append(Object.assign(document.createElement('span'), { textContent: `${f.name} · ${f.mb} MB` }), del)
    list.append(li)
  }

  if (document.activeElement !== $('trainEpochs')) $('trainEpochs').value = V.epochs
  $('trainEpochs').disabled = locked
  $('trainFiles').disabled = locked
  $('startTrain').disabled = locked
  setIconLabel($('startTrain'), 'settings', { training: 'เทรนต่อจากจุดเดิม', failed: 'ลองเทรนอีกครั้ง' }[voice?.status] ?? 'เริ่มเทรน')
  $('stopTrain').disabled = !trainRunning
}

$('voicePick').addEventListener('change', async (e) => {
  const [engine, id] = e.target.value.split(/:(.*)/)
  const label = e.target.selectedOptions[0]?.text ?? id
  $('previewAudio').hidden = true
  try {
    const { choice } = await api(await localApp(), '/api/voices/select', { engine, id })
    V.choice = choice
    setStatus('voiceStatus', `ใช้เสียง: ${label}`, 'ok')
  } catch (err) {
    setStatus('voiceStatus', err.message, 'error')
  }
  render()
})

$('previewVoice').addEventListener('click', async () => {
  const [engine, id] = $('voicePick').value.split(/:(.*)/)
  $('previewVoice').disabled = true
  setStatus('voiceStatus', 'กำลังสร้างเสียงตัวอย่าง…', 'busy')
  try {
    const app = await localApp()
    // ใช้ประโยคแรกของบทจริงถ้ามี จะได้ฟังคำที่จะใช้ในคลิป
    const firstLine = S.script?.text.split('\n').map((l) => l.trim()).find(Boolean)
    // เสียงอังกฤษล้วนอ่านบทไทยไม่ออก → ให้โปรแกรมในเครื่องใช้ประโยคตัวอย่างภาษาอังกฤษแทน
    const englishOnly = engine === 'edge' && V.edge?.voices.find((v) => v.id === id)?.readsThai === false
    const text = englishOnly && /[฀-๿]/.test(firstLine ?? '') ? undefined : firstLine
    const { url } = await api(app, '/api/voices/preview', { engine, id, text, emotion: S.emotion, speed: S.speed })
    $('previewAudio').src = `${app.url}${url.slice(1)}&k=${app.token}`
    $('previewAudio').hidden = false
    $('previewAudio').play().catch(() => {})
    setStatus('voiceStatus', '')
  } catch (err) {
    setStatus('voiceStatus', err.message, 'error')
  } finally {
    $('previewVoice').disabled = false
  }
})

$('saveGeminiKey').addEventListener('click', async () => {
  const key = $('geminiKey').value.trim()
  if (!key) return
  try {
    await api(await localApp(), '/api/gemini-key', { key })
    $('geminiKey').value = ''
    V.gemini.hasKey = true
    setStatus('voiceStatus', 'บันทึก Gemini API key แล้ว', 'ok')
  } catch (err) {
    setStatus('voiceStatus', err.message, 'error')
  }
  render()
})

$('trainTarget').addEventListener('change', () => {
  const voice = V.voices.find((v) => v.id === $('trainTarget').value)
  if (voice?.status === 'failed' && voice.error) setStatus('trainStatus', voice.error, 'error')
  else setStatus('trainStatus', '')
  render()
})

/** เสียงที่จะเทรน — ถ้าเลือก "สร้างเสียงใหม่" ให้สร้างก่อนแล้วสลับไปที่เสียงนั้น */
async function ensureTrainVoice(app) {
  if ($('trainTarget').value !== NEW_VOICE) return $('trainTarget').value
  const label = $('newVoiceName').value.trim()
  if (!label) throw new Error('ตั้งชื่อเสียงก่อน')
  const { id } = await api(app, '/api/voices/create', { label })
  $('newVoiceName').value = ''
  await loadVoices(app)
  $('trainTarget').value = id
  render()
  return id
}

$('trainFiles').addEventListener('change', async (e) => {
  const files = [...e.target.files]
  e.target.value = ''
  if (!files.length) return
  uploading = true
  render()
  try {
    const app = await localApp()
    const id = await ensureTrainVoice(app)
    for (const [i, file] of files.entries()) {
      setStatus('trainStatus', `กำลังส่งไฟล์ ${i + 1}/${files.length}: ${file.name} (${(file.size / 1048576).toFixed(1)} MB)`, 'busy')
      // ส่งเป็นไฟล์ดิบ ไม่แปลง base64 — ไฟล์เทรนใหญ่หลายสิบ MB
      const res = await fetch(`${app.url}api/voices/upload?voice=${encodeURIComponent(id)}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'x-bridge-token': app.token, 'content-type': 'application/octet-stream' },
        body: file,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(`${file.name}: ${data.error ?? res.status}`)
    }
    await loadVoices(app)
    $('trainTarget').value = id
    setStatus('trainStatus', `เพิ่มไฟล์แล้ว ${files.length} ไฟล์ — กดเริ่มเทรนได้เลย`, 'ok')
  } catch (err) {
    setStatus('trainStatus', err.message, 'error')
  } finally {
    uploading = false
    render()
  }
})

async function removeTrainFile(voice, name) {
  try {
    const app = await localApp()
    await api(app, '/api/voices/remove-file', { voice, name })
    await loadVoices(app)
  } catch (err) {
    setStatus('trainStatus', err.message, 'error')
  }
}

/** ติดตามการเทรนจาก bridge — ปิดแผงแล้วเปิดใหม่ก็ตามต่อได้ */
function watchTrain(app, id) {
  clearInterval(trainTimer)
  trainRunning = true
  V.training = id
  $('trainBox').open = true
  render()
  $('trainTarget').value = id
  const tick = async () => {
    let st
    try {
      st = await api(app, '/api/state')
    } catch (err) {
      return setStatus('trainStatus', `ติดต่อโปรแกรมในเครื่องไม่ได้: ${err.message}`, 'error')
    }
    const run = st.run
    if (run?.step !== 'trainVoice') return
    $('trainLog').textContent = run.lines.slice(-60).join('\n')
    $('trainLogBox').hidden = !run.lines.length
    if (run.status === 'running') {
      const stage = [...run.lines].reverse().find((l) => /^\[\d\/5\]/.test(l)) ?? 'เตรียมเทรน'
      const secs = Math.round((Date.now() - run.startedAt) / 1000)
      return setStatus('trainStatus', `${stage} · ผ่านไป ${fmtTime(secs)}`, 'busy')
    }
    clearInterval(trainTimer)
    trainRunning = false
    V.training = null
    await loadVoices(app).catch(() => {})
    if (run.status === 'done') {
      setStatus('trainStatus', 'เทรนเสร็จแล้ว — เลือกเสียงนี้ในช่อง "เสียงที่ใช้" ได้เลย', 'ok')
    } else if (run.status === 'stopped') {
      setStatus('trainStatus', 'หยุดแล้ว — กด "เทรนต่อ" เพื่อเทรนต่อจากจุดเดิม')
    } else {
      $('trainLogBox').open = true
      setStatus('trainStatus', 'เทรนไม่สำเร็จ — ดูรายละเอียดด้านล่าง', 'error')
    }
    render()
  }
  tick()
  trainTimer = setInterval(tick, 3000)
}

$('startTrain').addEventListener('click', async () => {
  uploading = true // ล็อกปุ่มระหว่างส่งคำสั่ง
  render()
  try {
    const app = await localApp()
    const id = await ensureTrainVoice(app)
    if (!V.voices.find((v) => v.id === id)?.raw.length) throw new Error('เลือกไฟล์เสียงสำหรับเทรนก่อน')
    await api(app, '/api/voices/train', { voice: id, epochs: Number($('trainEpochs').value) })
    uploading = false
    watchTrain(app, id)
  } catch (err) {
    uploading = false
    setStatus('trainStatus', err.message, 'error')
    render()
  }
})

$('stopTrain').addEventListener('click', async () => {
  const app = await localApp().catch(() => null)
  if (app) await api(app, '/api/run/stop', {}).catch(() => {})
})

/** เปิดแผงใหม่ระหว่างที่เสียงยังสร้างอยู่ → ต่อการติดตามให้เอง */
async function resumeVoice() {
  const app = await localApp().catch(() => null)
  if (!app) return
  await loadVoices(app).catch((err) => setStatus('voiceStatus', err.message, 'error'))
  if (!S.script) return
  loadShots(app)
  loadTranscript(app)
  const st = await api(app, '/api/state').catch(() => null)
  if (st?.run?.step === 'tts' && st.run.status === 'running') watchVoice(app)
  else if (st?.project?.audio && st.project.slug === slugify(S.selected.title)) {
    $('voiceAudio').src = `${app.url}${st.project.audio.url.slice(1)}&k=${app.token}`
    $('voiceAudio').hidden = false
  }
}

// ── 4–7 โปรแกรมในเครื่อง ──
$('openLocal').addEventListener('click', async () => {
  $('openLocal').disabled = true
  setStatus('localStatus', 'กำลังเปิดโปรแกรมในเครื่อง…', 'busy')
  try {
    const app = await connectApp()
    setStatus('localStatus', '')
    $('app').src = app.url
    $('appView').hidden = false
  } catch (err) {
    setStatus('localStatus', err.message, 'error')
  } finally {
    $('openLocal').disabled = false
  }
})
$('backFromApp').addEventListener('click', () => {
  $('appView').hidden = true
})

// ── ปุ่มเลือกหนึ่งตัว ──
for (const [id, key] of [['titleLang', 'titleLanguage'], ['voLang', 'language'], ['emotion', 'emotion']]) {
  $(id).addEventListener('click', async (e) => {
    const b = e.target.closest('button')
    if (!b || busy || localBusy()) return
    S[key] = b.dataset.value
    await save()
    render()
  })
}

// ── วาดหน้า ──
function render() {
  for (const [id, key] of [['titleLang', 'titleLanguage'], ['voLang', 'language'], ['emotion', 'emotion']]) {
    for (const b of $(id).querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.value === S[key]))
      b.disabled = busy
    }
  }
  $('askTopics').disabled = busy || localBusy()
  setIconLabel($('askTopics'), 'idea', S.topics.length ? 'เริ่มหาหัวข้อใหม่' : 'เริ่มหาหัวข้อ')
  $('stopTopics').disabled = !busy
  $('stopScript').disabled = !busy

  const list = $('topicList')
  list.textContent = ''
  for (const t of S.topics) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'topic'
    btn.disabled = busy
    btn.setAttribute('role', 'radio')
    btn.setAttribute('aria-checked', String(S.selected?.title === t.title))
    btn.append(
      Object.assign(document.createElement('span'), { className: 'num', textContent: t.n }),
      Object.assign(document.createElement('span'), { className: 'title', textContent: t.title }),
    )
    btn.addEventListener('click', () => selectTopic(t))
    const li = document.createElement('li')
    li.append(btn)
    list.append(li)
  }
  $('question').hidden = !S.topics.length

  $('scriptSection').hidden = !S.selected
  if (S.selected) $('pickedTitle').textContent = `หัวข้อ: ${S.selected.title}`
  if (document.activeElement !== $('minutes')) $('minutes').value = S.minutes
  $('minutes').disabled = busy
  $('askScript').disabled = busy || localBusy() || !S.selected
  setIconLabel($('askScript'), 'script', S.script ? 'เริ่มเขียนบทใหม่' : 'เริ่มเขียนบทพากย์')

  const sc = S.script
  $('scriptResult').hidden = !sc
  if (sc) {
    const est = estimateMinutes(sc.text, WORDS_PER_MINUTE)
    $('estMinutes').textContent = est.toFixed(1)
    $('target').textContent = sc.minutes
    $('offTarget').hidden = Math.abs(est - sc.minutes) <= sc.minutes * 0.25
    $('scriptText').textContent = sc.text
  }

  // เสียงสร้างจากบทล่าสุด — ระหว่างสร้างห้ามเขียนบทใหม่ ส่วนเขียนบทอยู่ก็ห้ามเริ่มสร้างเสียง
  $('startVoice').disabled = busy || localBusy() || !sc
  $('startVoice').title = sc ? '' : 'ต้องมีบทพากย์ก่อน'
  $('importFile').disabled = busy || localBusy()
  $('importTitle').disabled = busy || localBusy()
  $('stopVoice').disabled = !voiceRunning
  $('speed').disabled = voiceRunning
  if (document.activeElement !== $('speed')) $('speed').value = S.speed
  for (const b of $('emotion').querySelectorAll('button')) b.disabled = busy || localBusy()

  $('imageSection').hidden = !sc
  $('startShots').disabled = busy || localBusy() || !sc
  setIconLabel($('startShots'), 'shots', shotsData ? 'สร้าง prompt ภาพใหม่' : 'เริ่มสร้าง prompt ภาพ')
  $('resumeShots').disabled = busy || localBusy()
  $('stopShots').disabled = !shotsRunning

  $('flowSection').hidden = !shotsData
  $('startFlow').disabled = busy || localBusy() || !shotsData?.withPrompt
  $('stopFlow').disabled = !flowRunning

  $('renderSection').hidden = !sc
  $('startRender').disabled = busy || localBusy() || !sc
  $('stopRender').disabled = !renderRunning
  $('retimeAudio').disabled = busy || localBusy() || !sc
  renderClipSettings()

  $('startAuto').disabled = busy || localBusy()
  renderTopicMode()
  // ปุ่มหยุด ↔ ทำต่อ
  const resumeMode = !autoRunning && !!autoResume
  $('stopAuto').disabled = !(autoRunning || (resumeMode && !busy && !localBusy()))
  $('stopAuto').className = resumeMode ? 'primary resume' : 'stop'
  // ไอคอนมาจาก data-icon — ไม่ใส่สัญลักษณ์ในข้อความซ้ำ
  $('stopAuto').textContent = resumeMode ? 'ทำต่อ' : 'หยุด'
  $('stopAuto').dataset.icon = resumeMode ? 'next' : 'stop'
  $('stopAuto').title = resumeMode ? `ทำต่อ "${autoResume.title}" จาก${autoResume.stage ?? 'จุดที่ค้าง'}` : 'หยุดไว้ก่อน กดทำต่อได้ภายหลัง'
  $('autoTitle').disabled = autoRunning
  $('autoMinutes').disabled = autoRunning
  if (document.activeElement !== $('autoMinutes')) $('autoMinutes').value = S.minutes
  if (!$('autoTitle').value && S.autoTitle && !autoRunning) $('autoTitle').value = S.autoTitle
  for (const b of $('autoLang').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.value === S.language))
    b.disabled = busy || localBusy()
  }
  const voiceName = V.choice?.startsWith('edge:') ? `Edge · ${V.choice.slice(5)}` : V.choice?.startsWith('gemini:') ? `Gemini · ${V.choice.slice(7)}` : V.selected ? `เสียงของเรา · ${V.voices.find((v) => v.id === V.selected)?.label ?? V.selected}` : null
  $('autoVoice').textContent = voiceName ? `เสียงพากย์: ${voiceName} (เปลี่ยนได้ที่ขั้นที่ 3)` : ''

  $('nextSection').hidden = !sc
  $('currentProject').textContent = S.selected ? S.selected.title : 'ยังไม่มี — เริ่มจากหาหัวข้อ'
  $('openProjects').disabled = busy || localBusy()
  $('openLocal').disabled = busy || localBusy()
  renderVoices()
}

await load()
render()
resumeVoice()
resumeAuto()
