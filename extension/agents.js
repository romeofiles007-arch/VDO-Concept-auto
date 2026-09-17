// สถานะแผนกใช้ภาพและสคริปต์ในส่วนขยายเท่านั้น
export const DEPARTMENTS = [
  { id: 'chatgpt', name: 'ChatGPT', role: 'เขียนบท · กำกับภาพ', animal: 'เต่าทะเล' },
  { id: 'flow', name: 'Google Flow', role: 'วาดภาพ', animal: 'ปลาหมึก' },
  { id: 'voice', name: 'เสียงพากย์', role: 'ในเครื่อง', animal: 'โลมา' },
  { id: 'edit', name: 'ตัดต่อ', role: 'ในเครื่อง', animal: 'ปู' },
]
export const AGENT_WORD = { working: 'กำลังทำงาน', waiting: 'รอคิว', idle: 'ว่าง', offline: 'ไม่ได้ต่อ' }
export const HANDOFF = [
  { key: 'script', id: 'chatgpt', label: 'เขียนบท' },
  { key: 'voice', id: 'voice', label: 'เสียง' },
  { key: 'art', id: 'chatgpt', label: 'กำกับภาพ' },
  { key: 'images', id: 'flow', label: 'วาดภาพ' },
  { key: 'edit', id: 'edit', label: 'ตัดต่อ' },
]

// ภาพ 3D อยู่ในส่วนขยาย ขยับทีละเฟรมด้วย CSS เท่านั้น
export const SEA_ASSETS = { chatgpt: 'turtle', flow: 'octopus', voice: 'dolphin', edit: 'crab' }

export function portrait(id) {
  const span = document.createElement('span')
  span.className = 'sea-portrait'
  span.setAttribute('aria-hidden', 'true')
  const animal = SEA_ASSETS[id] ?? SEA_ASSETS.chatgpt
  // markup คงที่ ไม่รับ HTML จาก API
  span.innerHTML = `<span class="sea-frame"><img class="sea-strip" src="agents/${animal}-work.png" alt="" draggable="false"></span>
    <span class="sea-wait"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h10M7 21h10M8 4v3c0 3 8 7 8 10v3M16 4v3c0 3-8 7-8 10v3"/><path d="M9 18h6"/></svg></span>
    <span class="sea-sweat"><svg viewBox="0 0 20 24" fill="currentColor"><path d="M10 2C7 7 3 12 3 16a7 7 0 0 0 14 0c0-4-4-9-7-14Z"/></svg></span>
    <span class="sea-bubbles"><i></i><i></i></span>`
  const image = span.querySelector('img')
  // รักษาสัดส่วนเฟรมจริง โดยไม่ทำให้ช่องสถานะกระโดด
  const fit = () => {
    if (image.naturalWidth && image.naturalHeight) span.style.setProperty('--sprite-ratio', image.naturalWidth / (4 * image.naturalHeight))
  }
  image.addEventListener('load', fit, { once: true })
  if (image.complete) fit()
  return span
}
const el = (tag, className, text = '') => Object.assign(document.createElement(tag), { className, textContent: text })
const text = (node, value) => { if (node.textContent !== value) node.textContent = value }
export const elapsed = (since, now = Date.now()) => {
  const start = typeof since === 'number' ? since : Date.parse(since)
  if (!Number.isFinite(start) || !since) return ''
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function createAgentsView(bar, onDetails = () => {}) {
  const rows = new Map()
  const list = bar.querySelector('#agentList')
  const dots = bar.querySelector('#agentDots')
  const summary = bar.querySelector('#agentSummary')
  const scene = bar.querySelector('.agentScene')
  const route = bar.querySelector('#agentRoute')
  const routeCaption = bar.querySelector('#agentRouteCaption')
  const steps = []
  // สร้างครั้งเดียว เก็บ node เดิมไว้เพื่อไม่ให้ท่าทางเริ่มใหม่ทุกรอบ
  for (const d of DEPARTMENTS) {
    const row = el('li', 'agent')
    row.dataset.agent = d.id
    row.dataset.state = 'offline'
    const art = portrait(d.id)
    const who = el('span', 'who', d.name)
    const role = el('span', 'agentRole', d.role)
    const doing = el('span', 'doing')
    const state = el('span', 'agentState')
    const time = el('span', 'time')
    const meta = el('span', 'agentMeta')
    meta.append(state, time)
    const error = el('button', 'agentError', 'มีปัญหา · ดูรายละเอียด')
    error.type = 'button'
    error.hidden = true
    error.addEventListener('click', onDetails)
    row.append(art, who, role, doing, meta, error)
    list.append(row)
    const mini = el('span', 'agent-mini')
    mini.dataset.state = 'offline'
    mini.append(portrait(d.id))
    dots.append(mini)
    rows.set(d.id, { row, mini, doing, state, time, error })
  }
  for (const s of HANDOFF) {
    const step = el('li', 'agentStage')
    step.dataset.stage = s.key
    const art = portrait(s.id)
    const label = el('span', 'stageLabel', s.label)
    const link = el('span', 'stageLink')
    link.setAttribute('aria-hidden', 'true')
    link.append(el('i', 'handoffBubble'), el('i', 'handoffBubble'))
    step.append(art, label, link)
    route.append(step)
    steps.push(step)
  }
  const pause = () => { bar.dataset.hidden = String(document.hidden) }
  document.addEventListener('visibilitychange', pause)
  pause()

  function update(data) {
    const agents = DEPARTMENTS.map(d => ({ ...d, state: 'offline', doing: 'โปรแกรมในเครื่องยังไม่เปิด', ...data?.agents?.find(a => a.id === d.id) }))
    const auto = data?.autopilot
    const current = HANDOFF.findIndex(s => s.key === auto?.current)
    const failed = auto?.status === 'failed' || auto?.status === 'error'
    const running = auto?.status === 'running' || auto?.status === 'working'
    for (const a of agents) {
      const r = rows.get(a.id)
      const state = Object.hasOwn(AGENT_WORD, a.state) ? a.state : 'offline'
      const problem = a.failed || a.error || (failed && HANDOFF[current]?.id === a.id) || HANDOFF.some(s => s.id === a.id && auto?.departments?.[s.key]?.status === 'failed')
      r.row.dataset.state = state
      r.mini.dataset.state = state
      r.row.dataset.failed = String(Boolean(problem))
      r.mini.dataset.failed = String(Boolean(problem))
      text(r.state, problem ? 'มีปัญหา' : AGENT_WORD[state])
      text(r.doing, a.doing || (state === 'idle' ? 'พร้อมรับงาน' : AGENT_WORD[state]))
      r.doing.title = a.doing || ''
      const time = state === 'working' || state === 'waiting' ? elapsed(a.since) : ''
      text(r.time, time)
      r.time.title = time ? `ใช้เวลา ${time}` : ''
      r.error.hidden = !problem
      const label = `${a.animal} · ${a.name}: ${problem ? 'มีปัญหา' : AGENT_WORD[state]} · ${r.doing.textContent}${time ? ' · ใช้เวลา ' + time : ''}`
      r.row.setAttribute('aria-label', label)
      r.mini.title = label
    }
    route.hidden = !auto
    routeCaption.hidden = !auto
    route.dataset.running = String(running && !failed)
    for (let i = 0; i < steps.length; i++) {
      const stage = steps[i]
      stage.dataset.state = i === current ? (running ? 'working' : 'idle') : 'idle'
      stage.dataset.current = String(i === current)
      stage.dataset.failed = String(failed && i === current)
      stage.dataset.transfer = String(running && !failed && i === current - 1)
      if (i === current) stage.setAttribute('aria-current', 'step')
      else stage.removeAttribute('aria-current')
      stage.setAttribute('aria-label', `${HANDOFF[i].label}${i === current ? failed ? ' · มีปัญหา' : ' · ขั้นปัจจุบัน' : ''}`)
    }
    const stageName = HANDOFF[current]?.label ?? 'เริ่มงาน'
    text(routeCaption, failed ? `ติดที่${stageName} · กดดูรายละเอียดด้านล่าง` : auto?.status === 'done' ? 'ทำคลิปเสร็จแล้ว' : current > 0 ? `ส่งต่อ: ${HANDOFF[current - 1].label} → ${stageName}` : `ตอนนี้: ${stageName}`)
    const working = agents.filter(a => a.state === 'working')
    const waiting = agents.filter(a => a.state === 'waiting')
    const allOffline = agents.every(a => a.state === 'offline')
    const status = failed ? 'มีปัญหา' : auto?.status === 'done' ? 'ทำเสร็จแล้ว' : working.length ? working.map(a => a.name).join(', ') : waiting.length ? 'มีงานรอคิว' : allOffline ? 'ไม่ได้ต่อ' : 'ว่าง'
    text(summary, auto ? `${auto.title || 'ทำคลิปอัตโนมัติ'} · ${status}` : `ใครทำอะไรอยู่ · ${status}`)
    summary.title = summary.textContent
    scene.dataset.active = String(working.length > 0)
  }
  update(null)
  return { update }
}
