/**
 * หน้า UI บน bridge — ทำคลิปครบทุกขั้นด้วยการกดปุ่ม ไม่ต้องพิมพ์คำสั่ง
 *
 *   ดับเบิลคลิก เปิดโปรแกรม.bat → http://127.0.0.1:8765/
 *
 * ขั้น 1 หัวข้อ + บทพากย์ ส่งงานเข้าคิว ChatGPT ตรงๆ (prompt ตัวเดียวกับ CLI — Blueprint ทั้งฉบับ)
 *   STAGE 1 ได้ตาราง "# | Video Title | Genre" 5 แถว แล้วผู้ใช้คลิกเลือกจากตาราง
 * ขั้น 2-6 รันสคริปต์ใน pipeline/ ตัวเดิมผ่าน runner.js — ผลเป็นไฟล์ชุดเดียวกับรันจาก terminal
 *
 * ทุกขั้นผ่านเว็บ (ChatGPT, Google Flow) หรือรันในเครื่อง ไม่เรียก API ใดๆ
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, createReadStream, createWriteStream, unlinkSync, renameSync } from 'node:fs'
import { pipeline as pipeStreams } from 'node:stream/promises'
import { join, resolve, sep, extname } from 'node:path'
import { ROOT, loadConfig, slugify } from '../pipeline/lib/config.mjs'
import { topicsPrompt, scriptPrompt, parseTopics, cleanScript, GENRES } from '../pipeline/lib/prompts.mjs'
import { saveScript, loadScript } from '../pipeline/lib/stage2.mjs'
import { createRunner } from './runner.js'
import { projectStatus, setupStatus, bgmFile, BGM_EXT, listProjects } from './project.js'
import { listVoices, readVoice, writeVoice, voiceDir, voiceId, voiceReady, AUDIO_EXT } from '../pipeline/lib/voices.mjs'
import { EDGE_VOICES, GEMINI_VOICES, GEMINI_MODELS, edgePython, synthCloud } from '../pipeline/lib/cloud_tts.mjs'
import { hasKey } from '../pipeline/lib/env.mjs'
import { shotlistFiles, readRounds, resetRounds, mergeRounds, saveRound, nextRoundPrompt } from '../pipeline/lib/shotlist.mjs'
import { execFileSync } from 'node:child_process'
import { parseTimecodeFilename } from '../pipeline/lib/shotfile.mjs'
import { listVideos, trashVideo, renameProject, revealVideo } from './videos.js'
import { checklist } from './checklist.js'
import { autopilotProgress } from '../pipeline/lib/progress.mjs'
import { readCharacter, updateCharacter, addCharacterImage, removeCharacterImage, clearCharacter, characterAttachments, activeCharacter, CHARACTER_DIR } from '../pipeline/lib/character.mjs'
import { PAUSE_PRESETS, MOTION_PRESETS } from '../pipeline/lib/ffmpeg.mjs'
import { SUBTITLE_STYLES } from '../pipeline/lib/subtitles.mjs'
import { readAsrTimeline, writeAsrTimeline, parseSegmentText } from '../pipeline/lib/asr.mjs'

const CONFIG_FILE = join(ROOT, 'config', 'project.config.json')
const MIME = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8',
}

const TOPICS_FILE = join(ROOT, 'projects', 'topics.json')
const SELECTED_FILE = join(ROOT, 'projects', 'selected_topic.json')
const PAGE = join(ROOT, 'ui', 'index.html')
// Exact allowlist: shared UI assets only, never arbitrary filesystem paths.
const UI_ASSETS = {
  '/assets/icons.css': ['icons.css', 'text/css; charset=utf-8'],
  '/assets/icons.js': ['icons.js', 'text/javascript; charset=utf-8'],
  '/assets/cartoon-auto.svg': ['icons/cartoon-auto.svg', 'image/svg+xml'],
}

// extension long-poll ทีละ 25 วิ และวนสลับ agent → เกิน 70 วิแปลว่าหลุดจริง
const CONNECTED_WINDOW_MS = 70_000

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback)

export function createUi({ jobs, enqueue, lastPoll, token, port, json, readBody, log }) {
  const runner = createRunner({ log })

  function state({ freshSetup = false } = {}) {
    const config = loadConfig()
    const selected = readJson(SELECTED_FILE, null)
    const connected = (agent) => Date.now() - (lastPoll[agent] ?? 0) < CONNECTED_WINDOW_MS
    return {
      topics: readJson(TOPICS_FILE, []),
      selected,
      project: selected ? projectStatus(config, selected.title, slugify(selected.title)) : null,
      setup: setupStatus(config, { fresh: freshSetup }),
      run: runner.snapshot(),
      busyJob: [...jobs.values()].some((j) => j.payload?.uiStage && ['queued', 'running'].includes(j.status)),
      titleLanguage: config.script.titleLanguage ?? 'en',
      language: config.script.language ?? 'th',
      targetMinutes: config.script.targetMinutes,
      chatgptConnected: connected('chatgpt'),
      flowConnected: connected('flow'),
    }
  }

  /**
   * สถานะของแต่ละ agent: ChatGPT / Google Flow (งานในคิว) + เสียงพากย์ / ตัดต่อ (โปรแกรมในเครื่อง)
   * state: working | waiting (มีงานรอคิว) | idle | offline
   */
  function agentsStatus() {
    const now = Date.now()
    const run = runner.snapshot()
    const running = run?.status === 'running' ? run : null
    const auto = running?.step === 'autopilot' && running.slug ? readJson(join(ROOT, 'projects', running.slug, 'autopilot.json'), null) : null
    const connected = (agent) => now - (lastPoll[agent] ?? 0) < CONNECTED_WINDOW_MS
    const STAGE = { generate: 'สร้างภาพ', rename: 'ตั้งชื่อภาพ', save: 'บันทึกภาพ', retry: 'สั่งช็อตที่ขาดซ้ำ' }

    const webAgent = (agent) => {
      const list = [...jobs.values()].filter((j) => j.agent === agent)
      const active = list.find((j) => j.status === 'running')
      const queued = list.filter((j) => j.status === 'queued').length
      if (active) {
        const p = active.progress
        const doing =
          active.payload?.label ??
          (agent === 'flow' ? `${STAGE[p?.stage] ?? 'สร้างภาพ'}${p?.total ? ` ${p.done ?? 0}/${p.total} ใบ` : ''}` : 'กำลังตอบ prompt')
        return { state: 'working', doing, since: active.createdAt, queued, attempt: active.attempts ?? 1 }
      }
      if (queued) return { state: 'waiting', doing: `มีงานรอ ${queued} งาน${connected(agent) ? '' : ' — extension ยังไม่มารับ'}`, queued }
      return { state: connected(agent) ? 'idle' : 'offline', doing: connected(agent) ? 'ว่าง' : 'extension ยังไม่ได้ต่อ' }
    }

    const LOCAL = {
      voice: { tts: 'สร้างเสียงพากย์', importAudio: 'ถอดเสียงที่นำเข้า', trainVoice: 'เทรนเสียง', setupTts: 'ติดตั้งระบบเสียง', timecode: 'ทำ Timecode' },
      edit: { render: 'ตัดต่อวิดีโอ' },
    }
    const localAgent = (id, dept) => {
      if (running && LOCAL[id][running.step]) {
        return { state: 'working', doing: `${LOCAL[id][running.step]}${running.lines?.length ? ` · ${running.lines.at(-1).slice(0, 80)}` : ''}`, since: running.startedAt }
      }
      const d = auto?.departments?.[dept]
      if (d?.status === 'working') return { state: 'working', doing: d.detail || 'กำลังทำ', since: auto.updatedAt }
      return { state: 'idle', doing: 'ว่าง' }
    }

    return {
      agents: [
        { id: 'chatgpt', name: 'ChatGPT', role: 'เขียนบท · กำกับภาพ', ...webAgent('chatgpt') },
        { id: 'flow', name: 'Google Flow', role: 'วาดภาพ', ...webAgent('flow') },
        { id: 'voice', name: 'เสียงพากย์', role: 'ในเครื่อง', ...localAgent('voice', 'voice') },
        { id: 'edit', name: 'ตัดต่อ', role: 'ในเครื่อง', ...localAgent('edit', 'edit') },
      ],
      autopilot: auto
        ? { title: auto.title, current: auto.current, status: auto.status, startedAt: auto.startedAt, departments: auto.departments, progress: autopilotProgress(auto) }
        : running?.step === 'autopilot'
          ? { title: running.title ?? 'กำลังคิดหัวข้อ', current: 'topic', status: 'running', startedAt: running.startedAt, progress: { percent: 1, current: 'topic', label: 'คิดหัวข้อ', step: 1, steps: 6, count: '', etaSec: null } }
          : null,
      at: now,
    }
  }

  const selectedSlug = () => {
    const selected = readJson(SELECTED_FILE, null)
    return selected ? slugify(selected.title) : null
  }

  /** ไฟล์ของคลิป (เสียง ภาพ วิดีโอ) — ส่งแบบ Range ได้ เพื่อให้เลื่อนดูวิดีโอ/เสียงในหน้าเว็บได้ */
  function serveFile(req, res, url) {
    const [, , slug, ...rest] = url.pathname.split('/').map(decodeURIComponent)
    const base = resolve(ROOT, 'projects', slug ?? '')
    const file = resolve(base, ...rest)
    if (!slug || !rest.length || !file.startsWith(base + sep) || !existsSync(file)) {
      res.writeHead(404)
      return res.end()
    }
    const size = statSync(file).size
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 })
      return createReadStream(file, { start, end }).pipe(res)
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' })
    createReadStream(file).pipe(res)
  }

  function updateConfig(mutate) {
    const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    mutate(config)
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
  }

  /**
   * สถานะงานของหน้า UI — พองานเสร็จจะเรียก finish ครั้งเดียวแล้วเก็บผลไว้บน job
   * UI poll ซ้ำได้โดยไม่เขียนไฟล์ซ้ำ
   */
  function jobResult(id, stage, finish) {
    const job = jobs.get(id)
    if (!job || job.payload?.uiStage !== stage) return null
    if (job.status !== 'done') return { status: job.status, error: job.error ?? null }
    if (!job.uiResult) {
      const text = job.result?.text ?? ''
      try {
        job.uiResult = finish(text, job)
      } catch (err) {
        job.uiResult = { status: 'error', error: err.message }
      }
      if (job.uiResult.status === 'error') job.uiResult.raw = text.slice(0, 2000)
    }
    return job.uiResult
  }

  function finishTopics(text) {
    const topics = parseTopics(text)
    if (!topics.length) return { status: 'error', error: 'อ่านตารางหัวข้อจากคำตอบไม่ออก' }
    mkdirSync(join(ROOT, 'projects'), { recursive: true })
    writeFileSync(TOPICS_FILE, JSON.stringify(topics, null, 2))
    return { status: 'done', topics }
  }

  function finishScript(text, job) {
    const { title, config } = job.payload.uiScript
    if (!text.trim()) return { status: 'error', error: 'ChatGPT ไม่ได้ส่งบทกลับมา' }
    return { status: 'done', ...saveScript(config, title, text) }
  }

  async function handle(req, res, url) {
    const path = url.pathname

    // กัน DNS rebinding: เว็บภายนอกที่ชี้โดเมนตัวเองมา 127.0.0.1 จะมี Host ไม่ตรง
    const host = req.headers.host ?? ''
    const localHost = host === `127.0.0.1:${port}` || host === `localhost:${port}`

    if (req.method === 'GET' && Object.hasOwn(UI_ASSETS, path)) {
      if (!localHost) return json(res, 403, { error: 'เปิดผ่าน 127.0.0.1 เท่านั้น' }), true
      const [file, type] = UI_ASSETS[path]
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
      res.end(readFileSync(join(ROOT, 'extension', file)))
      return true
    }

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      if (!localHost) return json(res, 403, { error: 'เปิดผ่าน 127.0.0.1 เท่านั้น' }), true
      // ฝัง token ลงหน้า — เว็บอื่นอ่าน HTML ข้าม origin ไม่ได้ (ไม่มี CORS header)
      const html = readFileSync(PAGE, 'utf8').replace('__BRIDGE_TOKEN__', token)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return true
    }

    // <audio>/<video>/<img> ส่ง header เองไม่ได้ → รับ token ทาง query (?k=)
    // ไม่ใช้ cookie เพราะหน้านี้ถูกฝังในแผงข้างของ extension ซึ่งนับเป็น third-party — cookie จะไม่ถูกส่ง
    if (req.method === 'GET' && path.startsWith('/files/')) {
      if (!localHost || url.searchParams.get('k') !== token) return json(res, 401, { error: 'token ไม่ถูกต้อง' }), true
      serveFile(req, res, url)
      return true
    }

    if (!path.startsWith('/api/')) return false
    if (!localHost || req.headers['x-bridge-token'] !== token) return json(res, 401, { error: 'token ไม่ถูกต้อง' }), true

    try {
      if (req.method === 'GET' && path === '/api/state') {
        return json(res, 200, state({ freshSetup: url.searchParams.has('fresh') })), true
      }

      // หัวข้อ + บทที่ทำในแผงข้างของ extension → เป็นไฟล์ชุดเดียวกับที่ขั้น 1-2 ของหน้านี้เขียน
      if (req.method === 'POST' && path === '/api/import') {
        const { topics, n, script, language, targetMinutes } = await readBody(req)
        const topic = (topics ?? []).find((t) => t.n === Number(n))
        if (!topic || !String(script ?? '').trim()) return json(res, 400, { error: 'ต้องมีหัวข้อที่เลือกและบทพากย์' }), true
        if (!['th', 'en'].includes(language)) return json(res, 400, { error: 'ภาษาต้องเป็น th หรือ en' }), true
        const cleanTopics = topics.map((t) => ({ n: Number(t.n), title: String(t.title) }))
        mkdirSync(join(ROOT, 'projects'), { recursive: true })
        writeFileSync(TOPICS_FILE, JSON.stringify(cleanTopics, null, 2))
        writeFileSync(SELECTED_FILE, JSON.stringify({ n: topic.n, title: topic.title, selectedAt: new Date().toISOString() }, null, 2))
        const config = loadConfig()
        config.script.language = language
        config.script.targetMinutes = Number(targetMinutes) || config.script.targetMinutes
        // บทเดิมไม่เปลี่ยน → ไม่เขียนทับ ไม่งั้นเสียง/ภาพที่ทำไว้แล้วจะถูกนับว่าเก่ากว่าบท
        const existing = loadScript(config, topic.title)
        if (existing && existing.script.trim() === cleanScript(String(script)).trim()) return json(res, 200, { slug: existing.slug }), true
        const saved = saveScript(config, topic.title, String(script))
        return json(res, 200, { slug: saved.slug }), true
      }

      // ── project เก่าในโฟลเดอร์ projects/ ──
      // ── คลังวิดีโอ ──
      if (req.method === 'GET' && path === '/api/videos') {
        return json(res, 200, { videos: await listVideos() }), true
      }
      if (req.method === 'POST' && path === '/api/videos/delete') {
        const body = await readBody(req)
        const selected = readJson(SELECTED_FILE, null)
        const result = trashVideo(body)
        // ลบทั้ง project ที่เลือกอยู่ → ล้างการเลือก ไม่งั้นขั้นอื่นจะชี้ไปโฟลเดอร์ที่ไม่มีแล้ว
        if (body.wholeProject && selected && slugify(selected.title) === body.slug) unlinkSync(SELECTED_FILE)
        return json(res, 200, result), true
      }
      if (req.method === 'POST' && path === '/api/videos/rename') {
        const body = await readBody(req)
        const selected = readJson(SELECTED_FILE, null)
        const result = renameProject(body)
        if (selected && slugify(selected.title) === body.slug) {
          writeFileSync(SELECTED_FILE, JSON.stringify({ ...selected, title: result.title }, null, 2))
        }
        return json(res, 200, result), true
      }
      if (req.method === 'POST' && path === '/api/videos/reveal') {
        return json(res, 200, revealVideo(await readBody(req))), true
      }

      if (req.method === 'GET' && path === '/api/projects') {
        return json(res, 200, { projects: listProjects(loadConfig()) }), true
      }

      if (req.method === 'POST' && path === '/api/open') {
        const { slug } = await readBody(req)
        const found = listProjects(loadConfig()).find((p) => p.slug === slug)
        if (!found) return json(res, 404, { error: 'ไม่พบ project นี้' }), true
        const config = loadConfig()
        const script = loadScript(config, found.title)
        writeFileSync(SELECTED_FILE, JSON.stringify({ n: 1, title: found.title, selectedAt: new Date().toISOString() }, null, 2))
        const metaFile = join(ROOT, 'projects', slug, '01_script', 'meta.json')
        const meta = readJson(metaFile, {})
        return json(res, 200, {
          title: found.title,
          script: script?.script ?? null,
          language: meta.language ?? config.script.language,
          targetMinutes: meta.targetMinutes ?? config.script.targetMinutes,
          project: projectStatus(config, found.title, slug),
        }), true
      }

      // ── ขั้น 2-6: รันสคริปต์ของ pipeline ──
      // ── คลังเสียง: เลือกเสียง / สร้างเสียงใหม่ / อัปโหลดไฟล์ / เทรน ──
      if (req.method === 'GET' && path === '/api/voices') {
        const run = runner.snapshot()
        const config = loadConfig()
        const engine = config.tts.engine
        return json(res, 200, {
          voices: listVoices(),
          selected: loadConfig().tts.myVoice?.voice ?? null,
          // ตัวเลือกที่ใช้อยู่จริง รูปแบบ "<engine>:<id>" — เสียงของเรา / Edge / Gemini
          choice: ['edge', 'gemini'].includes(engine) ? `${engine}:${config.tts[engine]?.voice}` : `my-voice:${config.tts.myVoice?.voice}`,
          edge: { ready: existsSync(edgePython()), voices: EDGE_VOICES },
          language: config.script.language,
          gemini: { hasKey: hasKey('GEMINI_API_KEY'), model: config.tts.gemini?.model, models: GEMINI_MODELS, voices: GEMINI_VOICES },
          training: run?.step === 'trainVoice' && run.status === 'running' ? run.slug : null,
          epochs: loadConfig().tts.myVoice?.trainEpochs ?? 40,
        }), true
      }

      if (req.method === 'POST' && path === '/api/voices/select') {
        const { id, engine = 'my-voice' } = await readBody(req)
        if (engine === 'edge' || engine === 'gemini') {
          const catalog = engine === 'edge' ? EDGE_VOICES : GEMINI_VOICES
          if (!catalog.some((v) => v.id === id)) return json(res, 400, { error: `ไม่มีเสียง ${id}` }), true
          updateConfig((c) => {
            c.tts.engine = engine
            c.tts[engine] = { ...(c.tts[engine] ?? {}), voice: id }
          })
          return json(res, 200, { choice: `${engine}:${id}` }), true
        }
        if (!voiceReady(id)) return json(res, 400, { error: 'เสียงนี้ยังไม่พร้อมใช้ — ต้องเทรนให้เสร็จก่อน' }), true
        updateConfig((c) => {
          c.tts.engine = 'my-voice'
          c.tts.myVoice.voice = id
        })
        return json(res, 200, { choice: `my-voice:${id}` }), true
      }

      // ฟังตัวอย่างเสียงออนไลน์ก่อนเลือก — เก็บไฟล์ไว้ใน projects/_previews ให้ /files เสิร์ฟได้
      if (req.method === 'POST' && path === '/api/voices/preview') {
        const { engine, id, text, emotion = 'calm', speed = 1 } = await readBody(req)
        if (!['edge', 'gemini'].includes(engine)) return json(res, 400, { error: 'ฟังตัวอย่างได้เฉพาะเสียงออนไลน์' }), true
        const catalog = engine === 'edge' ? EDGE_VOICES : GEMINI_VOICES
        if (!catalog.some((v) => v.id === id)) return json(res, 400, { error: `ไม่มีเสียง ${id}` }), true
        // เสียงอังกฤษล้วนอ่านไทยไม่ออก → ตัวอย่างเป็นภาษาอังกฤษ
        const englishOnly = engine === 'edge' && EDGE_VOICES.find((v) => v.id === id)?.readsThai === false
        const sample = String(text ?? '').trim().slice(0, 300) || (englishOnly
          ? 'Imagine you could stop time for one second. Physicists say the moment you call now might not exist at all.'
          : 'ลองจินตนาการว่าคุณหยุดเวลาได้หนึ่งวินาที... นักฟิสิกส์บอกว่าสิ่งที่คุณเรียกว่า ตอนนี้ อาจไม่มีอยู่จริงเลย')
        const dir = join(ROOT, 'projects', '_previews')
        const name = `${engine}_${id}_${emotion}_${Number(speed).toFixed(2)}_${Buffer.from(sample).toString('base64url').slice(-12)}.wav`
        const file = join(dir, name)
        if (!existsSync(file)) {
          const config = loadConfig()
          await synthCloud(engine, [{ index: 0, text: sample, out: file }], { voice: id, model: config.tts.gemini?.model, emotion, speed }, () => {})
        }
        return json(res, 200, { url: `/files/_previews/${encodeURIComponent(name)}?v=${Math.round(statSync(file).mtimeMs)}` }), true
      }

      // ผู้ใช้กรอก Gemini API key เองในแผงข้าง → เขียนลง .env (ไฟล์นี้ถูก gitignore)
      if (req.method === 'POST' && path === '/api/gemini-key') {
        const key = String((await readBody(req)).key ?? '').trim()
        if (!/^[\w-]{20,}$/.test(key)) return json(res, 400, { error: 'รูปแบบ API key ไม่ถูกต้อง' }), true
        const envFile = join(ROOT, '.env')
        const text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
        writeFileSync(envFile, /^GEMINI_API_KEY=.*$/m.test(text) ? text.replace(/^GEMINI_API_KEY=.*$/m, `GEMINI_API_KEY=${key}`) : `${text.replace(/\n?$/, '\n')}GEMINI_API_KEY=${key}\n`)
        process.env.GEMINI_API_KEY = key
        return json(res, 200, { hasKey: true }), true
      }

      if (req.method === 'POST' && path === '/api/voices/create') {
        const label = String((await readBody(req)).label ?? '').trim()
        if (!label) return json(res, 400, { error: 'ตั้งชื่อเสียงก่อน' }), true
        let id = voiceId(label)
        for (let i = 2; existsSync(voiceDir(id)); i++) id = `${voiceId(label)}_${i}`
        writeVoice(id, { label, status: 'draft', createdAt: new Date().toISOString() })
        return json(res, 200, { id }), true
      }

      // ไฟล์เสียงเทรนใหญ่ (หลายสิบ MB ต่อไฟล์) — รับเป็น binary ตรงๆ ลงดิสก์ ไม่ผ่าน JSON/base64
      if (req.method === 'POST' && path === '/api/voices/upload') {
        const id = url.searchParams.get('voice')
        const name = String(url.searchParams.get('name') ?? '').replace(/[\\/:*?"<>|]+/g, '_').slice(-120)
        const ext = name.split('.').pop().toLowerCase()
        if (!readVoice(id)) return json(res, 404, { error: 'ไม่พบเสียงนี้' }), true
        if (!AUDIO_EXT.includes(ext)) return json(res, 400, { error: `รองรับเฉพาะ ${AUDIO_EXT.join(', ')}` }), true
        const run = runner.snapshot()
        if (run?.step === 'trainVoice' && run.status === 'running' && run.slug === id) {
          return json(res, 409, { error: 'กำลังเทรนเสียงนี้อยู่ — หยุดก่อนถึงจะเพิ่มไฟล์ได้' }), true
        }
        const dir = join(voiceDir(id), 'raw')
        mkdirSync(dir, { recursive: true })
        const temp = join(dir, `.${name}.part`)
        await pipeStreams(req, createWriteStream(temp))
        renameSync(temp, join(dir, name))
        return json(res, 200, { voices: listVoices() }), true
      }

      if (req.method === 'POST' && path === '/api/voices/remove-file') {
        const { voice, name } = await readBody(req)
        const file = resolve(voiceDir(voice), 'raw', String(name))
        if (!file.startsWith(join(voiceDir(voice), 'raw') + sep) || !existsSync(file)) return json(res, 404, { error: 'ไม่พบไฟล์' }), true
        unlinkSync(file)
        return json(res, 200, { voices: listVoices() }), true
      }

      if (req.method === 'POST' && path === '/api/voices/train') {
        const { voice, epochs } = await readBody(req)
        if (!readVoice(voice)) return json(res, 404, { error: 'ไม่พบเสียงนี้' }), true
        const n = Math.min(200, Math.max(1, Math.round(Number(epochs) || 40)))
        updateConfig((c) => {
          c.tts.myVoice.trainEpochs = n
        })
        return json(res, 200, runner.start('trainVoice', voice, { voice, epochs: n })), true
      }

      // ── นำเข้าเสียงพากย์จากที่อื่น → ถอดเสียง → timecode (แทนขั้นทำเสียงด้วย TTS) ──
      if (req.method === 'POST' && path === '/api/audio/import') {
        const name = String(url.searchParams.get('name') ?? '').replace(/[\\/:*?"<>|]+/g, '_').slice(-120)
        const language = url.searchParams.get('language') === 'en' ? 'en' : 'th'
        const title = String(url.searchParams.get('title') ?? '').trim()
        const ext = name.split('.').pop().toLowerCase()
        if (!['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm', 'mp4'].includes(ext)) {
          return json(res, 400, { error: 'รองรับไฟล์เสียง wav, mp3, m4a, aac, flac, ogg, opus (หรือวิดีโอ mp4/webm)' }), true
        }
        const run = runner.snapshot()
        if (run?.status === 'running') return json(res, 409, { error: `กำลัง${run.label}อยู่ — รอให้เสร็จก่อน` }), true
        let slug = selectedSlug()
        if (title) {
          // เสียงที่ไม่มีบทในระบบ → สร้าง project ใหม่จากชื่อเรื่อง
          slug = slugify(title)
          const scriptDir = join(ROOT, 'projects', slug, '01_script')
          mkdirSync(scriptDir, { recursive: true })
          writeFileSync(join(scriptDir, 'title.txt'), title, 'utf8')
          writeFileSync(SELECTED_FILE, JSON.stringify({ n: 1, title, selectedAt: new Date().toISOString() }, null, 2))
        }
        if (!slug) return json(res, 400, { error: 'ตั้งชื่อเรื่องก่อน หรือเลือก project' }), true
        const audioDir = join(ROOT, 'projects', slug, '02_audio')
        mkdirSync(audioDir, { recursive: true })
        const file = join(audioDir, `source.${ext}`)
        await pipeStreams(req, createWriteStream(file))
        return json(res, 200, { slug, run: runner.start('importAudio', slug, { file, language }) }), true
      }

      // ข้อความ + เวลาของแต่ละประโยค (แบบ SayToWords) — แก้ได้เฉพาะเสียงที่นำเข้า (ถอดเสียงอาจผิด)
      if (path === '/api/transcript') {
        const slug = selectedSlug()
        if (!slug) return json(res, 400, { error: 'ยังไม่ได้เลือกหัวข้อ' }), true
        const tcDir = join(ROOT, 'projects', slug, '03_timecode')
        if (req.method === 'GET') {
          const asr = readAsrTimeline(slug)
          const segFile = join(tcDir, 'segments.txt')
          if (!existsSync(segFile)) return json(res, 200, { available: false }), true
          const t = (f) => `/files/${encodeURIComponent(slug)}/03_timecode/${f}?v=${Math.round(statSync(join(tcDir, f)).mtimeMs)}`
          return json(res, 200, {
            available: true,
            editable: !!asr,
            source: asr ? 'asr' : 'tts',
            text: readFileSync(segFile, 'utf8'),
            files: { srt: t('subtitle.srt'), txt: t('segments.txt'), timecode: t('timecode.txt') },
          }), true
        }
        if (req.method === 'POST') {
          const asr = readAsrTimeline(slug)
          if (!asr) return json(res, 400, { error: 'แก้ได้เฉพาะเสียงที่นำเข้า — เสียงจาก TTS ให้แก้ที่บทแล้วทำเสียงใหม่' }), true
          const segments = parseSegmentText(String((await readBody(req)).text ?? ''))
          if (!segments.length) return json(res, 400, { error: 'อ่านรูปแบบไม่ออก — ต้องเป็น (00:00:04,340 --> 00:00:08,660) ตามด้วยข้อความ' }), true
          writeAsrTimeline(slug, segments, { duration: asr.totalDuration, language: asr.language })
          execFileSync(process.execPath, [join(ROOT, 'pipeline', '3_timecode.mjs'), slug], { cwd: ROOT, windowsHide: true, stdio: 'pipe' })
          return json(res, 200, { segments: segments.length }), true
        }
      }

      // ── ขั้นที่ 5: ภาพจาก Google Flow → projects/<slug>/05_images/<timecode>.png ──
      if (req.method === 'POST' && path === '/api/images/save') {
        const slug = selectedSlug()
        if (!slug) return json(res, 400, { error: 'ยังไม่ได้เลือกหัวข้อ' }), true
        const { name, base64 } = await readBody(req)
        // ชื่อไฟล์ต้องอ่านเวลากลับได้ (กฎ 4) — ขั้นตัดต่อวางภาพตามชื่อไฟล์
        if (parseTimecodeFilename(String(name)) == null && String(name) !== 'cover.png') return json(res, 400, { error: `ชื่อไฟล์ไม่ใช่ timecode: ${name}` }), true
        const dir = join(ROOT, 'projects', slug, '05_images')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, String(name)), Buffer.from(String(base64), 'base64'))
        return json(res, 200, { saved: name }), true
      }

      // ── ขั้นที่ 4: prompt ภาพสำหรับ Google Flow (OUTPUT 5) — แผงข้างส่ง prompt ให้ ChatGPT ทีละรอบ ──
      if (path === '/api/shotlist' || path.startsWith('/api/shotlist/')) {
        const slug = selectedSlug()
        if (!slug) return json(res, 400, { error: 'ยังไม่ได้เลือกหัวข้อ' }), true
        const files = shotlistFiles(slug)
        const context = () => ({
          title: readFileSync(join(ROOT, 'projects', slug, '01_script', 'title.txt'), 'utf8').trim(),
          timecodeText: readFileSync(join(ROOT, 'projects', slug, '03_timecode', 'timecode.txt'), 'utf8'),
        })
        const withNext = (merged) => {
          const next = nextRoundPrompt(loadConfig(), slug, context())
          // รอบแรกที่ใช้ตัวละครของฉัน → แผงข้างแนบรูปไปกับ prompt ด้วย
          if (next?.attachCharacter) next.attachments = characterAttachments()
          return { ...merged, next }
        }

        // สถานะล่าสุด (เปิด project เก่า / เปิดแผงใหม่)
        if (req.method === 'GET' && path === '/api/shotlist') {
          return json(res, 200, existsSync(files.slots) && readRounds(slug).length ? withNext(mergeRounds(slug)) : { rounds: 0 }), true
        }

        // เริ่มใหม่: คำนวณ timecode + ช่องช็อตจากเสียงพากย์ แล้วล้างคำตอบรอบเก่า
        if (req.method === 'POST' && path === '/api/shotlist/start') {
          const { resume } = await readBody(req)
          const run = runner.snapshot()
          if (run?.status === 'running') return json(res, 409, { error: `กำลัง${run.label}อยู่ — รอให้เสร็จก่อน` }), true
          const audio = join(ROOT, 'projects', slug, '02_audio')
          if (!existsSync(join(audio, 'durations.json')) && !existsSync(join(audio, 'asr_timeline.json'))) {
            return json(res, 400, { error: 'ต้องทำเสียงพากย์ให้เสร็จก่อน — prompt ภาพอ้างอิงจังหวะของเสียง' }), true
          }
          if (!(resume && existsSync(files.slots))) {
            try {
              execFileSync(process.execPath, [join(ROOT, 'pipeline', '3_timecode.mjs'), slug], { cwd: ROOT, windowsHide: true, stdio: 'pipe' })
            } catch (err) {
              return json(res, 500, { error: `ทำ Timecode ไม่สำเร็จ: ${String(err.stderr || err.message).trim().split('\n').pop()}` }), true
            }
            resetRounds(slug)
          }
          const slots = JSON.parse(readFileSync(files.slots, 'utf8'))
          const merged = readRounds(slug).length ? mergeRounds(slug) : { total: slots.length, withPrompt: 0, missing: slots.map((s) => s.filename), rounds: 0 }
          return json(res, 200, withNext(merged)), true
        }

        // คำตอบของ ChatGPT หนึ่งรอบ → รวม → บอกรอบถัดไป (ถ้ายังมีช็อตที่ขาด)
        if (req.method === 'POST' && path === '/api/shotlist/round') {
          const { raw } = await readBody(req)
          if (!String(raw ?? '').trim()) return json(res, 400, { error: 'คำตอบว่าง' }), true
          if (!existsSync(files.slots)) return json(res, 400, { error: 'ยังไม่ได้เริ่มสร้าง prompt ภาพ' }), true
          return json(res, 200, withNext(saveRound(slug, String(raw)))), true
        }
      }

      if (req.method === 'POST' && path === '/api/run') {
        const { step } = await readBody(req)
        const slug = step === 'setupTts' ? null : selectedSlug()
        if (step !== 'setupTts' && !slug) return json(res, 400, { error: 'ยังไม่ได้เลือกหัวข้อ' }), true
        const bgm = step === 'render' ? bgmFile(slug) : null
        return json(res, 200, runner.start(step, slug, { bgm })), true
      }

      if (req.method === 'POST' && path === '/api/run/stop') {
        const run = runner.snapshot()
        const stopped = runner.stop() ?? {}
        if (run?.step === 'autopilot' && run.status === 'running') {
          // งานที่ยังรอคิวอยู่ ไม่ต้องให้ ChatGPT/Flow หยิบไปทำหลังหยุดแล้ว
          for (const job of jobs.values()) {
            if (job.status === 'queued') Object.assign(job, { status: 'error', error: 'หยุดโดยผู้ใช้' })
          }
          // บันทึกว่าหยุดเอง — กด "ทำต่อ" ได้ แม้โปรแกรมในเครื่องถูกปิดไปก่อน
          const file = run.slug ? join(ROOT, 'projects', run.slug, 'autopilot.json') : null
          const st = file && existsSync(file) ? readJson(file, null) : null
          if (st?.status === 'running') {
            for (const d of Object.values(st.departments ?? {})) if (d.status === 'working') Object.assign(d, { status: 'waiting', detail: 'หยุดไว้ — กดทำต่อ' })
            writeFileSync(file, JSON.stringify({ ...st, status: 'stopped', stoppedAt: Date.now(), updatedAt: Date.now() }, null, 2))
          }
        }
        return json(res, 200, stopped), true
      }

      // ── ตรวจความพร้อมของเครื่อง (เปิดดูเมื่ออยากรู้) ──
      if (req.method === 'GET' && path === '/api/checklist') {
        const connected = (agent) => Date.now() - (lastPoll[agent] ?? 0) < CONNECTED_WINDOW_MS
        return json(res, 200, await checklist({ connected })), true
      }

      // ── ใครกำลังทำอะไร — อ่านสถานะที่มีอยู่แล้วในหน่วยความจำ ไม่เรียกโปรแกรมภายนอก จึงถามบ่อยได้ ──
      if (req.method === 'GET' && path === '/api/agents') {
        return json(res, 200, agentsStatus()), true
      }

      // ── ทำคลิปอัตโนมัติ: หัวข้อเดียว → ทุกแผนกทำต่อกันจนได้ MP4 ──
      if (req.method === 'POST' && path === '/api/autopilot') {
        const body = await readBody(req)
        const title = String(body.title ?? '').trim()
        const autoTopic = !title && body.autoTopic === true
        if (!title && !autoTopic) return json(res, 400, { error: 'พิมพ์หัวข้อก่อน' }), true
        const config = loadConfig()
        const language = ['th', 'en'].includes(body.language) ? body.language : config.script.language
        const titleLanguage = ['th', 'en'].includes(body.titleLanguage) ? body.titleLanguage : (config.script.titleLanguage ?? language)
        const minutes = Number(body.minutes) > 0 ? Number(body.minutes) : config.script.targetMinutes
        const genre = GENRES.includes(body.genre) ? body.genre : 'mix'
        const slug = autoTopic ? null : slugify(title)
        const started = runner.start('autopilot', slug, { title, autoTopic, genre, language, titleLanguage, minutes })
        // ขั้นเสียงพากย์อ่านภาษา/ความยาวเป้าหมายจาก config — ให้ตรงกับที่เลือกในแผงข้าง
        updateConfig((c) => {
          Object.assign(c.script, { language, titleLanguage, targetMinutes: minutes })
        })
        // หัวข้อนี้กลายเป็น project ที่เลือก — ส่วนอื่นของแผงข้าง (คลังวิดีโอ เปิด project) เห็นงานเดียวกัน
        if (title) {
          mkdirSync(join(ROOT, 'projects'), { recursive: true })
          writeFileSync(SELECTED_FILE, JSON.stringify({ n: 1, title, selectedAt: new Date().toISOString() }, null, 2))
        }
        return json(res, 200, { slug, run: started }), true
      }

      // หัวข้อพร้อมคะแนนที่ autopilot ใช้เลือก (ดูย้อนหลังได้)
      if (req.method === 'GET' && path === '/api/topics/scored') {
        const slug = url.searchParams.get('slug')
        const file = slug ? join(ROOT, 'projects', slug, '01_script', 'topics_scored.json') : null
        return json(res, 200, file && existsSync(file) ? readJson(file, null) : { candidates: [] }), true
      }

      if (req.method === 'GET' && path === '/api/autopilot') {
        const run = runner.snapshot()
        const last = readJson(join(ROOT, 'projects', '_autopilot_last.json'), null)
        const autopilotRun = run?.step === 'autopilot' ? run : null
        // ช่วงแผนกคิดหัวข้อ run ยังไม่มี slug — ห้ามตกไปใช้คลิปก่อนหน้า ไม่งั้นแผงจะเห็นสถานะเก่าแล้วเลิกติดตามงานที่กำลังทำ
        const choosingTopic = autopilotRun?.status === 'running' && !autopilotRun.slug
        const slug = url.searchParams.get('slug') || autopilotRun?.slug || (choosingTopic ? null : last?.slug || selectedSlug())
        const file = slug ? join(ROOT, 'projects', slug, 'autopilot.json') : null
        const status = file && existsSync(file) ? readJson(file, null) : null
        const active = !!autopilotRun && (autopilotRun.slug === slug || choosingTopic)
        // โปรแกรมถูกปิดกลางคัน → ไฟล์ยังเขียนว่า running
        if (status?.status === 'running' && !(active && run.status === 'running')) status.status = active && run.status === 'stopped' ? 'stopped' : 'failed'
        return json(res, 200, { slug, status, run: active ? run : null, last: last?.slug === slug ? last : null, progress: status ? autopilotProgress(status) : null }), true
      }

      // เสียงต้นแบบสำหรับ voice clone + ข้อความที่พูดในไฟล์นั้น
      if (req.method === 'POST' && path === '/api/voice') {
        const { base64, referenceText } = await readBody(req)
        const config = loadConfig()
        if (base64) {
          const dest = join(ROOT, config.tts.referenceVoice)
          mkdirSync(join(dest, '..'), { recursive: true })
          writeFileSync(dest, Buffer.from(base64, 'base64'))
        }
        if (typeof referenceText === 'string') {
          updateConfig((c) => {
            c.tts.referenceText = referenceText.trim()
          })
        }
        return json(res, 200, { setup: setupStatus(loadConfig()) }), true
      }

      // เสียงของเรา (Copy My Voice) — อารมณ์และความเร็วที่เลือกในแผงข้าง
      // ── ตัวละครของฉัน (วางรูปด้วย Ctrl+V ในแผงข้าง) — ไม่มี = ใช้ตัวละครตาม Blueprint ──
      if (path === '/api/character' || path.startsWith('/api/character/')) {
        const view = (c) => ({
          ...c,
          active: !!activeCharacter(),
          previews: c.images.map((name) => ({ name, dataUrl: `data:image/${name.endsWith('.png') ? 'png' : name.endsWith('.webp') ? 'webp' : 'jpeg'};base64,${readFileSync(join(CHARACTER_DIR, name)).toString('base64')}` })),
        })
        if (req.method === 'GET' && path === '/api/character') {
          if (url.searchParams.has('attachments')) return json(res, 200, { attachments: characterAttachments() }), true
          return json(res, 200, view(readCharacter())), true
        }
        if (req.method === 'POST' && path === '/api/character') return json(res, 200, view(updateCharacter(await readBody(req)))), true
        if (req.method === 'POST' && path === '/api/character/image') return json(res, 200, view(addCharacterImage(await readBody(req)))), true
        if (req.method === 'POST' && path === '/api/character/image/delete') {
          const { name } = await readBody(req)
          return json(res, 200, view(removeCharacterImage(String(name)))), true
        }
        if (req.method === 'POST' && path === '/api/character/clear') return json(res, 200, view(clearCharacter())), true
      }

      // ── ตั้งค่าคลิป: แนวภาพ · ซับไตเติล · ช่วงเงียบระหว่างประโยค ──
      if (path === '/api/clip-settings') {
        if (req.method === 'POST') {
          const body = await readBody(req)
          updateConfig((c) => {
            if (['landscape', 'portrait'].includes(body.orientation)) c.render.orientation = body.orientation
            if (MOTION_PRESETS[body.motion]) c.render.motion = body.motion
            if (SUBTITLE_STYLES[body.subtitles]) c.render.subtitles = { ...(c.render.subtitles ?? {}), style: body.subtitles }
            if (PAUSE_PRESETS[body.pause]) {
              const { segmentGapMs, paragraphGapMs } = PAUSE_PRESETS[body.pause]
              Object.assign(c.tts, { pause: body.pause, segmentGapMs, paragraphGapMs })
            }
          })
        }
        const c = loadConfig()
        return json(res, 200, {
          orientation: c.render.orientation === 'portrait' ? 'portrait' : 'landscape',
          subtitles: SUBTITLE_STYLES[c.render.subtitles?.style] ? c.render.subtitles.style : 'off',
          pause: PAUSE_PRESETS[c.tts.pause] ? c.tts.pause : 'normal',
          motion: MOTION_PRESETS[c.render.motion] ? c.render.motion : 'off',
          options: {
            motion: Object.entries(MOTION_PRESETS).map(([id, m]) => ({ id, label: m.label })),
            subtitles: Object.entries(SUBTITLE_STYLES).map(([id, s]) => ({ id, label: s.label })),
            pause: Object.entries(PAUSE_PRESETS).map(([id, p]) => ({ id, label: p.label })),
          },
        }), true
      }

      if (req.method === 'POST' && path === '/api/myvoice') {
        const { emotion, speed } = await readBody(req)
        if (emotion !== undefined && !['calm', 'excited', 'serious', 'soft'].includes(emotion)) {
          return json(res, 400, { error: 'อารมณ์ต้องเป็น calm, excited, serious หรือ soft' }), true
        }
        // อารมณ์/ความเร็วใช้กับทุกเสียง (Edge ใช้แค่ความเร็ว) — ไม่เปลี่ยน engine ที่เลือกไว้
        updateConfig((c) => {
          if (emotion) c.tts.myVoice.emotion = emotion
          if (speed !== undefined) c.tts.myVoice.speed = Math.min(1.5, Math.max(0.7, Number(speed) || 1))
        })
        return json(res, 200, { setup: setupStatus(loadConfig()) }), true
      }

      if (req.method === 'POST' && path === '/api/bgm') {
        const slug = selectedSlug()
        if (!slug) return json(res, 400, { error: 'ยังไม่ได้เลือกหัวข้อ' }), true
        const { base64, name, remove } = await readBody(req)
        const old = bgmFile(slug)
        if (old) unlinkSync(old)
        if (!remove) {
          const ext = extname(String(name ?? '')).slice(1).toLowerCase()
          if (!BGM_EXT.includes(ext)) return json(res, 400, { error: `รองรับเฉพาะ ${BGM_EXT.join(', ')}` }), true
          mkdirSync(join(ROOT, 'projects', slug), { recursive: true })
          writeFileSync(join(ROOT, 'projects', slug, `bgm.${ext}`), Buffer.from(base64, 'base64'))
        }
        return json(res, 200, { ok: true }), true
      }

      if (req.method === 'POST' && path === '/api/topics') {
        const { titleLanguage, genre } = await readBody(req)
        const config = loadConfig()
        if (GENRES.includes(genre)) config.script.genre = genre
        if (titleLanguage) {
          if (!['th', 'en'].includes(titleLanguage)) return json(res, 400, { error: 'ภาษาต้องเป็น th หรือ en' }), true
          config.script.titleLanguage = titleLanguage
        }
        const job = enqueue('chatgpt', 'prompt', {
          prompt: topicsPrompt(config),
          newChat: true,
          outDir: join(ROOT, 'projects'),
          uiStage: 'topics',
        })
        return json(res, 200, { id: job.id }), true
      }

      if (req.method === 'GET' && path === '/api/topics') {
        const result = jobResult(url.searchParams.get('id'), 'topics', finishTopics)
        if (!result) return json(res, 404, { error: 'ไม่พบงานนี้' }), true
        return json(res, 200, result), true
      }

      // STAGE 2 — ใช้ scriptPrompt ตัวเดียวกับ CLI: Blueprint ทั้งฉบับ + กฎ OUTPUT 2
      if (req.method === 'POST' && path === '/api/script') {
        const selected = readJson(SELECTED_FILE, null)
        if (!selected) return json(res, 400, { error: 'ยังไม่ได้เลือกหัวข้อ' }), true
        const { language, minutes } = await readBody(req)
        const config = loadConfig()
        if (language) {
          if (!['th', 'en'].includes(language)) return json(res, 400, { error: 'ภาษาต้องเป็น th หรือ en' }), true
          config.script.language = language
        }
        if (minutes !== undefined) {
          const m = Number(minutes)
          if (!(m >= 1 && m <= 60)) return json(res, 400, { error: 'ความยาวต้องอยู่ระหว่าง 1-60 นาที' }), true
          config.script.targetMinutes = m
        }
        const job = enqueue('chatgpt', 'prompt', {
          prompt: scriptPrompt(config, selected.title),
          newChat: true,
          outDir: join(ROOT, 'projects'),
          uiStage: 'script',
          uiScript: { title: selected.title, config },
        })
        return json(res, 200, { id: job.id }), true
      }

      if (req.method === 'GET' && path === '/api/script') {
        const result = jobResult(url.searchParams.get('id'), 'script', finishScript)
        if (!result) return json(res, 404, { error: 'ไม่พบงานนี้' }), true
        return json(res, 200, result), true
      }

      if (req.method === 'POST' && path === '/api/cancel') {
        const job = jobs.get((await readBody(req)).id)
        // ยกเลิกได้แค่งานที่ยังไม่ถูกหยิบ — งานที่ ChatGPT กำลังพิมพ์อยู่หยุดจากฝั่งนี้ไม่ได้
        if (job && job.status === 'queued') {
          job.status = 'error'
          job.error = 'ยกเลิกแล้ว'
        }
        return json(res, 200, { ok: true, status: job?.status ?? null }), true
      }

      if (req.method === 'POST' && path === '/api/select') {
        const { n } = await readBody(req)
        const topic = readJson(TOPICS_FILE, []).find((t) => t.n === Number(n))
        if (!topic) return json(res, 400, { error: `ไม่มีหัวข้อเลข ${n}` }), true
        const selected = { n: topic.n, title: topic.title, selectedAt: new Date().toISOString() }
        mkdirSync(join(ROOT, 'projects'), { recursive: true })
        writeFileSync(SELECTED_FILE, JSON.stringify(selected, null, 2))
        return json(res, 200, state()), true
      }

      return json(res, 404, { error: 'ไม่มี endpoint นี้' }), true
    } catch (err) {
      return json(res, 500, { error: String(err.message) }), true
    }
  }

  return { handle }
}
