// แผนกนกนางนวล · โหมดโพสต์อัตโนมัติ — หน้าจอในแผงข้าง
// คุยกับ bridge ที่ /api/posting* เท่านั้น (ดู bridge/posting.js) · ไม่แตะสถานะของขั้นทำคลิป
// โทเค็นเพจ/ช่องไม่เคยถูกส่งกลับมาหน้านี้ — bridge ส่งมาแค่ 4 ตัวท้าย

const GULL_SVG = `<svg class="gullIcon" viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6 30c8-9 17-10 24-2 7-8 16-7 26 2" />
  <path d="M30 28c0 6 2 10 6 12l8 2" />
  <circle cx="33" cy="32" r="1.6" fill="currentColor" stroke="none" />
  <path d="M44 42l6-1-5 4" fill="currentColor" />
  <path d="M10 52c6-3 12-3 18 0s12 3 18 0 10-3 14-1" stroke-width="2.4" opacity=".55" />
</svg>`

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith('aria-') || key.startsWith('data-')) node.setAttribute(key, value === true ? '' : value)
    else if (key === 'on') for (const [ev, fn] of Object.entries(value)) node.addEventListener(ev, fn)
    else node[key] = value
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false))
  return node
}

/**
 * รูปโปรไฟล์เพจ Facebook — ลิงก์สาธารณะของ Graph (ใช้แค่ Page ID ไม่ต้องใช้โทเค็น) · โหลดไม่ได้ = ตัวอักษรแรกของชื่อเพจแทน
 * ใส่ on ก่อน src เพื่อให้จับ error ได้ทันแม้รูปโหลดพลาดเร็ว
 */
export const pageAvatarUrl = (pageId) => `https://graph.facebook.com/${encodeURIComponent(pageId)}/picture?type=square&width=96&height=96`
const pageAvatar = (a) => el('img', {
  className: 'pAvatar', alt: '', width: 40, height: 40, loading: 'lazy', referrerPolicy: 'no-referrer', title: a.name,
  on: { error: (e) => e.target.replaceWith(el('span', { className: 'pAvatar pAvatarText', 'aria-hidden': 'true' }, [...String(a.name ?? '?').trim()][0] ?? '?')) },
  src: pageAvatarUrl(a.pageId),
})

const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '')
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '')
/** ค่าให้ <input type=datetime-local> (เวลาเครื่อง) */
const toLocalInput = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** ＋ เพิ่มเวลา: เวลาที่เสนอให้ — ต่อจากเวลาสุดท้าย 3 ชั่วโมง (วนข้ามเที่ยงคืน) ไม่ซ้ำของเดิม */
export function suggestSlot(slots) {
  const mins = slots.map((s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m }).sort((a, b) => a - b)
  if (!mins.length) return '12:00'
  const taken = new Set(mins)
  let t = mins.at(-1)
  for (let i = 0; i < 8; i++) {
    t = (t + 180) % 1440
    if (!taken.has(t)) break
  }
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export function initPosting({ api, localApp }) {
  const root = document.getElementById('posting')
  const body = document.getElementById('postingBody')
  const statusEl = document.getElementById('postingStatus')
  let app = null
  let data = null
  let tab = 'review'
  let timer = null
  let busy = false
  const openVideos = new Set() // id ของคลิปที่กางดูวิดีโอไว้ — คงไว้ข้ามการวาดใหม่
  const openCats = new Set() // บัญชีที่กางรายการหมวดไว้
  const openSlots = new Set() // บัญชีที่กางเวลาโพสต์ของเพจไว้
  const catTimers = new Map()
  const drafts = new Map() // id → {title, description, hashtags} ที่พิมพ์ค้างยังไม่บันทึก
  const saveTimers = new Map()

  function setStatus(text, kind = '') {
    statusEl.className = 'status' + (kind === 'error' ? ' err' : kind === 'ok' ? ' ok' : '')
    statusEl.textContent = ''
    if (kind === 'busy') statusEl.append(el('span', { className: 'spinner' }))
    statusEl.append(text)
  }

  async function call(path, payload, okText) {
    if (busy && payload) return
    busy = !!payload
    try {
      if (payload) setStatus('กำลังบันทึก…', 'busy')
      data = await api(app, path, payload)
      if (payload) setStatus(okText ?? 'บันทึกแล้ว', 'ok')
      render()
      return data
    } catch (err) {
      setStatus(err.message, 'error')
      throw err
    } finally {
      busy = false
    }
  }

  async function open() {
    root.hidden = false
    document.getElementById('closePosting').focus()
    setStatus('กำลังโหลด…', 'busy')
    try {
      app = await localApp()
      data = await api(app, '/api/posting')
      setStatus('')
      render()
    } catch (err) {
      setStatus(err.message, 'error')
    }
    clearInterval(timer)
    timer = setInterval(refresh, 6000)
  }

  function close() {
    root.hidden = true
    clearInterval(timer)
  }

  /** ดึงสถานะใหม่เป็นระยะ — ไม่วาดทับตอนผู้ใช้กำลังพิมพ์/เลือกอยู่ */
  async function refresh() {
    if (root.hidden || busy || !app) return
    const active = document.activeElement
    if (active && root.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return
    if (saveTimers.size || catTimers.size) return
    try {
      data = await api(app, '/api/posting')
      render()
    } catch {}
  }

  // ── ชื่อเพจ/ช่องจากรหัสปลายทาง ──
  function targetList() {
    return [
      ...(data?.facebook ?? []).map((a) => ({ key: `fb:${a.id}`, kind: 'fb', name: a.name })),
      ...(data?.youtube ?? []).filter((a) => a.connected).map((a) => ({ key: `yt:${a.id}`, kind: 'yt', name: a.name })),
    ]
  }
  const targetName = (key) => targetList().find((t) => t.key === key)?.name ?? 'บัญชีที่ถูกลบ'
  const kindTag = (kind) => el('span', { className: `kind ${kind}` }, kind === 'fb' ? 'FB' : 'YT')

  // ── วาดทั้งหน้า ──
  function render() {
    if (!data) return
    const items = data.queue ?? []
    const groups = {
      review: items.filter((q) => q.status === 'review'),
      scheduled: items.filter((q) => q.status === 'scheduled' || q.status === 'posting').sort((a, b) => (a.scheduleAt ?? 0) - (b.scheduleAt ?? 0)),
      posted: items.filter((q) => q.status === 'posted' || q.status === 'failed').sort((a, b) => (b.postedAt ?? b.addedAt) - (a.postedAt ?? a.addedAt)),
      rejected: items.filter((q) => q.status === 'rejected'),
    }
    const failed = groups.posted.filter((q) => q.status === 'failed').length
    const on = !!data.settings.enabledAt
    const accounts = targetList().length

    const hero = el('div', { className: 'pHero' })
    hero.insertAdjacentHTML('afterbegin', GULL_SVG)
    hero.append(
      el('div', {},
        el('h3', {}, 'นกนางนวล · ส่งคลิปขึ้นฝั่ง'),
        el('p', {}, el('span', { className: `pState${on ? '' : ' off'}` }, on ? 'เปิดอยู่' : 'ปิดอยู่'), on ? ' · คลิปที่ทำเสร็จเข้าคิวรอตรวจเอง' : ' · เปิดได้ในแท็บตั้งค่า'),
        el('p', {}, accounts ? `${accounts} ปลายทาง` : 'ยังไม่มีเพจหรือช่อง', data.nextSlot ? ` · ช่องเวลาว่างถัดไป ${fmtWhen(data.nextSlot)}` : '', data.uploading ? ' · กำลังอัปโหลด…' : ''),
      ),
    )

    const tabs = el('div', { className: 'seg pTabs', role: 'tablist', 'aria-label': 'รายการโพสต์' },
      ...[
        ['review', 'รอตรวจ', groups.review.length],
        ['scheduled', 'ตั้งเวลาแล้ว', groups.scheduled.length],
        ['posted', 'โพสต์แล้ว', groups.posted.length, failed],
        ['settings', 'ตั้งค่า', null],
      ].map(([id, label, n, warn]) =>
        el('button', { type: 'button', role: 'tab', 'aria-pressed': String(tab === id), 'aria-selected': String(tab === id), on: { click: () => { tab = id; render() } } },
          label, n != null ? el('span', { className: warn ? 'n bad' : 'n', title: warn ? `${n} คลิป · โพสต์พลาด ${warn}` : undefined }, warn ? `พลาด ${warn}` : String(n)) : null),
      ),
    )

    let panel
    if (tab === 'review') panel = renderReview(groups.review, groups.rejected)
    else if (tab === 'scheduled') panel = renderScheduled(groups.scheduled)
    else if (tab === 'posted') panel = renderPosted(groups.posted)
    else panel = renderSettings()

    body.replaceChildren(hero, tabs, statusEl, panel)
  }

  // ── รอตรวจ ──
  function renderReview(list, rejected) {
    const wrap = el('div', { className: 'pList' })
    if (!targetList().length) {
      wrap.append(el('p', { className: 'pWarn' }, 'ยังไม่มีเพจ Facebook หรือช่อง YouTube — เพิ่มในแท็บตั้งค่าก่อน ถึงจะอนุมัติโพสต์ได้'))
    }
    wrap.append(renderLibrary())
    if (!list.length) wrap.append(el('p', { className: 'pEmpty' }, data.settings.enabledAt ? 'ยังไม่มีคลิปรอตรวจ — คลิปที่ทำเสร็จจะมาอยู่ที่นี่เอง' : 'ยังไม่มีคลิปรอตรวจ — เปิดโหมดในแท็บตั้งค่า หรือเพิ่มคลิปจากคลังด้านบน'))
    const ul = el('ul', { className: 'pList' }, list.map(reviewCard))
    wrap.append(ul)
    if (rejected.length) {
      wrap.append(el('details', {},
        el('summary', {}, `ตีกลับ (${rejected.length})`),
        el('ul', { className: 'pList', style: 'margin-top:8px' }, rejected.map((q) => el('li', { className: 'pCard' },
          head(q),
          el('div', { className: 'pActions' },
            el('button', { type: 'button', className: 'ghost', on: { click: () => call('/api/posting/restore', { id: q.id }, 'ดึงกลับมารอตรวจแล้ว') } }, '↩ ดึงกลับมารอตรวจ'),
            el('button', { type: 'button', className: 'ghost', on: { click: () => call('/api/posting/remove', { id: q.id }, 'เอาออกจากคิวแล้ว') } }, 'เอาออกจากคิว'),
          ))))))
    }
    return wrap
  }

  function renderLibrary() {
    const lib = data.library ?? []
    return el('details', { className: 'pBox' },
      el('summary', {}, `＋ เพิ่มคลิปจากคลังวิดีโอ (${lib.length})`),
      lib.length
        ? el('ul', { className: 'pList pLibrary' }, lib.map((v) => el('li', {},
          v.thumb ? el('img', { className: 'pThumb', src: `${app.url}${v.thumb.slice(1)}&k=${app.token}`, alt: '', loading: 'lazy' }) : el('span', { className: 'pThumb' }),
          el('span', {}, v.title),
          el('button', { type: 'button', className: 'ghost', on: { click: () => call('/api/posting/add', { slug: v.slug, file: v.file }, `เพิ่ม "${v.title}" เข้าคิวแล้ว`) } }, 'เพิ่ม'),
        )))
        : el('p', { className: 'hint' }, 'คลิปทุกเรื่องในคลังอยู่ในคิวแล้ว'),
    )
  }

  function head(q, extra = []) {
    const thumb = q.thumb ? el('img', { className: 'pThumb', src: `${app.url}${q.thumb.slice(1)}&k=${app.token}`, alt: '', loading: 'lazy' }) : el('span', { className: 'pThumb' })
    return el('div', { className: 'pHead' }, thumb,
      el('div', {},
        el('p', { className: 'pTitle' }, q.title),
        el('p', { className: 'pMeta' }, [fmtDur(q.seconds), `เข้าคิว ${fmtWhen(q.addedAt)}`].filter(Boolean).join(' · ')),
        el('div', { className: 'pBadges' }, q.category ? el('span', { className: 'pBadge gold' }, q.category) : null, aiBadge(q), driveBadge(q), q.missing ? el('span', { className: 'pBadge bad' }, 'ไม่พบไฟล์วิดีโอ') : null, ...extra),
      ))
  }

  /** สถานะคลิปบน Google Drive — แสดงเฉพาะตอนเชื่อมต่อ Drive แล้ว */
  function driveBadge(q) {
    const d = q.drive
    if (d?.fileId) return el('a', { className: 'pBadge pass', href: d.link, target: '_blank', rel: 'noopener', title: 'เปิดไฟล์ใน Google Drive' }, 'อยู่บน Drive ↗')
    if (d?.removedAt) return el('span', { className: 'pBadge', title: 'อยู่ในถังขยะของ Drive 30 วัน' }, 'ลบจาก Drive แล้ว')
    if (!data.settings.drive?.connected) return null
    if (d?.error) return el('span', { className: 'pBadge bad', title: d.error }, 'ขึ้น Drive ไม่สำเร็จ')
    if (d?.uploading) return el('span', { className: 'pBadge gold' }, 'กำลังขึ้น Drive…')
    if (['review', 'scheduled', 'failed'].includes(q.status)) return el('span', { className: 'pBadge' }, 'รอขึ้น Drive')
    return null
  }

  function aiBadge(q) {
    const ai = q.ai
    if (!ai) return el('span', { className: 'pBadge' }, 'AI ยังไม่ตรวจ')
    if (ai.status === 'running') return el('span', { className: 'pBadge gold' }, 'AI กำลังตรวจ…')
    if (ai.status === 'error') return el('span', { className: 'pBadge bad' }, 'AI ตรวจไม่สำเร็จ')
    return el('span', { className: `pBadge ${ai.verdict === 'pass' ? 'pass' : 'fix'}` }, `AI ${ai.verdict === 'pass' ? 'ให้ผ่าน' : 'แนะนำให้แก้'} ${ai.score}/100`)
  }

  function aiBlock(q) {
    const ai = q.ai
    const recheck = (label) => el('button', { type: 'button', className: 'ghost', disabled: q.missing, on: { click: () => call('/api/posting/check', { id: q.id }, 'ส่งให้ AI ตรวจแล้ว — รอ ChatGPT ตอบราว 1 นาที').catch(() => {}) } }, label)
    if (!ai) return el('div', { className: 'pAi' }, el('p', {}, 'ให้ ChatGPT ดูภาพจากคลิป 8 ภาพ + บท + ข้อความโพสต์ แล้วบอกจุดที่ควรแก้'), recheck('🤖 ให้ AI ตรวจ'))
    if (ai.status === 'running') return el('div', { className: 'pAi' }, el('p', {}, el('span', { className: 'spinner' }), 'ChatGPT กำลังดูคลิปนี้ (ในแท็บ ChatGPT) …'))
    if (ai.status === 'error') return el('div', { className: 'pAi' }, el('p', { className: 'status err' }, ai.error), recheck('ลองตรวจใหม่'))
    return el('div', { className: 'pAi' },
      el('p', {}, el('strong', {}, ai.verdict === 'pass' ? '✓ ' : '⚠ '), ai.summary || (ai.verdict === 'pass' ? 'ไม่พบปัญหาร้ายแรง' : 'มีจุดที่ควรแก้')),
      ai.issues?.length ? el('ul', {}, ai.issues.map((s) => el('li', {}, s))) : null,
      recheck('ตรวจใหม่'),
    )
  }

  function videoBlock(q) {
    const d = el('details', { open: openVideos.has(q.id) }, el('summary', {}, 'ดูคลิป'))
    const mount = () => {
      if (!d.open || d.querySelector('video') || !q.video) return
      d.append(el('video', { controls: true, preload: 'metadata', src: `${app.url}${q.video.slice(1)}&k=${app.token}` }))
    }
    d.addEventListener('toggle', () => {
      if (d.open) openVideos.add(q.id)
      else openVideos.delete(q.id)
      mount()
    })
    mount()
    return d
  }

  /** บันทึกข้อความโพสต์ที่แก้ (หน่วง 700 ms หลังหยุดพิมพ์) */
  function queueSave(q) {
    clearTimeout(saveTimers.get(q.id))
    saveTimers.set(q.id, setTimeout(async () => {
      saveTimers.delete(q.id)
      const post = drafts.get(q.id)
      if (!post) return
      try {
        data = await api(app, '/api/posting/item', { id: q.id, post })
        drafts.delete(q.id)
        setStatus('บันทึกข้อความโพสต์แล้ว', 'ok')
      } catch (err) {
        setStatus(err.message, 'error')
      }
    }, 700))
  }

  async function flush(q) {
    if (!saveTimers.has(q.id)) return
    clearTimeout(saveTimers.get(q.id))
    saveTimers.delete(q.id)
    const post = drafts.get(q.id)
    if (post) data = await api(app, '/api/posting/item', { id: q.id, post })
    drafts.delete(q.id)
  }

  function postForm(q) {
    const draft = drafts.get(q.id) ?? { title: q.post?.title ?? '', description: q.post?.description ?? '', hashtags: (q.post?.hashtags ?? []).join(' ') }
    const edit = (field, value) => {
      drafts.set(q.id, { ...(drafts.get(q.id) ?? draft), [field]: value })
      queueSave(q)
    }
    const titleInput = el('input', { type: 'text', value: draft.title, maxLength: 200, on: { input: (e) => edit('title', e.target.value) } })
    const options = (q.post?.titles ?? []).filter(Boolean)
    const chips = options.length > 1
      ? el('div', { className: 'pTitles', role: 'group', 'aria-label': 'ชื่อที่ ChatGPT เสนอ' }, options.map((t) => el('button', {
        type: 'button', 'aria-pressed': String(t === draft.title),
        on: { click: (e) => { titleInput.value = t; edit('title', t); e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))) } },
      }, t)))
      : null
    const noText = !q.post?.title && !q.post?.description
    return el('div', { className: 'pList', style: 'gap:8px' },
      noText ? el('p', { className: 'pWarn' }, 'คลิปนี้ยังไม่มีข้อความโพสต์ — พิมพ์เอง หรือกด "คิดชื่อคลิป + คำบรรยาย" ในคลังวิดีโอ') : null,
      el('label', { className: 'pField' }, 'ชื่อโพสต์ (YouTube ใช้ได้ไม่เกิน 100 ตัวอักษร)', titleInput, chips),
      el('label', { className: 'pField' }, 'คำบรรยาย', el('textarea', { value: draft.description, maxLength: 5000, on: { input: (e) => edit('description', e.target.value) } })),
      el('label', { className: 'pField' }, 'แฮชแท็ก (เว้นวรรคระหว่างแท็ก)', el('input', { type: 'text', value: draft.hashtags, on: { input: (e) => edit('hashtags', e.target.value) } })),
    )
  }

  /** หมวดของคลิป — AI ระบุตอนตรวจ หรือเลือกเอง · ใช้เลือกเพจ/ช่องที่รับหมวดนี้ */
  function categoryPicker(q) {
    const select = el('select', {
      'aria-label': 'หมวดของคลิป',
      on: { change: (e) => call('/api/posting/item', { id: q.id, category: e.target.value || null }, 'เปลี่ยนหมวดแล้ว').catch(() => {}) },
    },
    el('option', { value: '', selected: !q.category }, '— ยังไม่รู้หมวด —'),
    (data.categories ?? []).map((c) => el('option', { value: c, selected: q.category === c }, c)))
    const by = q.category ? (q.categoryBy === 'ai' ? ' · AI ระบุ' : ' · เลือกเอง') : q.ai ? '' : ' · AI จะระบุให้ตอนตรวจ'
    return el('label', { className: 'pField' }, `หมวดของคลิป${by}`, select)
  }

  function targetPicker(q) {
    const all = targetList()
    if (!all.length) return el('p', { className: 'hint' }, 'ยังไม่มีเพจหรือช่อง — เพิ่มในแท็บตั้งค่า')
    const chosen = new Set(q.targets ?? [])
    // กฎห้ามโพสต์ซ้ำ: แพลตฟอร์มละ 1 เพจ/ช่อง · แพลตฟอร์มที่คลิปนี้ลงไปแล้วเลือกไม่ได้อีก
    const postedOn = q.postedOn ?? {}
    const PLATFORM = { fb: 'Facebook', yt: 'YouTube' }
    const lockedNote = Object.entries(postedOn).map(([p, v]) => `ลง ${PLATFORM[p] ?? p} แล้วที่ ${v.name ?? v.key}`)
    return el('fieldset', { className: 'pField', style: 'border:0;padding:0;margin:0' },
      el('legend', { style: 'padding:0;margin-bottom:4px' }, 'โพสต์ลง',
        q.targetsEdited
          ? el('span', {}, ' · เลือกเอง ', el('button', { type: 'button', className: 'linkBtn', on: { click: () => call('/api/posting/item', { id: q.id, resetTargets: true }, 'เลือกปลายทางตามหมวดแล้ว').catch(() => {}) } }, 'เลือกตามหมวด'))
          : el('span', {}, q.category ? ' · เลือกตามหมวดให้แล้ว' : ' · เพจ/ช่องที่รับทุกหมวด')),
      el('div', { className: 'pTargets' }, all.map((t) => {
        const locked = !!postedOn[t.kind] && !q.results?.[t.key]?.ok
        return el('label', { className: `pTarget${locked ? ' pLocked' : ''}`, title: locked ? `คลิปนี้ลง ${PLATFORM[t.kind]} ไปแล้ว — ห้ามโพสต์ซ้ำ` : '' },
          el('input', {
            type: 'checkbox', checked: chosen.has(t.key) && !locked, disabled: locked,
            on: { change: (e) => {
              if (e.target.checked) {
                // แพลตฟอร์มเดียวกันเลือกได้เพจเดียว — ติ๊กเพจนี้ = เอาเพจอื่นของแพลตฟอร์มนี้ออก
                for (const k of [...chosen]) if (k.split(':')[0] === t.kind) chosen.delete(k)
                chosen.add(t.key)
              } else chosen.delete(t.key)
              call('/api/posting/item', { id: q.id, targets: [...chosen] }, 'บันทึกปลายทางแล้ว').catch(() => {})
            } },
          }),
          kindTag(t.kind), t.name)
      })),
      el('p', { className: 'hint', style: 'margin:4px 0 0' }, `1 คลิปลงได้ 1 เพจต่อแพลตฟอร์ม (ห้ามคลิปซ้ำ)${lockedNote.length ? ` · ${lockedNote.join(' · ')}` : ''}`),
    )
  }

  function reviewCard(q) {
    // ช่องเวลาต่อเพจ: ช่องว่างถัดไปของเพจที่คลิปนี้จะลง (เพจอื่นช่องเดียวกันได้)
    const slot = q.nextSlot ?? data.nextSlot
    const when = el('input', { type: 'datetime-local', value: toLocalInput(q.scheduleAt ?? slot ?? Date.now() + 3600_000) })
    const approve = async (whenValue, label) => {
      try {
        await flush(q)
        await call('/api/posting/approve', { id: q.id, when: whenValue }, label)
      } catch {}
    }
    const nextLabel = slot ? `✓ อนุมัติ · ${fmtWhen(slot)}` : '✓ อนุมัติ · ช่องเวลาถัดไป'
    return el('li', { className: 'pCard' },
      head(q),
      aiBlock(q),
      videoBlock(q),
      postForm(q),
      categoryPicker(q),
      targetPicker(q),
      el('div', { className: 'pActions' },
        el('button', { type: 'button', className: 'primary', disabled: q.missing, on: { click: () => approve('next', 'อนุมัติแล้ว · ลงช่องเวลาถัดไป') } }, nextLabel),
      ),
      el('div', { className: 'pWhen' },
        el('label', { className: 'pField' }, 'หรือเลือกเวลาเอง', when),
        el('button', { type: 'button', className: 'ghost', disabled: q.missing, on: { click: () => approve(new Date(when.value).getTime(), 'อนุมัติแล้ว · ตั้งเวลาตามที่เลือก') } }, 'อนุมัติตามเวลานี้'),
        el('button', { type: 'button', className: 'ghost', disabled: q.missing, on: { click: () => { if (confirm(`โพสต์ "${q.title}" ตอนนี้เลยไหม?`)) approve('now', 'กำลังโพสต์…') } } }, 'โพสต์ทันที'),
      ),
      el('div', { className: 'pActions' },
        el('button', { type: 'button', className: 'ghost', on: { click: () => { const reason = prompt('ตีกลับเพราะอะไร (เว้นว่างได้)'); if (reason !== null) call('/api/posting/reject', { id: q.id, reason }, 'ตีกลับแล้ว').catch(() => {}) } } }, '✕ ตีกลับ'),
      ),
    )
  }

  // ── ตั้งเวลาแล้ว ──
  function renderScheduled(list) {
    if (!list.length) return el('p', { className: 'pEmpty' }, 'ยังไม่มีคลิปที่ตั้งเวลา — อนุมัติคลิปในแท็บรอตรวจก่อน')
    // ช่องเวลาต่อเพจ: แต่ละเพจลงคลิปของตัวเองในช่องเวลาเดียวกันได้ · ปุ่มนี้จัดเพจและเวลาให้ใหม่ (ไม่แตะที่ติ๊กเพจเอง/เลือกเวลาเอง)
    const tools = el('div', { className: 'pReorg' },
      el('p', { className: 'hint', style: 'margin:0' }, 'ช่องเวลาเดียวกัน ทุกเพจโพสต์พร้อมกันได้ แต่คนละคลิป'),
      el('button', { type: 'button', className: 'ghost', on: { click: () => call('/api/posting/reorganize', {}, 'จัดคิวใหม่แล้ว — กระจายคลิปให้ทุกเพจ').catch(() => {}) } }, '↻ จัดคิวใหม่'))
    return el('div', {}, tools, el('ul', { className: 'pList' }, list.map((q) => {
      const posting = q.status === 'posting'
      const when = el('input', { type: 'datetime-local', value: toLocalInput(q.scheduleAt) })
      return el('li', { className: 'pCard' },
        head(q, [el('span', { className: 'pBadge gold' }, posting ? 'กำลังโพสต์…' : `โพสต์ ${fmtWhen(q.scheduleAt)}`)]),
        el('div', { className: 'pTargets' }, (q.targets ?? []).map((k) => el('span', { className: 'pTarget' }, kindTag(k.slice(0, 2)), targetName(k)))),
        el('p', { className: 'pMeta' }, q.post?.title ?? ''),
        posting
          ? el('p', { className: 'status' }, el('span', { className: 'spinner' }), 'กำลังอัปโหลด — อย่าปิดโปรแกรมในเครื่อง')
          : el('div', { className: 'pWhen' },
            el('label', { className: 'pField' }, 'เปลี่ยนเวลา', when),
            el('button', { type: 'button', className: 'ghost', on: { click: () => call('/api/posting/approve', { id: q.id, when: new Date(when.value).getTime() }, 'เปลี่ยนเวลาแล้ว').catch(() => {}) } }, 'บันทึกเวลา'),
            el('button', { type: 'button', className: 'ghost', on: { click: () => { if (confirm(`โพสต์ "${q.title}" ตอนนี้เลยไหม?`)) call('/api/posting/approve', { id: q.id, when: 'now' }, 'กำลังโพสต์…').catch(() => {}) } } }, 'โพสต์ตอนนี้'),
            el('button', { type: 'button', className: 'ghost', on: { click: () => call('/api/posting/unschedule', { id: q.id }, 'ยกเลิกเวลาแล้ว กลับไปรอตรวจ').catch(() => {}) } }, 'ยกเลิกเวลา'),
          ),
      )
    })))
  }

  // ── โพสต์แล้ว / พลาด ──
  function renderPosted(list) {
    if (!list.length) return el('p', { className: 'pEmpty' }, 'ยังไม่มีคลิปที่โพสต์')
    return el('ul', { className: 'pList' }, list.map((q) => {
      const fail = q.status === 'failed'
      return el('li', { className: `pCard ${fail ? 'fail' : 'done'}` },
        head(q, [el('span', { className: `pBadge ${fail ? 'bad' : 'pass'}` }, fail ? 'โพสต์ไม่สำเร็จ' : `โพสต์แล้ว ${fmtWhen(q.postedAt)}`)]),
        el('ul', { className: 'pResults' }, (q.targets ?? []).map((k) => {
          const r = q.results?.[k]
          return el('li', {}, kindTag(k.slice(0, 2)), el('strong', {}, r?.name ?? targetName(k)),
            r?.ok ? el('a', { href: r.url, target: '_blank', rel: 'noopener' }, 'เปิดโพสต์ ↗') : el('span', { className: 'err' }, r?.error ?? 'ยังไม่ได้โพสต์'),
            r?.ok && r.privacy && r.privacy !== 'public' ? el('span', { className: 'pBadge fix' }, r.privacy === 'private' ? 'ส่วนตัว' : 'ไม่เป็นสาธารณะ') : null)
        })),
        fail && q.error && !Object.keys(q.results ?? {}).length ? el('p', { className: 'status err' }, q.error) : null,
        el('div', { className: 'pActions' },
          fail ? el('button', { type: 'button', className: 'primary', on: { click: () => call('/api/posting/retry', { id: q.id }, 'กำลังลองโพสต์ใหม่ (เฉพาะที่พลาด)…').catch(() => {}) } }, '↻ ลองโพสต์ใหม่เฉพาะที่พลาด') : null,
          el('button', { type: 'button', className: 'ghost', on: { click: () => call('/api/posting/remove', { id: q.id }, 'เอาออกจากรายการแล้ว').catch(() => {}) } }, 'เอาออกจากรายการ'),
        ),
      )
    }))
  }

  // ── ตั้งค่า + บัญชี ──
  /** หมวดที่เพจ/ช่องรับ — ไม่ติ๊กเลย = รับทุกหมวด · บันทึกเองหลังหยุดติ๊ก 0.6 วิ */
  function catPicker(kind, a) {
    const key = `${kind}:${a.id}`
    const cats = new Set(a.categories ?? [])
    const summaryText = () => (cats.size ? `รับ ${cats.size} หมวด: ${[...cats].slice(0, 2).join(', ')}${cats.size > 2 ? ' …' : ''}` : 'รับคลิปทุกหมวด')
    const summary = el('summary', {}, summaryText())
    const save = () => {
      summary.textContent = summaryText()
      clearTimeout(catTimers.get(key))
      catTimers.set(key, setTimeout(async () => {
        catTimers.delete(key)
        try {
          data = await api(app, '/api/posting/account/categories', { kind, id: a.id, categories: [...cats] })
          setStatus(`บันทึกหมวดของ ${a.name} แล้ว — คลิปที่รอตรวจถูกเลือกปลายทางใหม่ตามหมวด`, 'ok')
          render()
        } catch (err) {
          setStatus(err.message, 'error')
        }
      }, 600))
    }
    const boxes = (data.categories ?? []).map((c) => el('label', { className: 'pCat' },
      el('input', { type: 'checkbox', checked: cats.has(c), on: { change: (e) => { if (e.target.checked) cats.add(c); else cats.delete(c); save() } } }), c))
    const d = el('details', { className: 'pCats', open: openCats.has(key) }, summary,
      el('p', { className: 'hint' }, 'ติ๊กหมวดที่ให้ลงบัญชีนี้ — ไม่ติ๊กเลย = ลงทุกหมวด · คลิปที่ AI ยังไม่ระบุหมวดจะลงเฉพาะบัญชีที่รับทุกหมวด'),
      el('div', { className: 'pCatGrid' }, boxes),
      el('button', { type: 'button', className: 'ghost', on: { click: () => { cats.clear(); boxes.forEach((b) => { b.querySelector('input').checked = false }); save() } } }, 'ล้าง = รับทุกหมวด'))
    d.addEventListener('toggle', () => (d.open ? openCats.add(key) : openCats.delete(key)))
    return d
  }

  /** ตารางเวลาโพสต์ประจำวัน: เลือกเวลา/ลบ/เพิ่ม แล้วบันทึกเองทันที (bridge เรียงและตัดตัวซ้ำให้) · ต้องเหลืออย่างน้อย 1 เวลา */
  function slotEditor(list, saveSlots, { head, help, label = '' }) {
    return el('div', { className: 'pSlotBox' },
      el('div', { className: 'pSlotHead' }, head, el('small', {}, help)),
      el('ol', { className: 'pSlots' }, list.map((t, i) => el('li', {},
        el('span', { className: 'pSlotN' }, `ช่อง ${i + 1}`),
        el('input', {
          type: 'time', value: t, step: 300, required: true, 'aria-label': `เวลาช่อง ${i + 1}${label}`,
          on: { change: (e) => { if (e.target.value) saveSlots(list.map((x, j) => (j === i ? e.target.value : x)), `เปลี่ยนเป็น ${e.target.value} น. แล้ว`) } },
        }),
        el('button', {
          type: 'button', className: 'ghost pSlotDel', 'aria-label': `ลบเวลา ${t}${label}`, title: list.length <= 1 ? 'ต้องมีอย่างน้อย 1 เวลา' : `ลบเวลา ${t}`,
          disabled: list.length <= 1,
          on: { click: () => saveSlots(list.filter((_, j) => j !== i), `ลบเวลา ${t} แล้ว`) },
        }, '✕'),
      ))),
      el('button', { type: 'button', className: 'ghost', on: { click: () => { const t = suggestSlot(list); saveSlots([...list, t], `เพิ่มเวลา ${t} น. แล้ว — แตะที่เวลาเพื่อเปลี่ยนได้`) } } }, '＋ เพิ่มเวลา'),
    )
  }

  /** ⏰ เวลาโพสต์ของเพจ/ช่องนี้ — ใช้เวลากลาง หรือตั้งเองต่างจากเพจอื่น (ผู้ใช้: ตั้งค่าแต่ละเพจต่างกันได้) */
  function accountSlots(kind, a) {
    const key = `slots:${kind}:${a.id}`
    const own = a.slots ?? []
    const global = data.settings.slots ?? []
    const save = (next, ok) => call('/api/posting/account/slots', { kind, id: a.id, slots: next }, ok).catch(() => {})
    const d = el('details', { className: 'pCats pAcctSlots', open: openSlots.has(key) },
      el('summary', {}, own.length ? `⏰ เวลาของเพจนี้: ${own.join(', ')}` : `⏰ ใช้เวลากลาง: ${global.join(', ') || 'ยังไม่ได้ตั้ง'}`),
      own.length
        ? el('div', { className: 'pAcctSlotsBody' },
          slotEditor(own, save, { head: `เวลาโพสต์ของ ${a.name}`, help: 'เพจนี้ลงคลิปตามเวลาเหล่านี้แทนเวลากลาง · คลิปที่ตั้งเวลาไว้แล้วย้ายตามให้เอง', label: ` ของ ${a.name}` }),
          el('button', { type: 'button', className: 'linkBtn', on: { click: () => save([], `${a.name} กลับไปใช้เวลากลางแล้ว`) } }, 'กลับไปใช้เวลากลาง'))
        : el('button', { type: 'button', className: 'ghost', on: { click: () => { openSlots.add(key); save(global.length ? [...global] : ['12:00'], `ตั้งเวลาของ ${a.name} เองแล้ว — แก้เวลาได้เลย`) } } }, 'ตั้งเวลาของเพจนี้เอง'),
    )
    d.addEventListener('toggle', () => (d.open ? openSlots.add(key) : openSlots.delete(key)))
    return d
  }

  function renderSettings() {
    const s = data.settings
    const toggle = (key, label, help, checked) => el('label', { className: 'pSwitch' },
      el('input', { type: 'checkbox', checked, on: { change: (e) => call('/api/posting/settings', { [key]: e.target.checked }, 'บันทึกแล้ว').catch(() => {}) } }),
      el('span', {}, label, el('small', {}, help)))
    // ช่องเวลาประจำวัน: ตาราง เลือกเวลา/ลบ/เพิ่ม แล้วบันทึกเองทันที (bridge เรียงและตัดตัวซ้ำให้)
    const saveSlots = (next, ok) => call('/api/posting/settings', { slots: next }, ok).catch(() => {})
    const slotTable = slotEditor(s.slots ?? [], saveSlots, {
      head: 'เวลาโพสต์กลาง (ทุกเพจ)',
      help: 'เพจที่ไม่ได้ตั้งเวลาเองใช้เวลานี้ · ตั้งเวลาเฉพาะเพจได้ที่การ์ดของเพจด้านล่าง · เวลาเดียวกันทุกเพจลงคนละคลิป · แต่ละเพจเว้นอย่างน้อย 30 นาที',
    })

    const mode = el('section', { className: 'pBox', 'aria-label': 'การทำงาน' },
      el('h3', {}, 'การทำงาน'),
      toggle('enabled', 'เปิดโหมดโพสต์อัตโนมัติ', 'คลิปที่ทำเสร็จหลังจากนี้เข้าคิวรอตรวจเอง (คลิปเก่าเพิ่มจากคลังได้)', !!s.enabledAt),
      toggle('autoCheck', 'ให้ AI ตรวจเองเมื่อคลิปเข้าคิว', 'ใช้ ChatGPT ในแท็บเดิม · ตรวจเฉพาะตอนไม่มีงานทำคลิปค้างอยู่ ไม่แย่งคิว', !!s.autoCheck),
      toggle('autoApprove', 'อนุมัติเองเมื่อ AI ให้ผ่าน', 'คลิปที่ AI ให้ผ่านลงช่องเวลาถัดไปเลยโดยไม่ต้องกด — ปิดไว้ถ้าอยากดูทุกคลิปก่อน', !!s.autoApprove),
      slotTable,
      el('p', { className: 'hint' }, 'โปรแกรมในเครื่องต้องเปิดอยู่ตอนถึงเวลาโพสต์ — ถ้าปิดไว้ คลิปจะโพสต์ทันทีที่เปิดโปรแกรมครั้งถัดไป'),
    )

    // Facebook
    const pageId = el('input', { type: 'text', inputMode: 'numeric', placeholder: 'เช่น 102345678901234', autocomplete: 'off' })
    const pageToken = el('input', { type: 'password', placeholder: 'EAAB…', autocomplete: 'off' })
    const pageName = el('input', { type: 'text', placeholder: 'เว้นว่าง = ใช้ชื่อเพจจริง' })
    const fb = el('section', { className: 'pBox', 'aria-label': 'Facebook Page' },
      el('h3', {}, kindTag('fb'), 'Facebook Page'),
      data.facebook.length
        ? el('ul', { className: 'pAccounts' }, data.facebook.map((a) => el('li', {},
          pageAvatar(a), el('strong', {}, a.name), el('span', { className: 'pMeta' }, `ID ${a.pageId} · โทเค็น ${a.token}`),
          el('button', { type: 'button', className: 'ghost', on: { click: () => { if (confirm(`ลบเพจ "${a.name}" ออกจากโหมดโพสต์? (โทเค็นจะถูกลบจากเครื่องนี้)`)) call('/api/posting/facebook/remove', { id: a.id }, 'ลบเพจแล้ว').catch(() => {}) } } }, 'ลบ'),
          catPicker('facebook', a), accountSlots('facebook', a))))
        : el('p', { className: 'hint' }, 'ยังไม่มีเพจ'),
      el('div', { className: 'pGrid2' },
        el('label', { className: 'pField' }, 'Page ID', pageId),
        el('label', { className: 'pField' }, 'ชื่อเรียก (ไม่บังคับ)', pageName),
      ),
      el('label', { className: 'pField' }, 'Page access token', pageToken),
      el('button', {
        type: 'button', className: 'primary',
        on: { click: async () => {
          try {
            await call('/api/posting/facebook', { pageId: pageId.value.trim(), token: pageToken.value.trim(), name: pageName.value.trim() }, 'ตรวจโทเค็นผ่าน · บันทึกเพจแล้ว')
          } catch {}
        } },
      }, 'ตรวจโทเค็นและบันทึกเพจ'),
      el('details', {}, el('summary', {}, 'หา Page ID และ Page access token ยังไง'),
        el('ol', {},
          el('li', {}, 'Page ID: เปิดเพจ → เกี่ยวกับ (About) → ความโปร่งใสของเพจ จะเห็นรหัสเพจเป็นตัวเลข'),
          el('li', {}, 'สร้างแอปที่ developers.facebook.com (ประเภท Business) แล้วเปิด Graph API Explorer'),
          el('li', {}, 'เลือกแอป → Get Page Access Token → ติ๊กสิทธิ์ pages_show_list, pages_read_engagement, pages_manage_posts → เลือกเพจ'),
          el('li', {}, 'อยากให้โทเค็นไม่หมดอายุ: แลกเป็น long-lived user token ใน Access Token Debugger ก่อน แล้วค่อยขอ Page token จากโทเค็นนั้น'),
          el('li', {}, 'คัดลอกโทเค็นของเพจมาวางด้านบน — เก็บไว้ในเครื่องนี้เท่านั้น ไม่ขึ้น GitHub ไม่อยู่ในแพ็กเกจลูกค้า'),
        )),
    )

    // YouTube
    const g = s.google
    const clientId = el('input', { type: 'text', value: g.clientId ?? '', placeholder: '….apps.googleusercontent.com', autocomplete: 'off' })
    const clientSecret = el('input', { type: 'password', value: g.clientSecret ?? '', placeholder: 'GOCSPX-…', autocomplete: 'off' })
    const yt = el('section', { className: 'pBox', 'aria-label': 'YouTube' },
      el('h3', {}, kindTag('yt'), 'ช่อง YouTube'),
      data.youtube.length
        ? el('ul', { className: 'pAccounts' }, data.youtube.map((a) => el('li', {},
          el('strong', {}, a.name),
          el('select', {
            'aria-label': `การมองเห็นของคลิปใน ${a.name}`,
            on: { change: (e) => call('/api/posting/youtube/update', { id: a.id, privacy: e.target.value }, 'บันทึกแล้ว').catch(() => {}) },
          }, [['public', 'สาธารณะ'], ['unlisted', 'ไม่เป็นสาธารณะ'], ['private', 'ส่วนตัว']].map(([v, t]) => el('option', { value: v, selected: a.privacy === v }, t))),
          a.connected ? null : el('span', { className: 'pBadge bad' }, 'ต้องเชื่อมต่อใหม่'),
          el('button', { type: 'button', className: 'ghost', on: { click: () => { if (confirm(`ลบช่อง "${a.name}" ออกจากโหมดโพสต์?`)) call('/api/posting/youtube/remove', { id: a.id }, 'ลบช่องแล้ว').catch(() => {}) } } }, 'ลบ'),
          catPicker('youtube', a), accountSlots('youtube', a))))
        : el('p', { className: 'hint' }, 'ยังไม่มีช่อง'),
      el('button', {
        type: 'button', className: 'primary', disabled: !g.ready,
        on: { click: async () => {
          try {
            const { url } = await api(app, '/api/posting/youtube/connect', {})
            setStatus('เลือกบัญชี/ช่องในแท็บที่เปิดขึ้น แล้วกดอนุญาต — เสร็จแล้วกลับมาที่นี่', 'busy')
            chrome.tabs.create({ url })
          } catch (err) {
            setStatus(err.message, 'error')
          }
        } },
      }, '＋ เชื่อมต่อช่อง YouTube'),
      g.ready ? null : el('p', { className: 'hint' }, 'ใส่ Google OAuth client ด้านล่างก่อน ถึงจะเชื่อมต่อช่องได้'),
      el('div', { className: 'pGrid2' },
        el('label', { className: 'pField' }, 'Google Client ID', clientId),
        el('label', { className: 'pField' }, 'Client secret', clientSecret),
      ),
      el('button', { type: 'button', className: 'ghost', on: { click: () => call('/api/posting/google', { clientId: clientId.value.trim(), clientSecret: clientSecret.value.trim() }, 'บันทึก Google client แล้ว').catch(() => {}) } }, 'บันทึก Google client'),
      el('details', {}, el('summary', {}, 'สร้าง Google OAuth client ยังไง'),
        el('ol', {},
          el('li', {}, 'เข้า console.cloud.google.com → สร้างโปรเจกต์ใหม่'),
          el('li', {}, 'APIs & Services → Library → เปิด YouTube Data API v3'),
          el('li', {}, 'OAuth consent screen → External → ใส่ชื่อแอป + อีเมล → เพิ่มอีเมลตัวเองเป็น Test user'),
          el('li', {}, 'Credentials → Create credentials → OAuth client ID → ประเภท Desktop app → คัดลอก Client ID และ Client secret มาวาง'),
          el('li', {}, 'กด Publish app ในหน้า consent screen (เป็น In production) — ถ้าค้างเป็น Testing การเชื่อมต่อช่องจะหมดอายุทุก 7 วัน'),
        )),
      el('p', { className: 'pWarn' }, 'ข้อจำกัดของ YouTube: โปรเจกต์ Google ที่ยังไม่ผ่านการตรวจ (audit) จะถูกล็อกคลิปที่อัปโหลดผ่าน API เป็น "ส่วนตัว" และโควตาฟรีอัปโหลดได้ราววันละ 6 คลิป — ยื่นตรวจได้ที่หน้า YouTube API Services Audit'),
    )

    // Google Drive — Google client ของตัวเอง แยกจาก YouTube (อาจคนละบัญชี/คนละโปรเจกต์)
    const dr = s.drive ?? { connected: false }
    const dc = s.driveClient ?? { ready: false }
    const driveId = el('input', { type: 'text', value: dc.clientId ?? '', placeholder: '….apps.googleusercontent.com', autocomplete: 'off' })
    const driveSecret = el('input', { type: 'password', value: dc.clientSecret ?? '', placeholder: 'GOCSPX-…', autocomplete: 'off' })
    const connectDrive = async () => {
      try {
        const { url } = await api(app, '/api/posting/drive/connect', {})
        setStatus('เลือกบัญชี Google ในแท็บที่เปิดขึ้น แล้วกดอนุญาต — เสร็จแล้วกลับมาที่นี่', 'busy')
        chrome.tabs.create({ url })
      } catch (err) {
        setStatus(err.message, 'error')
      }
    }
    const driveBox = el('section', { className: 'pBox', 'aria-label': 'Google Drive' },
      el('h3', {}, el('span', { className: 'kind drive' }, 'DR'), 'Google Drive · ที่พักคลิป'),
      el('p', { className: 'hint' }, 'คลิปที่เข้าคิวจะอัปขึ้นโฟลเดอร์ "Cartoon Auto · รอโพสต์" เอง และย้ายไปถังขยะของ Drive เมื่อโพสต์ครบทุกที่ (รวมคลิปที่ตีกลับหรือเอาออกจากคิว) — ไฟล์ในเครื่องไม่ถูกลบ'),
      dr.connected
        ? el('ul', { className: 'pAccounts' }, el('li', {},
          el('strong', {}, dr.email || dr.name),
          dr.folderLink ? el('a', { href: dr.folderLink, target: '_blank', rel: 'noopener', className: 'ghost' }, 'เปิดโฟลเดอร์ ↗') : el('span', { className: 'pMeta' }, 'สร้างโฟลเดอร์ตอนอัปคลิปแรก'),
          el('button', { type: 'button', className: 'ghost', on: { click: () => { if (confirm('เลิกเชื่อมต่อ Google Drive? คลิปที่อยู่บน Drive แล้วจะไม่ถูกลบเอง ต้องลบในโฟลเดอร์เอง')) call('/api/posting/drive/remove', {}, 'เลิกเชื่อมต่อ Drive แล้ว').catch(() => {}) } } }, 'เลิกเชื่อมต่อ')))
        : el('button', { type: 'button', className: 'primary', disabled: !dc.ready, on: { click: connectDrive } }, '＋ เชื่อมต่อ Google Drive'),
      dr.connected ? el('button', { type: 'button', className: 'ghost', on: { click: connectDrive } }, 'เปลี่ยนบัญชี / เชื่อมต่อใหม่') : null,
      dc.ready ? null : el('p', { className: 'hint' }, 'ใส่ Client ID และ Client secret ของ Drive ด้านล่างก่อน ถึงจะเชื่อมต่อได้'),
      el('div', { className: 'pGrid2' },
        el('label', { className: 'pField' }, 'Drive · Client ID', driveId),
        el('label', { className: 'pField' }, 'Drive · Client secret', driveSecret),
      ),
      el('button', { type: 'button', className: 'ghost', on: { click: () => call('/api/posting/drive/client', { clientId: driveId.value.trim(), clientSecret: driveSecret.value.trim() }, 'บันทึก Google client ของ Drive แล้ว').catch(() => {}) } }, 'บันทึก Google client ของ Drive'),
      el('details', {}, el('summary', {}, 'สร้าง Google client สำหรับ Drive ยังไง'),
        el('ol', {},
          el('li', {}, 'เข้า console.cloud.google.com ด้วยบัญชีที่จะเก็บคลิป (จะเป็นบัญชีเดียวกับ YouTube หรือคนละบัญชีก็ได้)'),
          el('li', {}, 'สร้างโปรเจกต์ (หรือใช้โปรเจกต์เดิม) → APIs & Services → Library → เปิด Google Drive API'),
          el('li', {}, 'OAuth consent screen → External → เพิ่มอีเมลบัญชีที่จะเก็บคลิปเป็น Test user แล้วกด Publish app'),
          el('li', {}, 'Credentials → Create credentials → OAuth client ID → Desktop app → คัดลอก Client ID และ Client secret มาวางด้านบน'),
        )),
      el('p', { className: 'hint' }, 'สิทธิ์ที่ขอเห็นได้เฉพาะไฟล์ที่โปรแกรมนี้อัปเอง ไม่เห็นไฟล์อื่นใน Drive · เปลี่ยน Client ID แล้วต้องกดเชื่อมต่อใหม่'),
    )

    return el('div', { className: 'pList' }, mode, fb, yt, driveBox)
  }

  document.getElementById('closePosting').addEventListener('click', close)
  document.getElementById('refreshPosting').addEventListener('click', () => refresh())
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close()
  })
  // กลับมาจากแท็บเชื่อมต่อ Google → ดึงรายการช่องใหม่
  window.addEventListener('focus', () => refresh())

  return { open }
}
