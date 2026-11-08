/**
 * อัปโหลดคลิปขึ้น Facebook Page (Graph API) และ YouTube (Data API v3)
 *
 * ทุกฟังก์ชันรับ fetchImpl ได้ — เทสต์ส่ง fetch ปลอมเข้ามา ไม่ยิงเน็ตจริง
 * Node 20+ มี fetch / FormData / Blob / fs.openAsBlob ในตัว ไม่ต้องลง dependency
 */
import { openAsBlob, statSync } from 'node:fs'

// Graph API รุ่นหนึ่งใช้ได้ราว 2 ปี — หมดอายุแล้ว Facebook ตอบ error ชัดเจน เปลี่ยนเลขตรงนี้ที่เดียว
// v25.0 ออก ก.พ. 2026 (ล่าสุด v26.0 ก.ค. 2026 มี breaking change — เลือกรุ่นก่อนหน้าที่ยังอยู่ได้อีกนาน)
export const GRAPH_VERSION = 'v25.0'
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`
const GRAPH_VIDEO = `https://graph-video.facebook.com/${GRAPH_VERSION}`

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const YT_API = 'https://www.googleapis.com/youtube/v3'
const YT_UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos'
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']
// drive.file = เห็น/แก้ได้เฉพาะไฟล์ที่โปรแกรมนี้สร้างเอง ไม่เห็นไฟล์อื่นใน Drive ของผู้ใช้
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file']
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
export const DRIVE_FOLDER_NAME = 'Cartoon Auto · รอโพสต์'

/** อ่าน error ของ Facebook/Google ให้เป็นประโยคเดียวที่ผู้ใช้เข้าใจ */
async function failure(res, service) {
  const body = await res.json().catch(() => null)
  const msg = body?.error?.message ?? body?.error_description ?? body?.error?.errors?.[0]?.message ?? (typeof body?.error === 'string' ? body.error : null) ?? `HTTP ${res.status}`
  const code = body?.error?.code
  let hint = ''
  if (service === 'facebook' && (code === 190 || /access token/i.test(msg))) hint = ' — โทเค็นหมดอายุหรือไม่ถูกต้อง ใส่ Page access token ใหม่ในแท็บบัญชี'
  if (service === 'facebook' && (code === 200 || code === 10 || /permission/i.test(msg))) hint = ' — โทเค็นไม่มีสิทธิ์โพสต์วิดีโอ (ต้องมี pages_manage_posts, pages_read_engagement)'
  if (service === 'youtube' && /quota/i.test(msg)) hint = ' — โควตา YouTube API ของวันนี้หมด (อัปโหลดได้ราววันละ 6 คลิป) ลองใหม่พรุ่งนี้'
  if (service === 'youtube' && /invalid_grant/i.test(msg)) hint = ' — การเชื่อมต่อช่องหมดอายุ กดเชื่อมต่อช่องใหม่ในแท็บบัญชี'
  if (service === 'drive' && /invalid_grant/i.test(msg)) hint = ' — การเชื่อมต่อ Google Drive หมดอายุ กดเชื่อมต่อใหม่ในแท็บตั้งค่า'
  if (service === 'drive' && /not been used|disabled/i.test(msg)) hint = ' — เปิด Google Drive API ในโปรเจกต์ Google Cloud ก่อน (APIs & Services → Library)'
  if (service === 'drive' && /storageQuotaExceeded|quota/i.test(msg)) hint = ' — พื้นที่ Google Drive เต็ม'
  const label = { facebook: 'Facebook', youtube: 'YouTube', drive: 'Google Drive' }[service] ?? service
  return new Error(`${label}: ${msg}${hint}`)
}

// ── Facebook ──────────────────────────────────────────────────────

/**
 * ตรวจ Page ID + โทเค็น → คืนชื่อเพจ + Page access token ที่โพสต์ได้จริง
 * รับได้ทั้ง Page token และ User token (Graph API Explorer ตั้งต้นเป็น "โทเค็นการเข้าถึงของผู้ใช้")
 * โพสต์วิดีโอขึ้นเพจด้วย User token ตรงๆ ไม่ได้ — ถ้าได้ User token มา ขอ Page token ของเพจนั้นจาก /me/accounts ให้เอง
 */
export async function facebookPageInfo({ pageId, token }, { fetchImpl = fetch } = {}) {
  const get = async (path, accessToken = token) => {
    const res = await fetchImpl(`${GRAPH}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`)
    if (!res.ok) throw await failure(res, 'facebook')
    return res.json()
  }
  const id = String(pageId)
  const me = await get('me?fields=id,name')
  let page
  if (String(me.id) === id) {
    page = { id, name: String(me.name ?? id), token, kind: 'page' }
  } else {
    // User token → หาเพจนี้ในรายการเพจที่แอปได้รับสิทธิ์
    const list = await get('me/accounts?fields=id,name,access_token&limit=100')
    const pages = list.data ?? []
    const hit = pages.find((p) => String(p.id) === id)
    if (!hit?.access_token) {
      const seen = pages.length ? `เพจที่แอปเห็นตอนนี้: ${pages.map((p) => `${p.name} (${p.id})`).join(', ')}` : 'แอปยังไม่เห็นเพจไหนเลย'
      throw new Error(
        `Facebook: โทเค็นนี้เป็นโทเค็นผู้ใช้ (${me.name ?? me.id}) และแอปยังไม่ได้รับสิทธิ์เพจ ID ${id} — ${seen}. ` +
        'แก้: ใน Graph API Explorer เพิ่มสิทธิ์ pages_show_list → กด Generate Access Token → ในหน้าต่างที่เด้งขึ้นกด "แก้ไขการตั้งค่า/เลือกเพจ" แล้วติ๊กเพจนี้ → จากนั้นเลือก "ผู้ใช้หรือเพจ" เป็นเพจนี้ แล้วคัดลอก Page token มาวาง',
      )
    }
    page = { id, name: String(hit.name ?? id), token: hit.access_token, kind: 'user' }
  }
  // ตรวจสิทธิ์ + วันหมดอายุของโทเค็นที่จะใช้จริง (debug_token ใช้โทเค็นตัวเองตรวจตัวเองได้) — ตรวจไม่ได้ก็ไม่ขวาง
  const info = await get(`debug_token?input_token=${encodeURIComponent(page.token)}`, page.token).then((r) => r.data ?? null).catch(() => null)
  if (info?.scopes && !info.scopes.includes('pages_manage_posts')) {
    throw new Error('Facebook: โทเค็นนี้ไม่มีสิทธิ์ pages_manage_posts — เพิ่มสิทธิ์นี้ใน Graph API Explorer แล้วกด Generate Access Token ใหม่')
  }
  page.expiresAt = info?.expires_at ? info.expires_at * 1000 : info ? 0 : null // 0 = ไม่หมดอายุ · null = ไม่รู้
  return page
}

/** อัปโหลดวิดีโอขึ้นเพจ (เผยแพร่ทันที — การตั้งเวลาทำฝั่งเราเอง) */
export async function facebookUpload({ pageId, token, file, title, description }, { fetchImpl = fetch } = {}) {
  const form = new FormData()
  form.append('access_token', token)
  form.append('title', String(title ?? '').slice(0, 255))
  form.append('description', String(description ?? ''))
  form.append('source', await openAsBlob(file, { type: 'video/mp4' }), 'video.mp4')
  const res = await fetchImpl(`${GRAPH_VIDEO}/${encodeURIComponent(pageId)}/videos`, { method: 'POST', body: form })
  if (!res.ok) throw await failure(res, 'facebook')
  const data = await res.json()
  if (!data.id) throw new Error('Facebook: อัปโหลดแล้วแต่ไม่ได้เลขวิดีโอกลับมา')
  return { postId: String(data.id), url: `https://www.facebook.com/${pageId}/videos/${data.id}` }
}

// ── YouTube ───────────────────────────────────────────────────────

export function youtubeAuthUrl({ clientId, redirectUri, state, scopes = YOUTUBE_SCOPES }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account', // ต้องได้ refresh_token ทุกครั้ง + เลือกบัญชี/ช่องได้
    state,
  })
  return `${GOOGLE_AUTH}?${q}`
}

async function tokenRequest(params, fetchImpl) {
  const res = await fetchImpl(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  if (!res.ok) throw await failure(res, 'youtube')
  return res.json()
}

/** แลก code จากหน้า consent เป็น refresh token + ชื่อช่อง */
export async function youtubeConnect({ clientId, clientSecret, code, redirectUri }, { fetchImpl = fetch } = {}) {
  const tok = await tokenRequest({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }, fetchImpl)
  if (!tok.refresh_token) throw new Error('YouTube: Google ไม่ได้ส่ง refresh token กลับมา — ลองเชื่อมต่อใหม่ (ถอนสิทธิ์แอปเดิมในบัญชี Google ก่อนถ้ายังไม่ได้)')
  const channel = await youtubeChannel(tok.access_token, fetchImpl)
  return { refreshToken: tok.refresh_token, ...channel }
}

async function youtubeChannel(accessToken, fetchImpl) {
  const res = await fetchImpl(`${YT_API}/channels?part=snippet&mine=true`, { headers: { authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw await failure(res, 'youtube')
  const item = (await res.json()).items?.[0]
  if (!item) throw new Error('YouTube: บัญชีนี้ยังไม่มีช่อง YouTube — สร้างช่องก่อนแล้วเชื่อมต่อใหม่')
  return { channelId: item.id, name: item.snippet?.title ?? item.id }
}

export async function youtubeAccessToken({ clientId, clientSecret, refreshToken }, { fetchImpl = fetch } = {}) {
  const tok = await tokenRequest({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }, fetchImpl)
  return tok.access_token
}

/** ชื่อคลิป YouTube: ไม่เกิน 100 ตัวอักษร ห้ามมี < > */
export const youtubeTitle = (title) => String(title ?? '').replace(/[<>]/g, '').trim().slice(0, 100)

/** อัปโหลดแบบ resumable (2 ขั้น: ขอ URL อัปโหลด → ส่งไฟล์) */
export async function youtubeUpload({ clientId, clientSecret, refreshToken, file, title, description, tags = [], privacy = 'public', categoryId = '27' }, { fetchImpl = fetch } = {}) {
  const accessToken = await youtubeAccessToken({ clientId, clientSecret, refreshToken }, { fetchImpl })
  const size = statSync(file).size
  const meta = {
    snippet: {
      title: youtubeTitle(title) || 'วิดีโอใหม่',
      description: String(description ?? '').replace(/[<>]/g, '').slice(0, 5000),
      tags: tags.map((t) => String(t).replace(/^#/, '')).filter(Boolean).slice(0, 30),
      categoryId, // 27 = Education
    },
    status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
  }
  const start = await fetchImpl(`${YT_UPLOAD}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'video/mp4',
      'x-upload-content-length': String(size),
    },
    body: JSON.stringify(meta),
  })
  if (!start.ok) throw await failure(start, 'youtube')
  const location = start.headers.get('location')
  if (!location) throw new Error('YouTube: ไม่ได้ URL สำหรับอัปโหลดกลับมา')
  const put = await fetchImpl(location, {
    method: 'PUT',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'video/mp4' },
    body: await openAsBlob(file, { type: 'video/mp4' }),
  })
  if (!put.ok) throw await failure(put, 'youtube')
  const data = await put.json()
  if (!data.id) throw new Error('YouTube: อัปโหลดแล้วแต่ไม่ได้เลขวิดีโอกลับมา')
  return { postId: data.id, url: `https://www.youtube.com/watch?v=${data.id}`, privacy: data.status?.privacyStatus ?? privacy }
}

// ── Google Drive (ที่พักคลิประหว่างรอโพสต์) ─────────────────────────

/** แลก code เป็น refresh token + บัญชีที่เชื่อม */
export async function driveConnect({ clientId, clientSecret, code, redirectUri }, { fetchImpl = fetch } = {}) {
  const tok = await tokenRequest({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }, fetchImpl)
  if (!tok.refresh_token) throw new Error('Google Drive: Google ไม่ได้ส่ง refresh token กลับมา — ลองเชื่อมต่อใหม่')
  const res = await fetchImpl(`${DRIVE_API}/about?fields=user(displayName,emailAddress)`, { headers: { authorization: `Bearer ${tok.access_token}` } })
  if (!res.ok) throw await failure(res, 'drive')
  const { user } = await res.json()
  return { refreshToken: tok.refresh_token, email: user?.emailAddress ?? '', name: user?.displayName ?? user?.emailAddress ?? 'Google Drive' }
}

async function driveToken(auth, fetchImpl) {
  return youtubeAccessToken(auth, { fetchImpl }).catch((err) => {
    throw new Error(err.message.replace(/^YouTube:/, 'Google Drive:').replace('การเชื่อมต่อช่องหมดอายุ กดเชื่อมต่อช่องใหม่ในแท็บบัญชี', 'การเชื่อมต่อ Google Drive หมดอายุ กดเชื่อมต่อใหม่ในแท็บตั้งค่า'))
  })
}

/** โฟลเดอร์ที่เก็บคลิป — ใช้ของเดิมถ้ายังอยู่ (ไม่ถูกลบ/ไม่อยู่ในถังขยะ) ไม่งั้นสร้างใหม่ */
export async function driveFolder({ folderId, ...auth }, { fetchImpl = fetch } = {}) {
  const accessToken = await driveToken(auth, fetchImpl)
  const headers = { authorization: `Bearer ${accessToken}` }
  if (folderId) {
    const res = await fetchImpl(`${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,trashed`, { headers })
    if (res.ok && !(await res.json()).trashed) return { folderId, accessToken }
  }
  const res = await fetchImpl(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  })
  if (!res.ok) throw await failure(res, 'drive')
  return { folderId: (await res.json()).id, accessToken }
}

/** อัปโหลดคลิปเข้าโฟลเดอร์ (resumable — ไฟล์ใหญ่ก็ได้) · คืน { fileId, link, folderId } */
export async function driveUpload({ file, name, folderId, ...auth }, { fetchImpl = fetch } = {}) {
  const folder = await driveFolder({ folderId, ...auth }, { fetchImpl })
  const size = statSync(file).size
  const start = await fetchImpl(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id,webViewLink`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${folder.accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'video/mp4',
      'x-upload-content-length': String(size),
    },
    body: JSON.stringify({ name, parents: [folder.folderId], mimeType: 'video/mp4' }),
  })
  if (!start.ok) throw await failure(start, 'drive')
  const location = start.headers.get('location')
  if (!location) throw new Error('Google Drive: ไม่ได้ URL สำหรับอัปโหลดกลับมา')
  const put = await fetchImpl(location, {
    method: 'PUT',
    headers: { authorization: `Bearer ${folder.accessToken}`, 'content-type': 'video/mp4' },
    body: await openAsBlob(file, { type: 'video/mp4' }),
  })
  if (!put.ok) throw await failure(put, 'drive')
  const data = await put.json()
  if (!data.id) throw new Error('Google Drive: อัปโหลดแล้วแต่ไม่ได้เลขไฟล์กลับมา')
  return { fileId: data.id, link: data.webViewLink ?? `https://drive.google.com/file/d/${data.id}/view`, folderId: folder.folderId }
}

/** ย้ายไฟล์ไปถังขยะของ Drive (กู้คืนได้ 30 วัน แล้ว Google ลบถาวรเอง) · ไฟล์หายไปแล้วถือว่าสำเร็จ */
export async function driveTrash({ fileId, ...auth }, { fetchImpl = fetch } = {}) {
  const accessToken = await driveToken(auth, fetchImpl)
  const res = await fetchImpl(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ trashed: true }),
  })
  if (res.status === 404) return { gone: true }
  if (!res.ok) throw await failure(res, 'drive')
  return { trashed: true }
}
