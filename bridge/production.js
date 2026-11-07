/**
 * ผลิตต่อเนื่อง (🏭) — สั่ง "ทำคลิปอัตโนมัติ" ทีละคลิปเองตามเวลา จนครบจำนวน
 *
 *   ตั้งเวลา   now = เริ่มทันที · at = เริ่มตอน HH:MM (ครั้งเดียว) · daily = ทุกวันตอน HH:MM
 *   หน่วงเวลา  พักระหว่างคลิปแบบสุ่ม delayMin–delayMax นาที (ไม่ให้ ChatGPT/Flow/Kie ถูกใช้ถี่)
 *   สุ่ม       หมวด/หัวข้อ · ลายเส้น · วิธีเล่า · ภาษา — ข้อที่ไม่สุ่มใช้ค่าในตั้งค่าคลิปตามเดิม
 *   คิวโพสต์   เปิดโหมดโพสต์อัตโนมัติ → คลิปที่เสร็จเข้าคิว 📣 เอง (posting.js ดึงเข้าคิวทุกไม่กี่นาที)
 *
 * สถานะเก็บที่ projects/_production.json — bridge รีสตาร์ทกลางทาง (เช่นโค้ดอัปเดต) ก็ทำต่อได้
 * คลิปล้มข้ามไปคลิปถัดไป · ล้มติดกัน 3 คลิปหยุดทั้งชุด (น่าจะมีอะไรพังที่ต้องให้คนดู)
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, linkSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT, loadConfig } from '../pipeline/lib/config.mjs'
import { GENRES } from '../extension/prompts.js'
import { clipSettings } from '../pipeline/lib/clips.mjs'
import { hasKey } from '../pipeline/lib/env.mjs'
import { loadQueue, loadAccounts, allTargets } from '../pipeline/lib/posting.mjs'
import { playDoneSound } from './runner.js'

const FILE = join(ROOT, 'projects', '_production.json')
const LAST_RUN = join(ROOT, 'projects', '_autopilot_last.json')
const TICK_MS = 15_000
const MAX_FAILS_IN_ROW = 3
export const LANGUAGES = ['th', 'zh', 'en']

export const DEFAULT_SETTINGS = {
  count: 1, // 0 = ไม่จำกัด จนกว่าจะกดหยุด · ค่าตั้งต้น 1 คลิปต่อรอบ เหมือนธรรมะ Auto
  start: 'now', // now | at | daily
  time: '22:00',
  delayMin: 20,
  delayMax: 40,
  random: { genre: true, art: true, narration: true, language: false },
  languages: ['th'], // ภาษาที่สุ่มได้ (ใช้เมื่อ random.language)
  autoPost: 'ai', // off | ai = AI ตรวจผ่านแล้วตั้งเวลาโพสต์เอง | now = ตั้งเวลาโพสต์ทันที ไม่ตรวจ
}
const AUTO_POST = ['off', 'ai', 'now']

const blankState = () => ({ active: false, made: 0, failed: 0, failsInRow: 0, nextAt: null, run: null, batch: 0, message: '', history: [] })

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** ค่าที่ผู้ใช้ส่งมา → ค่าที่ปลอดภัย */
export function cleanSettings(input = {}, base = DEFAULT_SETTINGS) {
  const s = { ...base, random: { ...base.random }, languages: [...base.languages] }
  const int = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v))))
  if (input.count !== undefined && Number.isFinite(Number(input.count))) s.count = int(input.count, 0, 100)
  if (['now', 'at', 'daily'].includes(input.start)) s.start = input.start
  if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(input.time ?? ''))) s.time = String(input.time).padStart(5, '0')
  if (input.delayMin !== undefined && Number.isFinite(Number(input.delayMin))) s.delayMin = int(input.delayMin, 0, 720)
  if (input.delayMax !== undefined && Number.isFinite(Number(input.delayMax))) s.delayMax = int(input.delayMax, 0, 720)
  if (s.delayMax < s.delayMin) s.delayMax = s.delayMin
  for (const k of Object.keys(DEFAULT_SETTINGS.random)) if (typeof input.random?.[k] === 'boolean') s.random[k] = input.random[k]
  if (Array.isArray(input.languages)) {
    const langs = input.languages.filter((l) => LANGUAGES.includes(l))
    if (langs.length) s.languages = [...new Set(langs)]
  }
  if (AUTO_POST.includes(input.autoPost)) s.autoPost = input.autoPost
  else if (typeof input.autoPost === 'boolean') s.autoPost = input.autoPost ? 'ai' : 'off' // ค่าแบบเก่า (ติ๊กถูก)
  if (!AUTO_POST.includes(s.autoPost)) s.autoPost = s.autoPost ? 'ai' : 'off'
  return s
}

/** เวลา HH:MM ครั้งถัดไป (วันนี้ถ้ายังไม่ถึง ไม่งั้นพรุ่งนี้) */
export function nextTimeAt(hhmm, now = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

export const randomDelayMs = (s, rand = Math.random) => Math.round((s.delayMin + rand() * (s.delayMax - s.delayMin)) * 60_000)

/** ตัวเลือกของคลิปถัดไป — สุ่มเฉพาะข้อที่ติ๊กไว้ */
export function pickClip(s, config, rand = Math.random) {
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const language = s.random.language ? pick(s.languages) : config.script.language ?? 'th'
  return {
    genre: s.random.genre ? 'mix' : GENRES.includes(config.script.genre) ? config.script.genre : 'mix',
    language,
    // ชื่อเรื่องภาษาเดียวกับเสียงพากย์เมื่อสุ่มภาษา (คลิปจีนชื่อจีน)
    titleLanguage: s.random.language ? language : config.script.titleLanguage ?? language,
    minutes: config.script.targetMinutes,
    // clip_profile.mjs อ่านตัวแปรนี้แทน config — สุ่มต่อคลิปโดยไม่แตะตั้งค่าคลิปของผู้ใช้
    env: { ...(s.random.art && { CLIP_ART_STYLE: 'random' }), ...(s.random.narration && { CLIP_NARRATION: 'random' }) },
  }
}

const READY_DIR = join(ROOT, 'projects', '_ready')
const videoOf = (slug) => join(ROOT, 'projects', slug, '06_render', `${slug}.mp4`)

/** เปิดไฟล์/โฟลเดอร์ด้วยโปรแกรมของ Windows แบบหน้าต่างขยายเต็มจอ (start /max) */
export function openMax(target) {
  if (process.platform !== 'win32') return
  spawn('cmd.exe', ['/d', '/s', '/c', `start "" /max "${target}"`], { windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore' }).on('error', () => {})
}

/**
 * ผลิตครบชุด → รวมคลิปไว้โฟลเดอร์เดียว (projects/_ready/<วันเวลา>/01 ชื่อเรื่อง.mp4 …) พร้อมดูทันที
 * ใช้ hard link (ไม่กินที่เพิ่ม) · ลิงก์ไม่ได้ (คนละไดรฟ์) ค่อยคัดลอก
 */
export function prepareReady(items, now = Date.now()) {
  const ok = items.filter((h) => h.ok && h.slug && existsSync(videoOf(h.slug)))
  if (!ok.length) return null
  const d = new Date(now)
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
  const dir = join(READY_DIR, stamp)
  mkdirSync(dir, { recursive: true })
  const files = ok.map((h, i) => {
    const name = `${String(i + 1).padStart(2, '0')} ${String(h.title ?? h.slug).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)}.mp4`
    const target = join(dir, name)
    if (!existsSync(target)) {
      try {
        linkSync(videoOf(h.slug), target)
      } catch {
        copyFileSync(videoOf(h.slug), target)
      }
    }
    return { slug: h.slug, title: h.title, file: target }
  })
  return { dir, files, at: now }
}

export function createProduction({ runner, log, json, readBody, scheduler = true }) {
  let data = readJson(FILE, null) ?? {}
  let settings = cleanSettings(data.settings ?? {})
  let state = { ...blankState(), ...(data.state ?? {}) }

  function save() {
    mkdirSync(join(ROOT, 'projects'), { recursive: true })
    const tmp = `${FILE}.tmp`
    writeFileSync(tmp, JSON.stringify({ settings, state }, null, 2))
    renameSync(tmp, FILE)
  }

  function say(message) {
    state.message = message
    log(`ผลิตต่อเนื่อง: ${message}`)
  }

  const fmt = (t) => new Date(t).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
  const target = () => (settings.count > 0 ? settings.count : Infinity)

  function startBatch(now = Date.now()) {
    state = { ...blankState(), history: state.history.slice(-30), ready: state.ready ?? null, active: true, batch: (state.batch ?? 0) + 1 }
    state.nextAt = settings.start === 'now' ? now : nextTimeAt(settings.time, now)
    say(settings.start === 'now' ? 'เริ่มผลิต' : `ตั้งเวลาไว้ เริ่ม ${fmt(state.nextAt)}${settings.start === 'daily' ? ' ทุกวัน' : ''}`)
    save()
  }

  function stop() {
    if (state.run && runner.snapshot()?.status === 'running' && runner.snapshot()?.startedAt === state.run.startedAt) runner.stop()
    state.active = false
    state.run = null
    state.nextAt = null
    say('หยุดแล้ว')
    save()
  }

  /** ผลของคลิปที่เพิ่งจบ — ดูจาก runner ถ้ายังอยู่ ไม่งั้นจาก autopilot.json ของคลิป (bridge รีสตาร์ทระหว่างทาง) */
  function runResult(run) {
    const snap = runner.snapshot()
    const last = readJson(LAST_RUN, null)
    const slug = last && last.at >= run.startedAt - 5000 ? last.slug : null
    const title = slug ? last.title : null
    if (snap && snap.startedAt === run.startedAt) {
      if (snap.status === 'running') return null
      return { slug, title, ok: snap.status === 'done', error: snap.status === 'done' ? null : snap.lines.at(-1) ?? snap.status }
    }
    const status = slug ? readJson(join(ROOT, 'projects', slug, 'autopilot.json'), null) : null
    return { slug, title, ok: status?.status === 'done', error: status?.status === 'done' ? null : status?.error ?? 'ไม่ทราบผล (โปรแกรมรีสตาร์ทระหว่างทำ)' }
  }

  function finishRun(result, now = Date.now()) {
    state.history.push({ ...result, batch: state.batch, startedAt: state.run.startedAt, endedAt: now, language: state.run.language })
    state.history = state.history.slice(-40)
    state.run = null
    if (result.ok) {
      state.made++
      state.failsInRow = 0
    } else {
      state.failed++
      state.failsInRow++
    }
    // คลิปเสร็จ → จ่อคิวโพสต์ทันที (posting.enqueueAuto ต่อสายมาจาก server.js)
    if (result.ok && result.slug && settings.autoPost !== 'off' && api.onClipReady) {
      Promise.resolve(api.onClipReady(result.slug, settings.autoPost))
        .catch((err) => log(`ผลิตต่อเนื่อง: ส่ง "${result.title ?? result.slug}" เข้าคิวโพสต์ไม่ได้ — ${err.message}`))
    }
    const name = result.title ? `"${result.title}"` : 'คลิป'
    if (state.made >= target()) {
      completeBatch(now)
    } else if (state.failsInRow >= MAX_FAILS_IN_ROW) {
      state.active = false
      state.nextAt = null
      say(`หยุด — คลิปล้มติดกัน ${MAX_FAILS_IN_ROW} ครั้ง (ล่าสุด: ${result.error ?? '-'}) ตรวจดูแล้วกดเริ่มใหม่`)
    } else {
      state.nextAt = now + randomDelayMs(settings)
      say(`${result.ok ? `ได้ ${name}` : `${name} ไม่สำเร็จ — ข้าม`} · คลิปถัดไป ${fmt(state.nextAt)}`)
    }
    save()
  }

  /** ครบจำนวนคลิปของรอบ → แจ้งเสร็จ แล้วหยุด (หรือรอรอบพรุ่งนี้ในโหมดทุกวัน) */
  function completeBatch(now = Date.now()) {
    playDoneSound()
    // คลิปพร้อมดู: รวมเป็นโฟลเดอร์เดียว — ไม่เปิดเอง กด "ดูเต็มจอ" / "เปิดโฟลเดอร์" ในกล่องตั้งเวลาผลิตเมื่ออยากดู
    // (ยกมาจากธรรมะ Auto 57baa5d: ผลิตตอนกลางคืนแล้วหน้าต่างวิดีโอเด้งขึ้นมาเอง)
    try {
      const ready = prepareReady(state.history.filter((h) => h.batch === state.batch))
      if (ready) state.ready = ready
    } catch (err) {
      log(`ผลิตต่อเนื่อง: เตรียมคลิปพร้อมดูไม่ได้ — ${err.message}`)
    }
    if (settings.start === 'daily') {
      state.nextAt = nextTimeAt(settings.time, now)
      state.made = 0
      state.failed = 0
      state.batch++
      say(`ครบ ${settings.count} คลิปของวันนี้ — รอบถัดไป ${fmt(state.nextAt)} พรุ่งนี้`)
    } else {
      state.active = false
      state.nextAt = null
      say(`เสร็จครบ ${state.made} คลิป${state.failed ? ` (ล้ม ${state.failed})` : ''}`)
    }
  }

  function launch(now = Date.now()) {
    const config = loadConfig()
    if (clipSettings(config).enabled && !hasKey('KIE_API_KEY')) {
      state.nextAt = now + 10 * 60_000
      say('เปิดแอนิเมชัน Kie แต่ยังไม่มี API key — ลองใหม่อีก 10 นาที')
      return save()
    }
    const clip = pickClip(settings, config)
    const run = runner.start('autopilot', null, { autoTopic: true, genre: clip.genre, language: clip.language, titleLanguage: clip.titleLanguage, minutes: clip.minutes, env: clip.env, quiet: true })
    state.run = { startedAt: run.startedAt, language: clip.language }
    const n = state.made + 1
    say(`เริ่มคลิป ${n}${settings.count ? `/${settings.count}` : ''} (${{ th: 'ไทย', zh: 'จีน', en: 'อังกฤษ' }[clip.language]})`)
    save()
  }

  function tick(now = Date.now()) {
    if (!state.active) return
    if (state.run) {
      const result = runResult(state.run)
      if (result) finishRun(result, now)
      return
    }
    if (!state.nextAt || now < state.nextAt) return
    // ลดจำนวนคลิปต่อรอบระหว่างรอบ จนทำครบแล้ว → จบรอบ ไม่เริ่มคลิปเกิน
    if (state.made >= target()) {
      completeBatch(now)
      return save()
    }
    if (runner.snapshot()?.status === 'running') {
      if (!state.message.startsWith('รองานอื่น')) say('รองานอื่นที่กำลังทำอยู่ให้เสร็จก่อน')
      return
    }
    try {
      launch(now)
    } catch (err) {
      state.nextAt = now + 5 * 60_000
      say(`เริ่มคลิปไม่ได้: ${err.message} — ลองใหม่อีก 5 นาที`)
      save()
    }
  }

  // เฉพาะ bridge ตัวจริง — bridge ทดสอบ (port อื่น) ใช้ไฟล์ชุดเดียวกัน ถ้าวนด้วยจะผลิตซ้อนกัน
  if (scheduler) setInterval(() => {
    try {
      tick()
    } catch (err) {
      log(`ผลิตต่อเนื่อง: ${err.message}`)
    }
  }, TICK_MS).unref()

  /** สถานะโพสต์ของแต่ละคลิป (จากคิว 📣) + มีเพจ/ช่องให้โพสต์หรือยัง */
  function postInfo() {
    let queue = []
    let targets = 0
    try {
      queue = loadQueue()
      targets = allTargets(loadAccounts()).length
    } catch {}
    const bySlug = new Map(queue.filter((q) => q.status !== 'removed').map((q) => [q.slug, q]))
    const history = state.history.slice(-10).reverse().map((h) => {
      const q = h.slug && bySlug.get(h.slug)
      return q ? { ...h, post: { status: q.status, scheduleAt: q.scheduleAt ?? null, ai: q.ai?.status === 'done' ? q.ai.verdict : q.ai?.status ?? null } } : h
    })
    return { history, targets }
  }

  function view() {
    const { history, targets } = postInfo()
    return { settings, state: { ...state, history }, postTargets: targets, languages: LANGUAGES, now: Date.now() }
  }

  async function handle(req, res, path) {
    if (!path.startsWith('/api/production')) return false
    if (req.method === 'GET' && path === '/api/production') return json(res, 200, view()), true
    if (req.method !== 'POST') return json(res, 404, { error: 'ไม่มี endpoint นี้' }), true
    const body = await readBody(req)
    if (path === '/api/production/settings') {
      settings = cleanSettings(body, settings)
      // แก้เวลาเริ่มระหว่างรอเริ่ม → ใช้เวลาใหม่
      if (state.active && !state.run && state.made === 0 && settings.start !== 'now') state.nextAt = nextTimeAt(settings.time)
      save()
      return json(res, 200, view()), true
    }
    if (path === '/api/production/start') {
      if (body.settings) settings = cleanSettings(body.settings, settings)
      startBatch()
      tick()
      return json(res, 200, view()), true
    }
    if (path === '/api/production/stop') {
      stop()
      return json(res, 200, view()), true
    }
    // ชุดล่าสุดที่ผลิตเสร็จ: เปิดโฟลเดอร์ หรือเปิดคลิปเต็มจอ (เฉพาะไฟล์ในโฟลเดอร์พร้อมดูของเราเอง)
    if (path === '/api/production/open') {
      const ready = state.ready
      if (!ready || !existsSync(ready.dir)) return json(res, 404, { error: 'ยังไม่มีชุดคลิปที่ผลิตเสร็จ' }), true
      const file = ready.files[Number(body.index) || 0]?.file
      if (body.what === 'play' && file && existsSync(file)) openMax(file)
      else openMax(ready.dir)
      return json(res, 200, view()), true
    }
    return json(res, 404, { error: 'ไม่มี endpoint นี้' }), true
  }

  // active: เปิดโหมดผลิตต่อเนื่องอยู่ (รวมช่วงพักระหว่างคลิป/รอเวลาเริ่ม) — ใช้กันเครื่องหลับ ไม่งั้นคลิปถัดไปไม่เริ่ม
  const api = { handle, tick, view, busy: () => !!state.run, active: () => !!state.active, onClipReady: null }
  return api
}
