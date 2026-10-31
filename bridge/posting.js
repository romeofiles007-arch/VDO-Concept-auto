/**
 * แผนกนกนางนวล — โหมดโพสต์อัตโนมัติบน bridge
 *
 *   คลิปทำเสร็จ → เข้าคิว "รอตรวจ" → AI ตรวจ (ChatGPT ผ่านหน้าเว็บ) + คนตรวจ → อนุมัติ + ตั้งเวลา → โพสต์ Facebook Page / YouTube
 *
 * แยกจากขั้นทำคลิปทั้งหมด: อ่านคลิปจากคลังวิดีโอเท่านั้น ไม่แก้ไฟล์ของ project
 * งาน AI ตรวจเข้าคิว ChatGPT เดียวกับขั้นอื่น (ทุกงานเปิดแชตใหม่ จึงไม่ปนกัน) และตรวจเองเฉพาะตอนคิว ChatGPT ว่าง — ไม่หน่วงการทำคลิป
 * bridge ต้องเปิดอยู่ตอนถึงเวลาโพสต์ (คนโพสต์คือเครื่องนี้)
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ROOT } from '../pipeline/lib/config.mjs'
import { run } from '../pipeline/lib/ffmpeg.mjs'
import { clipSource, readPost } from '../pipeline/lib/post.mjs'
import {
  POSTING_DIR, loadAccounts, updateAccounts, publicAccounts, allTargets, findTarget, newId, cleanSlots, targetsFor, cleanCategories, CATEGORIES,
  loadQueue, saveQueue, newItem, postFromFile, cleanHashtags, videosToEnroll, caption, nextFreeSlot, dueItems,
  frameTimes, qcPrompt, parseQc, STATUS, nextDriveUpload, driveToTrash,
} from '../pipeline/lib/posting.mjs'
import { facebookPageInfo, facebookUpload, youtubeAuthUrl, youtubeConnect, youtubeUpload, DRIVE_SCOPES, driveConnect, driveUpload, driveTrash } from '../pipeline/lib/social.mjs'
import { listVideos } from './videos.js'

const PROJECTS = join(ROOT, 'projects')
const TICK_MS = 30_000
const ENROLL_EVERY_MS = 2 * 60_000
const OAUTH_TTL_MS = 15 * 60_000

export function createPosting({ jobs, enqueue, json, readBody, log, port, token, pipelineBusy = () => false, scheduler = true, deps = {} }) {
  const fb = { info: deps.facebookPageInfo ?? facebookPageInfo, upload: deps.facebookUpload ?? facebookUpload }
  const yt = { connect: deps.youtubeConnect ?? youtubeConnect, upload: deps.youtubeUpload ?? youtubeUpload }
  const drive = { connect: deps.driveConnect ?? driveConnect, upload: deps.driveUpload ?? driveUpload, trash: deps.driveTrash ?? driveTrash }
  const videosOf = deps.listVideos ?? listVideos
  const redirectUri = `http://127.0.0.1:${port}`
  const oauthStates = new Map() // state → { expires, kind: 'youtube' | 'drive' }
  let uploading = false
  let driveBusy = false
  let ticking = false
  let lastEnroll = 0

  // โปรแกรมถูกปิดกลางการโพสต์ → ไม่รู้ว่าขึ้นไปแล้วหรือยัง ห้ามโพสต์ซ้ำเอง ให้คนดูในเพจก่อนกดลองใหม่
  {
    const queue = loadQueue()
    let changed = false
    for (const q of queue) {
      if (q.status === 'posting') {
        q.status = 'failed'
        q.error = 'โปรแกรมถูกปิดระหว่างโพสต์ — ดูในเพจ/ช่องก่อนว่าขึ้นไปแล้วหรือยัง แล้วค่อยกดลองใหม่'
        changed = true
      }
    }
    if (changed) saveQueue(queue)
  }

  const note = (item, text) => {
    item.history = [...(item.history ?? []), { at: Date.now(), text }].slice(-30)
  }

  function mutateItem(id, fn) {
    const queue = loadQueue()
    const item = queue.find((q) => q.id === id)
    if (!item) throw new Error('ไม่พบคลิปนี้ในคิว')
    const out = fn(item, queue)
    saveQueue(queue)
    return out ?? item
  }

  const videoPath = (item) => join(PROJECTS, item.slug, '06_render', item.file)

  /** เพจ/ช่องที่เพิ่งเพิ่ม → ติ๊กให้คลิปที่ยังรอตรวจทุกคลิป (ค่าเริ่มต้น "ลงทุกที่") */
  /**
   * คลิปที่ยังรอตรวจและผู้ใช้ยังไม่ได้ติ๊กปลายทางเอง → เลือกเพจ/ช่องใหม่ตามหมวดของคลิป
   * เรียกหลังเพิ่ม/ลบบัญชี หรือเปลี่ยนหมวดที่บัญชีรับ (คลิปที่อนุมัติแล้วไม่เปลี่ยน)
   */
  function retarget() {
    const data = loadAccounts()
    saveQueue(loadQueue().map((q) => (q.status === 'review' && !q.targetsEdited ? { ...q, targets: targetsFor(data, q.category) } : q)))
  }

  // ── เข้าคิวเอง ──
  async function enroll({ force = false } = {}) {
    if (!force && Date.now() - lastEnroll < ENROLL_EVERY_MS) return
    lastEnroll = Date.now()
    const { settings } = loadAccounts()
    if (!settings.enabledAt) return
    const fresh = videosToEnroll(await videosOf(), loadQueue(), settings.enabledAt)
    if (!fresh.length) return
    // ยังไม่รู้หมวด → ไปเฉพาะเพจ/ช่องที่รับทุกหมวด · AI ระบุหมวดตอนตรวจแล้วค่อยเลือกให้ใหม่
    const targets = targetsFor(loadAccounts(), null)
    const queue = loadQueue()
    for (const v of fresh) {
      const item = newItem({ ...v, post: readPost(v.slug), targets })
      note(item, 'คลิปทำเสร็จ เข้าคิวรอตรวจ')
      queue.push(item)
      log(`โพสต์อัตโนมัติ: "${v.title}" เข้าคิวรอตรวจ`)
    }
    saveQueue(queue)
  }

  /**
   * 🏭 ผลิตต่อเนื่อง: คลิปเสร็จ → เข้าคิวทันที (ไม่ต้องรอรอบดึงคลิป 2 นาที / ไม่ต้องเปิดโหมดโพสต์ทั้งระบบ)
   *   mode 'ai'  = AI ตรวจก่อน ผ่านแล้วลงช่องเวลาถัดไปเอง (ไม่ผ่าน → รอคนตรวจ)
   *   mode 'now' = ลงช่องเวลาถัดไปทันที ไม่ตรวจ
   */
  async function enqueueAuto(slug, mode = 'ai') {
    const video = (await videosOf()).find((v) => v.slug === slug)
    const main = video?.files?.find((f) => f.name === `${slug}.mp4`) ?? video?.files?.[0]
    if (!main) throw new Error('ไม่พบไฟล์วิดีโอของคลิปนี้')
    const queue = loadQueue()
    let item = queue.find((q) => q.slug === slug && q.file === main.name)
    if (!item) {
      item = newItem({ slug, file: main.name, title: video.title ?? slug, post: readPost(slug), targets: targetsFor(loadAccounts(), null) })
      queue.push(item)
    }
    item.auto = mode
    note(item, mode === 'now' ? 'ผลิตต่อเนื่อง: เข้าคิว → ตั้งเวลาโพสต์เองทันที' : 'ผลิตต่อเนื่อง: เข้าคิว → AI ตรวจ ผ่านแล้วตั้งเวลาเอง')
    saveQueue(queue)
    log(`โพสต์อัตโนมัติ: "${item.title}" เข้าคิวจากผลิตต่อเนื่อง (${mode === 'now' ? 'ตั้งเวลาทันที' : 'AI ตรวจก่อน'})`)
    scheduleAuto()
    return loadQueue().find((q) => q.id === item.id)
  }

  /** คลิปจากผลิตต่อเนื่องที่พร้อมแล้ว → ลงช่องเวลาถัดไปเอง (เรียกทุกรอบ — เพิ่งเชื่อมเพจทีหลังก็ตั้งเวลาให้) */
  function scheduleAuto() {
    const queue = loadQueue()
    const accounts = loadAccounts()
    let changed = false
    for (const item of queue) {
      if (item.status !== 'review' || !item.auto) continue
      if (item.auto === 'ai' && !(item.ai?.status === 'done' && item.ai.verdict === 'pass')) continue
      if (!item.post?.title) {
        const post = postFromFile(readPost(item.slug))
        if (post?.title) {
          item.post = post
          changed = true
        }
      }
      if (!item.targetsEdited && !item.targets?.length) item.targets = targetsFor(accounts, item.category)
      if (!item.targets?.length || !item.post?.title) continue // ยังไม่มีเพจ/ช่อง หรือยังไม่มีข้อความโพสต์ → รอ
      const at = nextFreeSlot(accounts.settings.slots, queue.filter((q) => q.status === 'scheduled').map((q) => q.scheduleAt))
      if (!at) continue
      item.status = 'scheduled'
      item.scheduleAt = at
      note(item, item.auto === 'now' ? 'ตั้งเวลาเองทันที (ผลิตต่อเนื่อง)' : 'AI ให้ผ่าน → ตั้งเวลาเอง (ผลิตต่อเนื่อง)')
      log(`โพสต์อัตโนมัติ: "${item.title}" ตั้งเวลาโพสต์ ${new Date(at).toLocaleString('th-TH')}`)
      changed = true
    }
    if (changed) saveQueue(queue)
  }

  // ── AI ตรวจ ──
  async function startCheck(id) {
    const item = loadQueue().find((q) => q.id === id)
    if (!item) throw new Error('ไม่พบคลิปนี้ในคิว')
    if (item.ai?.status === 'running') return item
    const file = videoPath(item)
    if (!existsSync(file)) throw new Error('ไม่พบไฟล์วิดีโอ — อาจถูกลบหรือเปลี่ยนชื่อไปแล้ว')
    const seconds = (await videosOf()).find((v) => v.slug === item.slug)?.files.find((f) => f.name === item.file)?.seconds ?? null
    const times = frameTimes(seconds)
    const dir = join(POSTING_DIR, 'frames', item.id)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const attachments = []
    for (const [i, t] of times.entries()) {
      const out = join(dir, `frame_${i + 1}.jpg`)
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', out])
      if (existsSync(out)) attachments.push({ name: `frame_${i + 1}.jpg`, type: 'image/jpeg', base64: readFileSync(out).toString('base64') })
    }
    if (!attachments.length) throw new Error('ตัดภาพตัวอย่างจากคลิปไม่ได้')
    const source = clipSource(item.slug)
    const prompt = qcPrompt({ title: item.title, script: source.script, post: item.post, seconds, times, language: source.language })
    const job = enqueue('chatgpt', 'prompt', { prompt, newChat: true, attachments, label: 'นกนางนวลตรวจคลิป' })
    return mutateItem(id, (it) => {
      it.ai = { status: 'running', jobId: job.id, startedAt: Date.now() }
      note(it, 'ส่งให้ AI ตรวจ')
    })
  }

  /** ผลตรวจที่ ChatGPT ตอบกลับแล้ว → เก็บลงคิว (+ อนุมัติเองถ้าตั้งไว้) */
  function collectChecks() {
    const queue = loadQueue()
    const accounts = loadAccounts()
    const { settings } = accounts
    let changed = false
    for (const item of queue) {
      if (item.ai?.status !== 'running') continue
      const job = jobs.get(item.ai.jobId)
      if (!job) {
        item.ai = { status: 'error', error: 'งานตรวจหายไปจากคิว ChatGPT — กดตรวจใหม่' }
        changed = true
        continue
      }
      if (job.status === 'error') {
        item.ai = { status: 'error', error: job.error ?? 'ChatGPT ตรวจไม่สำเร็จ' }
        changed = true
        continue
      }
      if (job.status !== 'done') continue
      try {
        item.ai = { status: 'done', ...parseQc(job.result?.text), checkedAt: Date.now() }
        note(item, `AI ตรวจแล้ว: ${item.ai.verdict === 'pass' ? 'ผ่าน' : 'ควรแก้'} ${item.ai.score}/100`)
        // หมวดจาก AI — ไม่ทับหมวดที่ผู้ใช้เลือกเอง · ปลายทางเลือกให้ใหม่ถ้าผู้ใช้ยังไม่ได้ติ๊กเอง
        if (item.ai.category && item.categoryBy !== 'manual') {
          item.category = item.ai.category
          item.categoryBy = 'ai'
          if (item.status === 'review' && !item.targetsEdited) item.targets = targetsFor(accounts, item.category)
          note(item, `AI ระบุหมวด: ${item.category}`)
        }
      } catch (err) {
        item.ai = { status: 'error', error: err.message, raw: String(job.result?.text ?? '').slice(0, 1500) }
      }
      changed = true
      if (settings.autoApprove && item.status === 'review' && item.ai.status === 'done' && item.ai.verdict === 'pass' && item.targets?.length && item.post?.title) {
        const at = nextFreeSlot(settings.slots, queue.filter((q) => q.status === 'scheduled').map((q) => q.scheduleAt))
        if (at) {
          item.status = 'scheduled'
          item.scheduleAt = at
          note(item, 'AI ให้ผ่าน → อนุมัติเองและลงช่องเวลาถัดไป')
        }
      }
    }
    if (changed) saveQueue(queue)
  }

  /** ตรวจเองทีละคลิป เฉพาะตอนคิว ChatGPT ว่างและไม่มีขั้นทำคลิปกำลังรัน — ไม่แย่งคิวกับการทำคลิป */
  async function autoCheck() {
    const { settings } = loadAccounts()
    const queue = loadQueue()
    // คลิปจากผลิตต่อเนื่องแบบ "AI ตรวจก่อน" ตรวจเสมอ แม้ปิดตรวจอัตโนมัติของทั้งระบบ
    const wants = (q) => q.status === 'review' && !q.ai && (settings.autoCheck || q.auto === 'ai')
    if (!queue.some(wants) || pipelineBusy()) return
    const chatgptBusy = [...jobs.values()].some((j) => j.agent === 'chatgpt' && (j.status === 'queued' || j.status === 'running'))
    if (chatgptBusy) return
    if (queue.some((q) => q.ai?.status === 'running')) return
    const next = queue.find(wants)
    if (next) await startCheck(next.id).catch((err) => mutateItem(next.id, (it) => { it.ai = { status: 'error', error: err.message } }))
  }

  // ── โพสต์ ──
  async function postItem(id) {
    const accounts = loadAccounts()
    let item = mutateItem(id, (it) => {
      it.status = 'posting'
      it.error = null
      note(it, 'เริ่มโพสต์')
    })
    const file = videoPath(item)
    const text = caption(item.post)
    const results = { ...item.results }
    for (const key of item.targets ?? []) {
      if (results[key]?.ok) continue // ขึ้นไปแล้ว (ลองใหม่เฉพาะที่พลาด)
      const { kind, account } = findTarget(accounts, key)
      try {
        if (!account) throw new Error('บัญชีนี้ถูกลบออกไปแล้ว')
        if (!existsSync(file)) throw new Error('ไม่พบไฟล์วิดีโอ')
        let out
        if (kind === 'facebook') {
          out = await fb.upload({ pageId: account.pageId, token: account.token, file, title: item.post.title, description: text })
        } else {
          const { clientId, clientSecret } = accounts.settings.google
          if (!account.refreshToken) throw new Error('ช่องนี้ยังไม่ได้เชื่อมต่อ')
          out = await yt.upload({ clientId, clientSecret, refreshToken: account.refreshToken, file, title: item.post.title, description: text, tags: item.post.hashtags, privacy: account.privacy ?? 'public' })
        }
        results[key] = { ok: true, ...out, name: account.name, at: Date.now() }
        log(`โพสต์อัตโนมัติ: "${item.title}" ขึ้น ${account.name} แล้ว ${out.url}`)
      } catch (err) {
        results[key] = { ok: false, error: err.message, name: account?.name ?? key, at: Date.now() }
        log(`โพสต์อัตโนมัติ: "${item.title}" ขึ้น ${account?.name ?? key} ไม่สำเร็จ — ${err.message}`)
      }
      mutateItem(id, (it) => { it.results = { ...results } }) // บันทึกทีละปลายทาง — ปิดโปรแกรมกลางทางจะได้ไม่โพสต์ซ้ำที่สำเร็จแล้ว
    }
    return mutateItem(id, (it) => {
      const failed = (it.targets ?? []).filter((k) => !results[k]?.ok)
      it.results = results
      it.status = failed.length ? 'failed' : 'posted'
      it.postedAt = failed.length ? it.postedAt ?? null : Date.now()
      it.error = failed.length ? failed.map((k) => `${results[k]?.name ?? k}: ${results[k]?.error ?? 'ไม่สำเร็จ'}`).join(' · ') : null
      note(it, failed.length ? `โพสต์ไม่สำเร็จ ${failed.length} ที่` : 'โพสต์ครบทุกที่แล้ว')
    })
  }

  async function postDue() {
    if (uploading) return
    const [item] = dueItems(loadQueue())
    if (!item) return
    uploading = true
    try {
      await postItem(item.id)
    } finally {
      uploading = false
    }
  }

  // ── Google Drive: ขึ้นตอนเข้าคิว · ลง (ถังขยะ) เมื่อโพสต์ครบ/ตีกลับ/เอาออก ──
  async function syncDrive() {
    const { settings } = loadAccounts()
    const d = settings.drive
    if (driveBusy || !d?.refreshToken) return
    driveBusy = true
    try {
      // Drive ใช้ OAuth client ของตัวเอง (แยกจาก YouTube — อาจคนละบัญชี/คนละโปรเจกต์)
      const auth = { clientId: settings.driveClient.clientId, clientSecret: settings.driveClient.clientSecret, refreshToken: d.refreshToken }
      for (const item of driveToTrash(loadQueue())) {
        try {
          await drive.trash({ ...auth, fileId: item.drive.fileId })
          mutateItem(item.id, (it) => {
            it.drive = { removedAt: Date.now() }
            note(it, 'ลบคลิปออกจาก Google Drive แล้ว (อยู่ในถังขยะ 30 วัน)')
          })
        } catch (err) {
          log(`โพสต์อัตโนมัติ: ลบ "${item.title}" ออกจาก Drive ไม่ได้ — ${err.message}`)
        }
      }
      const next = nextDriveUpload(loadQueue())
      if (!next) return
      const file = videoPath(next)
      if (!existsSync(file)) return
      mutateItem(next.id, (it) => { it.drive = { uploading: true, at: Date.now() } })
      try {
        const out = await drive.upload({ ...auth, folderId: d.folderId, file, name: `${next.title}.mp4` })
        if (out.folderId !== d.folderId) updateAccounts(({ settings: st }) => { if (st.drive) st.drive.folderId = out.folderId })
        mutateItem(next.id, (it) => {
          it.drive = { fileId: out.fileId, link: out.link, uploadedAt: Date.now() }
          note(it, 'อัปโหลดขึ้น Google Drive แล้ว')
        })
        log(`โพสต์อัตโนมัติ: "${next.title}" ขึ้น Google Drive แล้ว`)
      } catch (err) {
        mutateItem(next.id, (it) => { it.drive = { error: err.message, at: Date.now() } })
        log(`โพสต์อัตโนมัติ: อัป "${next.title}" ขึ้น Drive ไม่ได้ — ${err.message}`)
      }
    } finally {
      driveBusy = false
    }
  }

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      await enroll().catch((err) => log(`โพสต์อัตโนมัติ: ดึงคลิปเข้าคิวไม่ได้ — ${err.message}`))
      collectChecks()
      scheduleAuto()
      await autoCheck().catch(() => {})
      await postDue()
      await syncDrive().catch((err) => log(`โพสต์อัตโนมัติ: Google Drive — ${err.message}`))
    } finally {
      ticking = false
    }
  }
  // เฉพาะ bridge ตัวจริง — bridge ทดสอบ (port อื่น) ใช้คิวไฟล์เดียวกัน ถ้าวนด้วยจะโพสต์คลิปเดียวกันซ้ำสองที่
  if (scheduler) setInterval(() => tick().catch((err) => log(`โพสต์อัตโนมัติ: ${err.message}`)), TICK_MS).unref()

  // ── มุมมองให้แผงข้าง ──
  async function view() {
    await enroll({ force: true }).catch(() => {})
    collectChecks()
    const videos = await videosOf()
    const bySlug = new Map(videos.map((v) => [v.slug, v]))
    const queue = loadQueue().filter((q) => q.status !== 'removed').map((q) => {
      const v = bySlug.get(q.slug)
      const f = v?.files.find((x) => x.name === q.file)
      // คลิปที่ยังไม่มีข้อความโพสต์ตอนเข้าคิว แต่ตอนนี้มี post.json แล้ว → เติมให้ (ไม่ทับที่ผู้ใช้แก้)
      const post = !q.post?.title && v?.post ? postFromFile(v.post) : q.post
      return { ...q, post, thumb: v?.thumb ?? null, video: f?.url ?? null, seconds: f?.seconds ?? null, missing: !f }
    })
    const inQueue = new Set(queue.map((q) => `${q.slug}/${q.file}`))
    const library = videos
      .map((v) => ({ slug: v.slug, title: v.title, thumb: v.thumb, file: v.files.find((f) => f.main)?.name ?? v.files[0]?.name, updatedAt: v.updatedAt }))
      .filter((v) => v.file && !inQueue.has(`${v.slug}/${v.file}`))
    return { ...publicAccounts(), queue, library, statusLabels: STATUS, categories: CATEGORIES, uploading, redirectUri, nextSlot: nextFreeSlot(loadAccounts().settings.slots, queue.filter((q) => q.status === 'scheduled').map((q) => q.scheduleAt)) }
  }

  function oauthPage(res, ok, message) {
    const color = ok ? '#8a6100' : '#ae402f'
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    const safe = String(message).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>เชื่อมต่อ YouTube</title>
<body style="font:16px/1.6 'Noto Sans Thai','Leelawadee UI',system-ui,sans-serif;background:#fbf4e2;color:#3a2a00;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px">
<div style="max-width:440px;background:#fffaf0;border:2px solid ${color};border-radius:14px;padding:24px"><h1 style="margin:0 0 8px;font-size:20px;color:${color}">${ok ? '✓ เชื่อมต่อช่องแล้ว' : 'เชื่อมต่อไม่สำเร็จ'}</h1><p style="margin:0">${safe}</p><p style="margin:12px 0 0;color:#6b5a2a">ปิดแท็บนี้แล้วกลับไปที่แผงข้าง Cartoon Auto ได้เลย</p></div></body>`)
  }

  async function handle(req, res, url) {
    const path = url.pathname
    const host = req.headers.host ?? ''
    const localHost = host === `127.0.0.1:${port}` || host === `localhost:${port}`

    // Google ส่งกลับมาที่ http://127.0.0.1:<port>/?code=…&state=… (redirect แบบ loopback ของแอป Desktop)
    if (req.method === 'GET' && path === '/' && url.searchParams.has('state') && oauthStates.has(url.searchParams.get('state'))) {
      const state = url.searchParams.get('state')
      const { expires, kind } = oauthStates.get(state)
      oauthStates.delete(state)
      if (!localHost || Date.now() > expires) return oauthPage(res, false, 'ลิงก์เชื่อมต่อหมดอายุ — กดเชื่อมต่อใหม่จากแผงข้าง'), true
      if (url.searchParams.get('error')) return oauthPage(res, false, `Google ตอบว่า: ${url.searchParams.get('error')}`), true
      try {
        const { settings: st } = loadAccounts()
        const { clientId, clientSecret } = kind === 'drive' ? st.driveClient : st.google
        if (kind === 'drive') {
          const acc = await drive.connect({ clientId, clientSecret, code: url.searchParams.get('code'), redirectUri })
          updateAccounts(({ settings }) => {
            // บัญชีเดิม → เก็บโฟลเดอร์เดิมไว้ · บัญชีใหม่ → สร้างโฟลเดอร์ใหม่ตอนอัปครั้งแรก
            const sameAccount = settings.drive?.email && settings.drive.email === acc.email
            settings.drive = { refreshToken: acc.refreshToken, email: acc.email, name: acc.name, folderId: sameAccount ? settings.drive.folderId ?? null : null, connectedAt: Date.now() }
          })
          log(`โพสต์อัตโนมัติ: เชื่อมต่อ Google Drive (${acc.email}) แล้ว`)
          if (scheduler) setTimeout(() => tick().catch(() => {}), 200)
          return oauthPage(res, true, `Google Drive ของ ${acc.email} พร้อมเก็บคลิปแล้ว`), true
        }
        const ch = await yt.connect({ clientId, clientSecret, code: url.searchParams.get('code'), redirectUri })
        let id
        updateAccounts((data) => {
          const old = data.youtube.find((a) => a.channelId === ch.channelId)
          if (old) Object.assign(old, { name: ch.name, refreshToken: ch.refreshToken })
          else data.youtube.push({ id: (id = newId()), name: ch.name, channelId: ch.channelId, refreshToken: ch.refreshToken, privacy: 'public', addedAt: Date.now() })
        })
        if (id) retarget()
        log(`โพสต์อัตโนมัติ: เชื่อมต่อช่อง YouTube "${ch.name}" แล้ว`)
        return oauthPage(res, true, `ช่อง "${ch.name}" พร้อมโพสต์แล้ว`), true
      } catch (err) {
        return oauthPage(res, false, err.message), true
      }
    }

    if (!path.startsWith('/api/posting')) return false
    if (!localHost || req.headers['x-bridge-token'] !== token) return json(res, 401, { error: 'token ไม่ถูกต้อง' }), true

    try {
      if (req.method === 'GET' && path === '/api/posting') return json(res, 200, await view()), true
      if (req.method !== 'POST') return json(res, 404, { error: 'ไม่มี endpoint นี้' }), true
      const body = await readBody(req)

      // ── ตั้งค่า + บัญชี ──
      if (path === '/api/posting/settings') {
        updateAccounts(({ settings }) => {
          if (typeof body.enabled === 'boolean') settings.enabledAt = body.enabled ? settings.enabledAt ?? Date.now() : null
          if (typeof body.autoCheck === 'boolean') settings.autoCheck = body.autoCheck
          if (typeof body.autoApprove === 'boolean') settings.autoApprove = body.autoApprove
          if (body.slots !== undefined) settings.slots = cleanSlots(body.slots)
        })
        return json(res, 200, await view()), true
      }
      // Google client ของ YouTube (/google) และของ Drive (/drive/client) เก็บแยกกัน
      if (path === '/api/posting/google' || path === '/api/posting/drive/client') {
        const key = path === '/api/posting/google' ? 'google' : 'driveClient'
        const clientId = String(body.clientId ?? '').trim()
        const clientSecret = String(body.clientSecret ?? '').trim()
        if (!/\.apps\.googleusercontent\.com$/.test(clientId)) return json(res, 400, { error: 'Client ID ต้องลงท้ายด้วย .apps.googleusercontent.com' }), true
        updateAccounts(({ settings }) => {
          // เปลี่ยน client ของ Drive → การเชื่อมต่อเดิมใช้ไม่ได้แล้ว ต้องเชื่อมต่อใหม่
          if (key === 'driveClient' && settings.driveClient.clientId && settings.driveClient.clientId !== clientId) settings.drive = null
          settings[key].clientId = clientId
          if (clientSecret && !clientSecret.startsWith('••••')) settings[key].clientSecret = clientSecret
        })
        if (!loadAccounts().settings[key].clientSecret) return json(res, 400, { error: 'ใส่ Client secret ด้วย' }), true
        return json(res, 200, await view()), true
      }
      if (path === '/api/posting/facebook') {
        const pageId = String(body.pageId ?? '').trim()
        const token = String(body.token ?? '').trim()
        if (!/^\d{5,}$/.test(pageId)) return json(res, 400, { error: 'Page ID ต้องเป็นตัวเลข (ดูได้ในหน้าเกี่ยวกับของเพจ)' }), true
        if (token.length < 20) return json(res, 400, { error: 'ใส่ Page access token ให้ครบ' }), true
        const page = await fb.info({ pageId, token }) // ตรวจว่าใช้ได้จริงก่อนบันทึก
        const name = String(body.name ?? '').trim() || page.name
        let id
        updateAccounts((data) => {
          const old = data.facebook.find((a) => a.pageId === pageId)
          if (old) Object.assign(old, { name, token, checkedAt: Date.now() })
          else data.facebook.push({ id: (id = newId()), name, pageId, token, addedAt: Date.now(), checkedAt: Date.now() })
        })
        if (id) retarget()
        log(`โพสต์อัตโนมัติ: เพิ่มเพจ "${name}"`)
        return json(res, 200, await view()), true
      }
      if (path === '/api/posting/facebook/remove' || path === '/api/posting/youtube/remove') {
        const kind = path.includes('facebook') ? 'facebook' : 'youtube'
        updateAccounts((data) => { data[kind] = data[kind].filter((a) => a.id !== body.id) })
        const key = `${kind === 'facebook' ? 'fb' : 'yt'}:${body.id}`
        saveQueue(loadQueue().map((q) => (q.status === 'posted' ? q : { ...q, targets: (q.targets ?? []).filter((k) => k !== key) })))
        return json(res, 200, await view()), true
      }
      // หมวดที่เพจ/ช่องนี้รับ — ว่าง = รับทุกหมวด
      if (path === '/api/posting/account/categories') {
        const kind = body.kind === 'youtube' ? 'youtube' : 'facebook'
        let found = false
        updateAccounts((data) => {
          const a = data[kind].find((x) => x.id === body.id)
          if (a) {
            a.categories = cleanCategories(body.categories)
            found = true
          }
        })
        if (!found) return json(res, 404, { error: 'ไม่พบบัญชีนี้' }), true
        retarget()
        return json(res, 200, await view()), true
      }
      if (path === '/api/posting/youtube/connect') {
        const { clientId, clientSecret } = loadAccounts().settings.google
        if (!clientId || !clientSecret) return json(res, 400, { error: 'ใส่ Google Client ID และ Client secret ก่อน' }), true
        const state = randomBytes(16).toString('hex')
        oauthStates.set(state, { expires: Date.now() + OAUTH_TTL_MS, kind: 'youtube' })
        return json(res, 200, { url: youtubeAuthUrl({ clientId, redirectUri, state }) }), true
      }
      if (path === '/api/posting/drive/connect') {
        const { clientId, clientSecret } = loadAccounts().settings.driveClient
        if (!clientId || !clientSecret) return json(res, 400, { error: 'ใส่ Client ID และ Client secret ของ Google Drive ก่อน' }), true
        const state = randomBytes(16).toString('hex')
        oauthStates.set(state, { expires: Date.now() + OAUTH_TTL_MS, kind: 'drive' })
        return json(res, 200, { url: youtubeAuthUrl({ clientId, redirectUri, state, scopes: DRIVE_SCOPES }) }), true
      }
      if (path === '/api/posting/drive/remove') {
        // เลิกเชื่อมต่อเท่านั้น — คลิปที่อยู่บน Drive แล้วไม่ถูกลบ (ไม่มีสิทธิ์เข้าไปลบแล้ว) บอกผู้ใช้ในหน้าจอ
        updateAccounts(({ settings }) => { settings.drive = null })
        return json(res, 200, await view()), true
      }
      if (path === '/api/posting/youtube/update') {
        if (!['public', 'unlisted', 'private'].includes(body.privacy)) return json(res, 400, { error: 'ค่าความเป็นส่วนตัวไม่ถูกต้อง' }), true
        updateAccounts((data) => {
          const a = data.youtube.find((x) => x.id === body.id)
          if (a) a.privacy = body.privacy
        })
        return json(res, 200, await view()), true
      }

      // ── คิว ──
      if (path === '/api/posting/add') {
        const slug = String(body.slug ?? '')
        const file = String(body.file ?? '')
        if (!/^[^\\/.][^\\/]*$/.test(slug) || !/^[^\\/]+\.mp4$/i.test(file) || !existsSync(join(PROJECTS, slug, '06_render', file))) return json(res, 400, { error: 'ไม่พบคลิปนี้' }), true
        const queue = loadQueue().filter((q) => !(q.slug === slug && q.file === file && q.status === 'removed'))
        if (!queue.some((q) => q.slug === slug && q.file === file)) {
          const v = (await videosOf()).find((x) => x.slug === slug)
          const item = newItem({ slug, file, title: v?.title ?? slug, post: readPost(slug), targets: targetsFor(loadAccounts(), null) })
          note(item, 'เพิ่มจากคลังวิดีโอ')
          queue.push(item)
        }
        saveQueue(queue)
        return json(res, 200, await view()), true
      }
      if (path === '/api/posting/item') {
        mutateItem(body.id, (it) => {
          if (it.status === 'posting' || it.status === 'posted') throw new Error('คลิปนี้โพสต์ไปแล้ว แก้ไม่ได้')
          if (body.post) {
            it.post = {
              ...it.post,
              title: String(body.post.title ?? it.post.title ?? '').trim().slice(0, 200),
              description: String(body.post.description ?? it.post.description ?? '').slice(0, 5000),
              hashtags: cleanHashtags(body.post.hashtags ?? it.post.hashtags),
            }
          }
          // เลือกหมวดเอง (null = ไม่รู้หมวด) → ปลายทางตามหมวดใหม่ ถ้ายังไม่ได้ติ๊กเอง
          if (body.category !== undefined) {
            it.category = CATEGORIES.includes(body.category) ? body.category : null
            it.categoryBy = it.category ? 'manual' : null
            if (!it.targetsEdited) it.targets = targetsFor(loadAccounts(), it.category)
          }
          if (Array.isArray(body.targets)) {
            const valid = new Set(allTargets())
            it.targets = body.targets.filter((k) => valid.has(k))
            it.targetsEdited = true
          }
          // กลับไปให้ระบบเลือกปลายทางตามหมวด
          if (body.resetTargets) {
            it.targetsEdited = false
            it.targets = targetsFor(loadAccounts(), it.category)
          }
        })
        return json(res, 200, await view()), true
      }
      if (path === '/api/posting/check') {
        await startCheck(body.id)
        return json(res, 200, await view()), true
      }
      if (path === '/api/posting/approve') {
        const queue = loadQueue()
        const { settings } = loadAccounts()
        const taken = queue.filter((q) => q.status === 'scheduled' && q.id !== body.id).map((q) => q.scheduleAt)
        const at = body.when === 'now' ? Date.now() : body.when === 'next' ? nextFreeSlot(settings.slots, taken) : Number(body.when)
        if (!Number.isFinite(at) || !at) return json(res, 400, { error: body.when === 'next' ? 'ยังไม่ได้ตั้งช่องเวลาประจำ — ตั้งในแท็บตั้งค่า หรือเลือกวันเวลาเอง' : 'เลือกวันเวลาโพสต์ก่อน' }), true
        if (body.when !== 'now' && at < Date.now() - 60_000) return json(res, 400, { error: 'เวลาที่เลือกผ่านไปแล้ว' }), true
        mutateItem(body.id, (it) => {
          if (!it.post?.title?.trim()) throw new Error('ยังไม่มีชื่อโพสต์ — ใส่ชื่อก่อนอนุมัติ')
          if (!it.targets?.length) throw new Error('ยังไม่ได้เลือกเพจหรือช่องที่จะโพสต์')
          if (it.status === 'posting' || it.status === 'posted') throw new Error('คลิปนี้โพสต์ไปแล้ว')
          it.status = 'scheduled'
          it.scheduleAt = at
          note(it, body.when === 'now' ? 'อนุมัติ · โพสต์ทันที' : `อนุมัติ · ตั้งเวลา ${new Date(at).toLocaleString('th-TH')}`)
        })
        if (body.when === 'now' && scheduler) setTimeout(() => tick().catch(() => {}), 200)
        return json(res, 200, await view()), true
      }
      if (path === '/api/posting/unschedule') {
        mutateItem(body.id, (it) => {
          if (it.status !== 'scheduled') throw new Error('คลิปนี้ไม่ได้อยู่ในรายการตั้งเวลา')
          it.status = 'review'
          it.scheduleAt = null
          note(it, 'ยกเลิกเวลา กลับไปรอตรวจ')
        })
        return json(res, 200, await view()), true
      }
      if (path === '/api/posting/reject') {
        mutateItem(body.id, (it) => {
          if (it.status === 'posting' || it.status === 'posted') throw new Error('คลิปนี้โพสต์ไปแล้ว')
          it.status = 'rejected'
          it.scheduleAt = null
          note(it, `ตีกลับ${body.reason ? `: ${body.reason}` : ''}`)
        })
        return json(res, 200, await view()), true
      }
      if (path === '/api/posting/restore') {
        mutateItem(body.id, (it) => {
          if (it.status !== 'rejected') throw new Error('คลิปนี้ไม่ได้ถูกตีกลับ')
          it.status = 'review'
          note(it, 'ดึงกลับมารอตรวจ')
        })
        return json(res, 200, await view()), true
      }
      if (path === '/api/posting/retry') {
        mutateItem(body.id, (it) => {
          if (it.status !== 'failed') throw new Error('คลิปนี้ไม่ได้โพสต์พลาด')
          it.status = 'scheduled'
          it.scheduleAt = Date.now()
          note(it, 'ลองโพสต์ใหม่ (เฉพาะที่พลาด)')
        })
        if (scheduler) setTimeout(() => tick().catch(() => {}), 200)
        return json(res, 200, await view()), true
      }
      if (path === '/api/posting/remove') {
        const queue = loadQueue()
        const item = queue.find((q) => q.id === body.id)
        if (item?.status === 'posting') return json(res, 409, { error: 'กำลังโพสต์อยู่ — รอให้เสร็จก่อน' }), true
        // เก็บไว้เป็นสถานะ removed (ซ่อน) — ไม่งั้นรอบเข้าคิวเองจะดึงคลิปนี้กลับมาอีก · เพิ่มคืนจากคลังได้
        if (item) {
          item.status = 'removed'
          item.scheduleAt = null
          note(item, 'เอาออกจากคิว')
          saveQueue(queue)
        }
        rmSync(join(POSTING_DIR, 'frames', String(body.id).replace(/[^\w-]/g, '')), { recursive: true, force: true })
        return json(res, 200, await view()), true
      }
      return json(res, 404, { error: 'ไม่มี endpoint นี้' }), true
    } catch (err) {
      return json(res, 500, { error: String(err.message) }), true
    }
  }

  return { handle, busy: () => uploading || driveBusy, tick, syncDrive, enqueueAuto }
}
