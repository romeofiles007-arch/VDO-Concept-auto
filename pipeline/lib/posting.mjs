/**
 * โหมดโพสต์อัตโนมัติ (แผนกนกนางนวล) — คิวคลิปที่ทำเสร็จ → ตรวจ (AI + คน) → ตั้งเวลา → โพสต์ Facebook Page / YouTube
 *
 * เก็บใน projects/_posting/ (อยู่ใต้ .gitignore และไม่ถูกใส่ในแพ็กเกจลูกค้า — มีโทเค็น)
 *   accounts.json  การตั้งค่า + บัญชีเพจ/ช่อง (โทเค็นอยู่ที่นี่ที่เดียว ห้ามส่งออกไปหน้าแผงข้างตรงๆ)
 *   queue.json     รายการคลิปในคิว
 *
 * ไฟล์นี้เป็นตรรกะล้วน (อ่าน/เขียนไฟล์ จัดคิว คำนวณเวลา prompt) — การเรียก Facebook/YouTube อยู่ใน social.mjs
 * ข้อยกเว้นกฎ "ห้ามใช้ API" ของโปรเจกต์: ผู้ใช้อนุญาตให้ขั้นโพสต์ใช้ Facebook Graph API + YouTube Data API (28 ต.ค. 2026)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ROOT } from './config.mjs'
import { GENRES } from '../../extension/prompts.js'

/** หมวดหมู่หัวข้อ — ชุดเดียวกับตอนหาหัวข้อ (extension/prompts.js) ใช้จับคู่คลิปกับเพจ/ช่อง */
export const CATEGORIES = GENRES

// เทสต์ตั้ง POSTING_DIR ไปโฟลเดอร์ชั่วคราว — ไม่แตะคิว/โทเค็นจริงของผู้ใช้
export const POSTING_DIR = process.env.POSTING_DIR || join(ROOT, 'projects', '_posting')
const ACCOUNTS_FILE = () => join(POSTING_DIR, 'accounts.json')
const QUEUE_FILE = () => join(POSTING_DIR, 'queue.json')

/** สถานะของคลิปในคิว — ลำดับตามเส้นทางปกติ */
export const STATUS = {
  review: 'รอตรวจ',
  scheduled: 'ตั้งเวลาแล้ว',
  posting: 'กำลังโพสต์',
  posted: 'โพสต์แล้ว',
  failed: 'โพสต์ไม่สำเร็จ',
  rejected: 'ตีกลับ',
}

export const DEFAULT_SETTINGS = {
  enabledAt: null, // เปิดโหมดเมื่อไร — คลิปที่เสร็จหลังเวลานี้เข้าคิวเอง (คลิปเก่าเพิ่มเองจากคลัง)
  autoCheck: true, // คลิปเข้าคิวแล้วให้ AI ตรวจทันที
  autoApprove: false, // AI ให้ผ่าน → อนุมัติ + ลงช่องเวลาถัดไปเอง (ค่าเริ่มต้นปิด — ให้คนดูก่อน)
  slots: ['12:00', '19:00'], // ช่องเวลาประจำวัน
  google: { clientId: '', clientSecret: '' }, // OAuth client ของ Google Cloud (ประเภท Desktop app) — ใช้ร่วมทุกช่อง
  // OAuth client ของ Drive แยกจาก YouTube — Drive อาจอยู่คนละบัญชี/คนละโปรเจกต์ Google Cloud
  driveClient: { clientId: '', clientSecret: '' },
  // Google Drive ที่พักคลิประหว่างรอโพสต์: { refreshToken, email, name, folderId } · null = ไม่ใช้
  // คลิปขึ้น Drive ตอนเข้าคิว และย้ายไปถังขยะเมื่อโพสต์ครบ / ตีกลับ / เอาออกจากคิว
  drive: null,
}

function readJson(file, fallback) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  mkdirSync(POSTING_DIR, { recursive: true })
  writeFileSync(file + '.tmp', JSON.stringify(data, null, 2))
  renameSync(file + '.tmp', file)
}

// ── บัญชี + การตั้งค่า ─────────────────────────────────────────────

export function loadAccounts() {
  const raw = readJson(ACCOUNTS_FILE(), {})
  return {
    settings: {
      ...DEFAULT_SETTINGS,
      ...raw.settings,
      google: { ...DEFAULT_SETTINGS.google, ...raw.settings?.google },
      driveClient: { ...DEFAULT_SETTINGS.driveClient, ...raw.settings?.driveClient },
    },
    facebook: Array.isArray(raw.facebook) ? raw.facebook : [],
    youtube: Array.isArray(raw.youtube) ? raw.youtube : [],
  }
}

export function saveAccounts(data) {
  writeJson(ACCOUNTS_FILE(), data)
  return data
}

export function updateAccounts(mutate) {
  const data = loadAccounts()
  mutate(data)
  return saveAccounts(data)
}

/** เหลือ 4 ตัวท้าย — ให้ผู้ใช้จำได้ว่าใส่ตัวไหนไว้ โดยไม่ส่งโทเค็นเต็มออกไปหน้าเว็บ */
export const mask = (secret) => (secret ? `••••${String(secret).slice(-4)}` : '')

/** มุมมองที่ส่งให้แผงข้าง — ไม่มีโทเค็น/secret ตัวเต็ม */
export function publicAccounts(data = loadAccounts()) {
  return {
    settings: {
      ...data.settings,
      google: { clientId: data.settings.google.clientId, clientSecret: mask(data.settings.google.clientSecret), ready: !!(data.settings.google.clientId && data.settings.google.clientSecret) },
      driveClient: { clientId: data.settings.driveClient.clientId, clientSecret: mask(data.settings.driveClient.clientSecret), ready: !!(data.settings.driveClient.clientId && data.settings.driveClient.clientSecret) },
      drive: data.settings.drive?.refreshToken
        ? { connected: true, email: data.settings.drive.email, name: data.settings.drive.name, folderLink: data.settings.drive.folderId ? `https://drive.google.com/drive/folders/${data.settings.drive.folderId}` : null }
        : { connected: false },
    },
    facebook: data.facebook.map(({ token, ...a }) => ({ ...a, token: mask(token) })),
    youtube: data.youtube.map(({ refreshToken, ...a }) => ({ ...a, connected: !!refreshToken })),
  }
}

/** ปลายทางทั้งหมดในรูป "fb:<id>" / "yt:<id>" */
export function allTargets(data = loadAccounts()) {
  return [...data.facebook.map((a) => `fb:${a.id}`), ...data.youtube.filter((a) => a.refreshToken).map((a) => `yt:${a.id}`)]
}

/** บัญชีนี้รับคลิปหมวดนี้ไหม — ไม่ได้เลือกหมวด = รับทุกหมวด · คลิปที่ยังไม่รู้หมวดไปเฉพาะบัญชีที่รับทุกหมวด */
export function acceptsCategory(account, category) {
  const cats = account?.categories ?? []
  return !cats.length || (!!category && cats.includes(category))
}

// ── กฎห้ามโพสต์ซ้ำ (ผู้ใช้ 7 พ.ย. 2026) ─────────────────────────────
// 1 คลิปลงได้ 1 เพจ/ช่องต่อแพลตฟอร์ม (Facebook 1 เพจ · YouTube 1 ช่อง) — คลิปเดียวกันหลายเพจผิดกฎชุมชน "คลิปซ้ำ"
// ลงแพลตฟอร์มไหนแล้ว ห้ามลงแพลตฟอร์มนั้นอีกตลอดไป (แม้เอาออกจากคิวแล้วเพิ่มใหม่) · แพลตฟอร์มอื่นยังลงได้ตามกฎเดียวกัน
// สมุดบันทึกถาวร projects/_posting/posted.json = { "<slug>/<file>": { fb: { key, name, at, url, title }, yt: {…} } } — ไม่ลบเอง

const POSTED_FILE = () => join(POSTING_DIR, 'posted.json')
export const platformOf = (key) => String(key).split(':')[0]
/** ตัวระบุคลิปในสมุดบันทึก — แบบเดียวกับคิว (โปรเจกต์ + ไฟล์) · ทำคลิปใหม่ทับไฟล์เดิม = คลิปเดิม */
export const clipKey = (item) => (item?.slug ? (item.file ? `${item.slug}/${item.file}` : item.slug) : null)
export const PLATFORM_NAME = { fb: 'Facebook', yt: 'YouTube' }

export function loadPosted() {
  const raw = readJson(POSTED_FILE(), {})
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/** clip = clipKey(item) · บันทึกว่าคลิปนี้ลงแพลตฟอร์มนี้แล้ว — มีบันทึกเดิมของแพลตฟอร์มนั้นอยู่แล้ว = ไม่ทับ (ครั้งแรกคือหลักฐาน) */
export function recordPosted(clip, key, info = {}) {
  const all = loadPosted()
  const p = platformOf(key)
  if (!clip || all[clip]?.[p]) return all
  all[clip] = { ...(all[clip] ?? {}), [p]: { key, ...info, at: info.at ?? Date.now() } }
  writeJson(POSTED_FILE(), all)
  return all
}

/** คลิปที่โพสต์ไปก่อนมีสมุดบันทึก — เติมจากผลโพสต์ในคิว (เรียกตอนเปิดโปรแกรม) · คืนจำนวนที่เติม */
export function backfillPosted(queue) {
  const all = loadPosted()
  let added = 0
  const done = [...queue].sort((a, b) => (a.postedAt ?? a.addedAt ?? 0) - (b.postedAt ?? b.addedAt ?? 0))
  for (const q of done) {
    for (const [key, r] of Object.entries(q.results ?? {})) {
      const p = platformOf(key)
      const clip = clipKey(q)
      if (!r?.ok || !clip || all[clip]?.[p]) continue
      all[clip] = { ...(all[clip] ?? {}), [p]: { key, name: r.name, at: r.at ?? q.postedAt ?? Date.now(), url: r.url ?? null, title: q.title } }
      added++
    }
  }
  if (added) writeJson(POSTED_FILE(), all)
  return added
}

/**
 * ปลายทางที่คลิปนี้ลงได้จริง: แพลตฟอร์มละ 1 ปลายทาง · ตัดแพลตฟอร์มที่คลิปนี้เคยลงแล้ว (เมื่อรู้ clip = clipKey(item))
 * หลายเพจรับคลิปได้ → เลือกเพจที่มีคลิปรอในคิวน้อยที่สุด (เสมอ = ที่ลงไปน้อยกว่าใน 7 วัน · ยังเสมอ = ตามลำดับเดิม)
 */
export const RECENT_MS = 7 * 86_400_000
export function onePerPlatform(keys, { clip = null, posted = loadPosted(), queue = loadQueue(), since = Date.now() - RECENT_MS } = {}) {
  const used = clip ? posted[clip] ?? {} : {}
  // หลัก: คลิปที่รอในคิวของแต่ละเพจ — คลิปใหม่สลับเพจกันไปทันที
  // รอง (ตอนเสมอ): ที่ลงไปแล้วใน 7 วันล่าสุด — ถ้านับประวัติเป็นหลัก เพจที่ลงไป 46 คลิปในสัปดาห์จะไม่ได้คลิปใหม่เลย (8 พ.ย. 2026)
  const pend = new Map(), hist = new Map()
  const add = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
  for (const q of queue ?? []) if (PENDING.has(q.status) && clipKey(q) !== clip) for (const k of q.targets ?? []) add(pend, k)
  for (const c of Object.values(posted)) for (const v of Object.values(c ?? {})) if (v?.key && !(Number(v.at) < since)) add(hist, v.key)
  const score = (k) => [pend.get(k) ?? 0, hist.get(k) ?? 0]
  const less = (x, y) => { const a = score(x), b = score(y); return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) }
  const groups = new Map()
  for (const k of keys) {
    const p = platformOf(k)
    if (used[p]) continue
    if (!groups.has(p)) groups.set(p, [])
    groups.get(p).push(k)
  }
  return [...groups.values()].map((g) => g.reduce((best, k) => (less(k, best) ? k : best)))
}

/** ปลายทางตามหมวดของคลิป — แพลตฟอร์มละ 1 ปลายทาง (กฎห้ามโพสต์ซ้ำ) */
export function targetsFor(data, category, { clip = null, posted, queue } = {}) {
  return onePerPlatform([
    ...data.facebook.filter((a) => acceptsCategory(a, category)).map((a) => `fb:${a.id}`),
    ...data.youtube.filter((a) => a.refreshToken && acceptsCategory(a, category)).map((a) => `yt:${a.id}`),
  ], { clip, ...(posted && { posted }), ...(queue && { queue }) })
}

/** หมวดที่ถูกต้องเท่านั้น ไม่ซ้ำ */
export const cleanCategories = (list) => [...new Set((Array.isArray(list) ? list : []).filter((c) => CATEGORIES.includes(c)))]

export function findTarget(data, key) {
  const [kind, id] = String(key).split(':')
  if (kind === 'fb') return { kind: 'facebook', account: data.facebook.find((a) => a.id === id) }
  if (kind === 'yt') return { kind: 'youtube', account: data.youtube.find((a) => a.id === id) }
  return { kind: null, account: null }
}

export const newId = () => randomUUID().slice(0, 8)

/** ช่องเวลา "HH:MM" ที่ถูกต้อง เรียง ไม่ซ้ำ */
export function cleanSlots(slots) {
  const list = (Array.isArray(slots) ? slots : String(slots ?? '').split(/[\s,]+/))
    .map((s) => /^(\d{1,2}):(\d{2})$/.exec(String(s).trim()))
    .filter((m) => m && Number(m[1]) < 24 && Number(m[2]) < 60)
    .map((m) => `${m[1].padStart(2, '0')}:${m[2]}`)
  return [...new Set(list)].sort()
}

// ── คิว ────────────────────────────────────────────────────────────

export function loadQueue() {
  const raw = readJson(QUEUE_FILE(), [])
  return Array.isArray(raw) ? raw : []
}

export function saveQueue(queue) {
  writeJson(QUEUE_FILE(), queue)
  return queue
}

/** ข้อความโพสต์เริ่มต้นจาก post.json ที่ ChatGPT เขียนไว้ตอนทำคลิป (ชื่อ 3 แบบ + คำบรรยาย + แฮชแท็ก) */
export function postFromFile(postJson) {
  if (!postJson) return { title: '', titles: [], description: '', hashtags: [] }
  const titles = (postJson.titles ?? []).map((t) => String(t).trim()).filter(Boolean)
  return { title: titles[0] ?? '', titles, description: String(postJson.description ?? '').trim(), hashtags: cleanHashtags(postJson.hashtags) }
}

export function cleanHashtags(tags) {
  const list = (Array.isArray(tags) ? tags : String(tags ?? '').split(/[\s,]+/))
    .map((t) => String(t).trim().replace(/\s+/g, ''))
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : `#${t}`))
    .filter((t) => t.length > 1)
  return [...new Set(list)]
}

/**
 * คลิปใหม่เข้าคิว — สถานะแรกคือรอตรวจ
 * category = หมวดหมู่หัวข้อ (AI ระบุตอนตรวจ หรือผู้ใช้เลือกเอง) · targetsEdited = ผู้ใช้ติ๊กปลายทางเอง (ระบบไม่เลือกให้ตามหมวดอีก)
 */
export function newItem({ slug, file, title, post, targets = [] }) {
  return {
    id: newId(),
    slug,
    file,
    title,
    status: 'review',
    addedAt: Date.now(),
    ai: null,
    category: null,
    categoryBy: null, // 'ai' | 'manual'
    post: postFromFile(post),
    targets,
    targetsEdited: false,
    scheduleAt: null,
    results: {},
    history: [],
  }
}

/**
 * คลิปที่ควรเข้าคิวเอง: ไฟล์หลัก <slug>.mp4 ที่เสร็จหลังเปิดโหมด และยังไม่เคยอยู่ในคิว (รวมที่ตีกลับ/โพสต์แล้ว)
 * videos = ผลของ listVideos() · คืนรายการ {slug, file, title}
 */
export function videosToEnroll(videos, queue, enabledAt) {
  if (!enabledAt) return []
  const known = new Set(queue.map((q) => `${q.slug}/${q.file}`))
  const out = []
  for (const v of videos) {
    const main = v.files?.find((f) => f.name === `${v.slug}.mp4`) ?? v.files?.[0]
    if (!main || main.createdAt < enabledAt || known.has(`${v.slug}/${main.name}`)) continue
    out.push({ slug: v.slug, file: main.name, title: v.title ?? v.slug })
  }
  return out
}

/** ข้อความเต็มที่จะโพสต์ — คำบรรยาย + แฮชแท็ก */
export function caption(post) {
  const tags = cleanHashtags(post?.hashtags).join(' ')
  return [String(post?.description ?? '').trim(), tags].filter(Boolean).join('\n\n')
}

// ── ช่องเวลา ──────────────────────────────────────────────────────

/**
 * ช่องเวลาว่างถัดไป (เวลาเครื่อง) — ต้องห่างจากตอนนี้อย่างน้อย leadMs และยังไม่มีคลิปอื่นจองช่องเดียวกัน
 * taken = เวลา (ms) ที่คลิปอื่นตั้งไว้แล้ว
 */
export function nextFreeSlot(slots, taken = [], now = Date.now(), { leadMs = 5 * 60_000, days = 60 } = {}) {
  const list = cleanSlots(slots)
  if (!list.length) return null
  const busy = new Set(taken.filter(Boolean).map((t) => Math.round(t / 60_000)))
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  for (let d = 0; d < days; d++) {
    for (const slot of list) {
      const [h, m] = slot.split(':').map(Number)
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate() + d, h, m).getTime()
      if (at - now >= leadMs && !busy.has(Math.round(at / 60_000))) return at
    }
  }
  return null
}

// ── Google Drive ──────────────────────────────────────────────────

const DRIVE_KEEP = new Set(['review', 'scheduled', 'posting', 'failed']) // ยังรอโพสต์ → ควรอยู่บน Drive
const DRIVE_RETRY_MS = 30 * 60_000

/** คลิปถัดไปที่ต้องอัปขึ้น Drive (พลาดแล้วเว้น 30 นาทีก่อนลองใหม่) */
export function nextDriveUpload(queue, now = Date.now()) {
  return queue.find((q) => DRIVE_KEEP.has(q.status) && q.status !== 'posting' && !q.drive?.fileId && !(q.drive?.error && now - (q.drive.at ?? 0) < DRIVE_RETRY_MS))
}

/** คลิปที่จบแล้ว (โพสต์ครบ / ตีกลับ / เอาออก) แต่ยังค้างบน Drive → ต้องลบ */
export function driveToTrash(queue) {
  return queue.filter((q) => q.drive?.fileId && !DRIVE_KEEP.has(q.status))
}

/** คลิปที่ถึงเวลาโพสต์ — เรียงตามเวลา */
// ── เวลาต่อปลายทาง (ผู้ใช้ 8 พ.ย. 2026: "15:00 ทั้ง 2 เพจแต่คนละคลิป" · TikTok แยกเวลาเอง) ─────────
// item.targetAt = { "<key>": ms } — แต่ละปลายทางของคลิปลงตามช่องว่างของตัวเอง (FB สองเพจช่องเดียวกันได้ · TikTok ตามช่องของ TikTok)
// ไม่มี targetAt = ทุกปลายทางใช้ scheduleAt ของคลิป (แบบเดิม) · scheduleAt = เวลาเร็วสุดของปลายทางที่ยังไม่โพสต์ (ใช้เรียง/แสดง)

/** เวลาโพสต์ของปลายทางนี้ในคลิปนี้ */
export const timeFor = (item, key) => item?.targetAt?.[key] ?? item?.scheduleAt ?? null

/** ปลายทางที่ยังไม่ได้โพสต์และถึงเวลาแล้ว */
export const dueTargets = (item, now = Date.now()) => (item?.targets ?? []).filter((k) => !item.results?.[k]?.ok && timeFor(item, k) && timeFor(item, k) <= now)

/** ตั้งเวลาต่อปลายทาง (null = ล้างเวลา) แล้วให้ scheduleAt = เวลาเร็วสุดของปลายทางที่ยังไม่โพสต์ */
export function setTargetTimes(item, times) {
  if (!times) {
    item.targetAt = null
    item.scheduleAt = null
    return item
  }
  item.targetAt = { ...times }
  const left = (item.targets ?? []).filter((k) => !item.results?.[k]?.ok).map((k) => timeFor(item, k)).filter(Boolean)
  item.scheduleAt = left.length ? Math.min(...left) : Math.min(...Object.values(times))
  return item
}

/** คลิปที่มีปลายทางถึงเวลาแล้ว (เรียงตามเวลาที่ถึงก่อน) — คลิปที่ไม่มีปลายทางเลยแต่ถึงเวลา ก็ส่งให้ postItem แจ้งว่าโพสต์ไม่ได้ */
export function dueItems(queue, now = Date.now()) {
  const first = (q) => {
    const t = dueTargets(q, now).map((k) => timeFor(q, k))
    return t.length ? Math.min(...t) : q.scheduleAt
  }
  const due = (q) => q.status === 'scheduled' && (dueTargets(q, now).length > 0 || (!q.targets?.length && q.scheduleAt && q.scheduleAt <= now))
  return queue.filter(due).sort((a, b) => first(a) - first(b))
}

// ── ช่องเวลาต่อเพจ (ผู้ใช้ 7 พ.ย. 2026: "โพสต์พร้อมกันได้แต่คนละคลิป") ───────────
// ช่องเวลาประจำวันชุดเดียวกัน แต่แต่ละเพจ/ช่องมีที่ว่างของตัวเอง: 12:00 เพจ A ลงคลิป 1 · เพจ B ลงคลิป 2 พร้อมกันได้

/** สถานะที่ยังจองเพจไว้ (รอตรวจ/ตั้งเวลา/กำลังโพสต์) — โพสต์ไม่สำเร็จไม่นับ: ค้างรอคนกดลองใหม่ ไม่ได้ออกตามช่องเวลา (8 พ.ย. 2026 ใจใสมีค้าง 4 คลิป ทำให้ไม่ได้คลิปใหม่) */
export const PENDING = new Set(['review', 'scheduled', 'posting'])

/** เวลาที่ถูกจองแล้วของปลายทางเหล่านี้ (ตามเวลาของปลายทางนั้นในแต่ละคลิป) — เพจอื่นใช้เวลาเดียวกันได้ */
export function takenFor(queue, targets, excludeId = null) {
  const keys = new Set(targets ?? [])
  const out = []
  for (const q of queue) {
    if (q.status !== 'scheduled' || q.id === excludeId) continue
    for (const k of q.targets ?? []) if (keys.has(k) && !q.results?.[k]?.ok && timeFor(q, k)) out.push(timeFor(q, k))
  }
  return out
}

/** ช่องเวลาว่างถัดไปของคลิปนี้ (ว่างพร้อมกันทุกปลายทางของคลิป) */
export const nextSlotFor = (slots, queue, item, now = Date.now()) => nextFreeSlot(slots, takenFor(queue, item?.targets, item?.id), now)

/**
 * เวลาโพสต์ประจำวันของคลิป — ตามปลายทางแรกของคลิป (Facebook ก่อน แล้ว YouTube / TikTok)
 * เพจที่ตั้งเวลาเอง (account.slots) ใช้ของตัวเอง · ไม่ได้ตั้ง = เวลากลาง (settings.slots)
 */
export function slotsFor(data, targets) {
  const own = cleanSlots(findTarget(data, (targets ?? [])[0]).account?.slots ?? [])
  return own.length ? own : cleanSlots(data.settings?.slots ?? [])
}

/** ช่องเวลาว่างถัดไปของคลิปนี้ เมื่อทุกปลายทางออกพร้อมกัน (แบบเดิม — การ์ตูน Auto) */
export const nextSlotForItem = (data, queue, item, now = Date.now()) => nextFreeSlot(slotsFor(data, item?.targets), takenFor(queue, item?.targets, item?.id), now)

/** เวลาต่อปลายทางของคลิป: แต่ละปลายทางลงช่องว่างแรกของตัวเอง · ปลายทางไหนไม่มีช่องว่าง = null ทั้งคลิป */
export function scheduleTargets(data, queue, item, now = Date.now()) {
  const keys = (item?.targets ?? []).filter((k) => !item.results?.[k]?.ok)
  if (!keys.length) return null
  const out = {}
  for (const k of keys) {
    const at = nextFreeSlot(slotsFor(data, [k]), takenFor(queue, [k], item?.id), now)
    if (!at) return null
    out[k] = at
  }
  return out
}

/** เวลาโพสต์สำเร็จล่าสุดของปลายทางนี้ (ms) — ใช้เว้นระยะทีละเพจ ไม่ใช่รวมทุกเพจ */
export function lastPostAtFor(queue, key) {
  let last = 0
  for (const q of queue) {
    const r = q.results?.[key]
    if (r?.ok && Number(r.at) > last) last = Number(r.at)
  }
  return last
}

/** คลิปที่ถึงเวลาและปลายทางที่ถึงเวลาทุกปลายทางพ้นช่วงเว้นแล้ว — เพจอื่นไม่ต้องรอเพจที่เพิ่งโพสต์ */
export function readyItems(queue, gapMs, now = Date.now()) {
  return dueItems(queue, now).filter((it) => dueTargets(it, now).every((k) => now - lastPostAtFor(queue, k) >= gapMs))
}

/** แพลตฟอร์มที่มีหลายเพจ/ช่อง/บัญชี (มีเรื่องให้กระจายคลิป) เช่น Set{'fb'} */
export function multiAccountPlatforms(data) {
  const n = new Map()
  for (const k of allTargets(data)) n.set(platformOf(k), (n.get(platformOf(k)) ?? 0) + 1)
  return new Set([...n].filter(([, c]) => c > 1).map(([p]) => p))
}

/**
 * จัดคิวใหม่ตามช่องเวลาต่อเพจ — คืนคิวใหม่ (ไม่บันทึกเอง) และสรุปสิ่งที่เปลี่ยน
 *   1) คลิปที่ระบบเลือกเพจให้ (ไม่ได้ติ๊กเอง) ยังไม่โพสต์ที่ไหนเลย → เลือกเพจใหม่ให้กระจาย เฉพาะแพลตฟอร์มที่มีหลายเพจ
 *      (แพลตฟอร์มละ 1 เพจ ไม่ซ้ำแพลตฟอร์มที่เคยลง · ได้ครบทุกแพลตฟอร์มที่รับหมวดของคลิป)
 *      คลิปที่ขึ้นบางปลายทางไปแล้ว (เช่น FB ขึ้นแล้ว รอ TikTok) ไม่ย้ายเพจเด็ดขาด
 *   2) คลิปที่ตั้งเวลาตามช่องประจำวัน → จัดลงช่องว่างแรกใหม่ · เวลาที่ผู้ใช้เลือกเอง (ไม่ตรงช่องประจำวัน) ไม่แตะ
 *      perTarget: true = แต่ละปลายทางลงช่องว่างของตัวเอง (ธรรมะ Auto) · false = ทุกปลายทางออกพร้อมกัน (การ์ตูน Auto)
 *   resetEdited: true = รวมคลิปที่ติ๊กเพจเอง/ผลิตต่อเนื่องกำหนดเพจไว้ด้วย (ปุ่ม ↻ จัดคิวใหม่ — ให้เพจที่เพิ่งเพิ่มได้คลิป)
 *      คลิปที่ขึ้นบางปลายทางแล้วยังไม่ย้าย · แพลตฟอร์มที่คลิปเคยลงแล้วไม่เลือกให้อีก (สมุดบันทึกห้ามโพสต์ซ้ำ)
 *   retarget: false = จัดเวลาอย่างเดียว ไม่ย้ายคลิปข้ามเพจ (ใช้ตอนเปลี่ยนเวลาของเพจ)
 *   before = การตั้งค่าก่อนเปลี่ยนเวลา — ใช้ดูว่าคลิปไหนตั้งตามช่องเดิม (คลิปที่เวลาตรงช่องเก่าต้องย้ายตามช่องใหม่)
 */
export function reorganizeQueue(queue, data, { slots, posted = loadPosted(), now = Date.now(), retarget = true, before = null, perTarget = false, resetEdited = false } = {}) {
  if (slots) data = { ...data, settings: { ...data.settings, slots } }
  const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const keyLists = (d, keys) => [...keys.map((k) => slotsFor(d, [k])), cleanSlots(d.settings?.slots ?? [])]
  // ตรงช่องประจำวันของปลายทางนั้น (ทั้งก่อนและหลังเปลี่ยน) หรือเวลากลาง = ระบบตั้งให้ ย้ายได้
  const onSlot = (q) => {
    const old = queue.find((x) => x.id === q.id) ?? q
    const keys = old.targets ?? []
    const lists = [...keyLists(data, keys), ...(before ? keyLists(before, keys) : [])]
    const times = old.targetAt ? Object.values(old.targetAt) : [old.scheduleAt]
    return times.filter(Boolean).every((t) => lists.some((l) => l.includes(hhmm(t))))
  }
  const posted1 = (q) => Object.values(q.results ?? {}).some((r) => r?.ok)
  const work = queue.map((q) => ({ ...q, targets: [...(q.targets ?? [])], ...(q.targetAt && { targetAt: { ...q.targetAt } }) }))
  const order = (q) => [q.status === 'scheduled' ? 0 : 1, q.scheduleAt ?? q.addedAt ?? 0]
  const sorted = work.filter((q) => ['review', 'scheduled'].includes(q.status)).sort((a, b) => { const x = order(a), y = order(b); return x[0] - y[0] || x[1] - y[1] })
  let retargeted = 0, rescheduled = 0
  // 1) เลือกเพจใหม่ทีละคลิป โดยนับคลิปที่จัดไปแล้วในรอบนี้ (เริ่มจากคิวที่ยังไม่มีเพจของคลิปที่จะจัด)
  const multi = multiAccountPlatforms(data)
  const movable = retarget && multi.size ? sorted.filter((q) => (resetEdited || !q.targetsEdited) && !posted1(q)) : []
  // ล้างปลายทางของคลิปที่จะจัดก่อน แล้วเลือกใหม่ทีละคลิป — ได้ครบทุกแพลตฟอร์มตามหมวด (เดิมเก็บแพลตฟอร์มบัญชีเดียวไว้ตามเดิม
  // คลิปที่ยังไม่มีปลายทางเลยจึงไม่ได้ TikTok — 8 พ.ย. 2026)
  for (const q of movable) { q.targets = []; if (resetEdited) q.targetsEdited = false }
  for (const q of movable) {
    const next = targetsFor(data, q.category ?? null, { clip: clipKey(q), posted, queue: work })
    const old = queue.find((x) => x.id === q.id)?.targets ?? []
    if ([...next].sort().join() !== [...old].sort().join()) retargeted++
    q.targets = next
  }
  // 2) จัดเวลาใหม่: ปลดช่องประจำวันของทุกคลิปที่ตั้งเวลาไว้ก่อน แล้วลงช่องว่างแรกตามลำดับเดิม
  // เปลี่ยนเวลา (มี before, ไม่ย้ายข้ามเพจ) → แตะเฉพาะคลิปที่ปลายทางมีเวลาเปลี่ยนจริง เพจอื่นไม่ขยับ
  const changed = (q) => !before || retarget || (q.targets ?? []).some((k) => slotsFor(before, [k]).join() !== slotsFor(data, [k]).join())
  const auto = sorted.filter((q) => q.status === 'scheduled' && q.scheduleAt && onSlot(q) && changed(q))
  const prev = new Map(auto.map((q) => [q.id, JSON.stringify([q.scheduleAt, q.targetAt ?? null])]))
  const prevItem = new Map(auto.map((q) => [q.id, { scheduleAt: q.scheduleAt, targetAt: q.targetAt ?? null }]))
  for (const q of auto) {
    q.scheduleAt = null
    if (q.targetAt) q.targetAt = Object.fromEntries(Object.entries(q.targetAt).filter(([k]) => q.results?.[k]?.ok))
  }
  for (const q of auto) {
    if (perTarget) {
      const times = scheduleTargets(data, work, q, now)
      if (!times) { Object.assign(q, prevItem.get(q.id)); continue }
      setTargetTimes(q, times)
    } else {
      const at = nextSlotForItem(data, work, q, now)
      if (!at) { Object.assign(q, prevItem.get(q.id)); continue }
      q.scheduleAt = at
    }
    if (JSON.stringify([q.scheduleAt, q.targetAt ?? null]) !== prev.get(q.id)) rescheduled++
  }
  return { queue: work, retargeted, rescheduled }
}

// ── AI ตรวจคลิป (ChatGPT ผ่านหน้าเว็บ — ไม่ใช้ API) ────────────────

export const QC_FRAMES = 8

/** เวลาที่จะตัดภาพตัวอย่าง — กระจายทั้งคลิป ไม่เอาเฟรมแรก/สุดท้ายพอดี */
export function frameTimes(seconds, count = QC_FRAMES) {
  const total = Number(seconds) > 0 ? Number(seconds) : count
  return Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) / count) * total * 10) / 10)
}

export function qcPrompt({ title, script, post, seconds, times, language = 'th' }) {
  const th = language !== 'en'
  const stamp = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  return `คุณคือคนตรวจคุณภาพ (QC) คลิปการ์ตูนสั้นก่อนโพสต์ลง Facebook Page และ YouTube งานนี้คือหาจุดที่ทำให้คลิปดูไม่มืออาชีพหรือเสี่ยงโดนลดการมองเห็น

ชื่อเรื่อง: "${title}"
ความยาวคลิป: ${Math.round(seconds || 0)} วินาที · ภาษาคลิป: ${language === 'zh' ? 'จีน' : th ? 'ไทย' : 'อังกฤษ'}

ภาพที่แนบ ${times.length} ภาพคือเฟรมจากคลิปตามลำดับเวลา: ${times.map((t, i) => `ภาพ ${i + 1} = ${stamp(t)}`).join(', ')}

บทพากย์:
${String(script ?? '').slice(0, 5000) || '(ไม่มีบท)'}

ข้อความที่จะโพสต์:
ชื่อ: ${post?.title || '(ยังไม่มี)'}
คำบรรยาย: ${post?.description || '(ยังไม่มี)'}
แฮชแท็ก: ${cleanHashtags(post?.hashtags).join(' ') || '(ยังไม่มี)'}

═══════════════════════════════════════
ตรวจตามนี้:
1. ภาพตรงกับเนื้อเรื่องในบทไหม ตัวละครหน้าตาเหมือนกันทุกภาพไหม
2. ตัวอักษรในภาพสะกดถูกไหม อ่านออกไหม มีตัวอักษรเพี้ยน/ภาษาต่างดาวไหม
3. ภาพผิดปกติ: มือ/นิ้วเกิน หน้าเบี้ยว วัตถุละลาย ภาพว่าง ภาพซ้ำ
4. เนื้อหาเสี่ยงผิดนโยบาย Facebook/YouTube: ความรุนแรง เลือด เรื่องเพศ ข้อมูลสุขภาพที่ผิด คำกล่าวอ้างเกินจริง ใช้ชื่อแบรนด์/คนดังเสียหาย
5. ข้อความโพสต์: ชื่อดึงดูดแต่ไม่หลอก (clickbait เกินเนื้อหา) คำบรรยายสะกดถูก แฮชแท็กตรงเรื่อง

ให้คะแนน 0–100 (80 ขึ้นไป = โพสต์ได้เลย) verdict เป็น "pass" เมื่อไม่มีปัญหาร้ายแรง หรือ "fix" เมื่อควรแก้ก่อนโพสต์
issues: ปัญหาที่เจอ ข้อละ 1 ประโยค ระบุภาพที่/เวลา ถ้าเกี่ยวกับภาพ (ไม่มีปัญหาให้เป็น [])
category: หมวดหมู่ของคลิปนี้ เลือก 1 หมวดจากรายการนี้เท่านั้น สะกดตรงตัว:
${CATEGORIES.map((c) => `- ${c}`).join('\n')}
เขียน summary และ issues เป็นภาษาไทย ตอบเป็น JSON ก้อนเดียวเท่านั้น ไม่มีคำนำ รูปแบบนี้เป๊ะๆ:
{"score": 85, "verdict": "pass", "summary": "สรุป 1–2 ประโยค", "issues": ["..."], "category": "${CATEGORIES[0]}"}`
}

/** อ่านผลตรวจจากคำตอบของ ChatGPT — ทนต่อ ```json``` และข้อความนำหน้า */
export function parseQc(text) {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('อ่านผลตรวจจากคำตอบของ ChatGPT ไม่ออก')
  let data
  try {
    // ChatGPT บางครั้งขึ้นบรรทัดใหม่จริงในสตริง — JSON ไม่รับ แปลงเป็นช่องว่าง
    data = JSON.parse(raw.slice(start, end + 1).replace(/\r?\n/g, ' '))
  } catch {
    throw new Error('ผลตรวจจาก ChatGPT ไม่ใช่ JSON ที่ถูกต้อง')
  }
  const score = Math.max(0, Math.min(100, Math.round(Number(data.score))))
  if (!Number.isFinite(score)) throw new Error('ผลตรวจไม่มีคะแนน')
  const verdict = data.verdict === 'pass' || data.verdict === 'fix' ? data.verdict : score >= 80 ? 'pass' : 'fix'
  const issues = (Array.isArray(data.issues) ? data.issues : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12)
  // หมวดต้องตรงรายการ — สะกดเพี้ยนเล็กน้อย (ช่องว่าง) ยังจับคู่ได้ · ไม่ตรงเลย = ไม่รู้หมวด
  const squash = (v) => String(v ?? '').replace(/\s+/g, '')
  const category = CATEGORIES.find((c) => squash(c) === squash(data.category)) ?? null
  return { score, verdict, summary: String(data.summary ?? '').trim(), issues, category }
}
