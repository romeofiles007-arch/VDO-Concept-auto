#!/usr/bin/env node
/**
 * ทำคลิปอัตโนมัติ — พิมพ์หัวข้อ กดครั้งเดียว ได้ MP4
 *
 * ทำงานเป็นแผนก ส่งต่องานกันตามลำดับ แต่ละแผนกตรวจงานตัวเองและลองใหม่เมื่อพลาด:
 *   1. เขียนบท      ChatGPT (extension) เขียน VO script ตาม Blueprint
 *   2. เสียงพากย์    เสียงที่เลือกไว้ (เสียงเราเอง / Edge / Gemini) + timecode
 *   3. กำกับภาพ     ChatGPT เขียน Style/Character Bible + prompt ภาพทีละรอบจนครบทุกช็อต
 *   4. วาดภาพ       Google Flow Agent (0 credits) สร้างเฉพาะช็อตที่ยังขาดจนครบ
 *   5. ตัดต่อ        รวมภาพ + เสียงเป็น MP4
 *
 * สั่งซ้ำด้วยหัวข้อเดิม = ทำต่อจากแผนกที่ค้าง (งานที่เสร็จแล้วไม่ทำซ้ำ)
 * สถานะเขียนที่ projects/<slug>/autopilot.json ให้แผงข้างอ่าน
 *
 *   node pipeline/autopilot.mjs "<หัวข้อ>" [--lang th|en] [--title-lang th|en] [--minutes 5]
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, renameSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, projectDir, slugify, ROOT } from './lib/config.mjs'
import { requireBridge, runJob } from './lib/bridge.mjs'
import { scriptPrompt, scoredTopicsPrompt, parseScoredTopics } from './lib/prompts.mjs'
import { saveScript, loadScript } from './lib/stage2.mjs'
import { shotlistFiles, readRounds, resetRounds, mergeRounds, saveRound, nextRoundPrompt } from './lib/shotlist.mjs'
import { collectImages } from './lib/shotfile.mjs'
import { characterAttachments } from './lib/character.mjs'
import { hasCover } from './lib/cover.mjs'

// ── อาร์กิวเมนต์ ──
const raw = process.argv.slice(2)
const config = loadConfig()
const words = []
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === '--lang') config.script.language = raw[++i]
  else if (raw[i] === '--title-lang') config.script.titleLanguage = raw[++i]
  else if (raw[i] === '--minutes') config.script.targetMinutes = Number(raw[++i])
  else if (raw[i] === '--genre') config.script.genre = raw[++i]
  else words.push(raw[i])
}
const autoTopic = words.includes('--auto-topic')
let title = words.filter((w) => w !== '--auto-topic').join(' ').trim()
if (!title && !autoTopic) {
  console.error('ใช้: node pipeline/autopilot.mjs "<หัวข้อ>" | --auto-topic [--genre mix|<แนว>] [--lang th|en] [--minutes 5]')
  process.exit(1)
}

// ── แผนกคิดหัวข้อ (เฉพาะ --auto-topic): ChatGPT เสนอ 5 หัวข้อพร้อมคะแนน → เลือกคะแนนสูงสุดที่ยังไม่เคยทำ ──
let topicPick = null
if (autoTopic) {
  const { listDoneTitles } = await import('./lib/topics.mjs')
  const done = listDoneTitles()
  console.log('▶ แผนกคิดหัวข้อ')
  console.log(`   แนว: ${!config.script.genre || config.script.genre === 'mix' ? 'สุ่มหลากหลายแนว' : config.script.genre}`)
  console.log('   ChatGPT กำลังเสนอหัวข้อและให้คะแนน…')
  await requireBridge()
  let topics = []
  for (let attempt = 1; attempt <= 3 && !topics.length; attempt++) {
    const result = await runJob({
      agent: 'chatgpt', kind: 'prompt', label: 'คิดหัวข้อ + ให้คะแนน',
      payload: { prompt: scoredTopicsPrompt(config, { avoid: done }), newChat: true }, timeoutMs: 20 * 60_000,
    }).catch((err) => ({ error: err }))
    const doneSlugs = new Set(done.map(slugify))
    topics = parseScoredTopics(result?.text ?? '').filter((t) => !doneSlugs.has(slugify(t.title)))
    if (!topics.length) {
      console.warn(`   อ่านตารางหัวข้อไม่ได้${result?.error ? ` (${result.error.message})` : ''} — ลองใหม่ (${attempt}/3)`)
      if (attempt < 3) await new Promise((r) => setTimeout(r, 20_000))
    }
  }
  if (!topics.length) {
    console.error('\n❌ หยุดที่แผนกคิดหัวข้อ — ChatGPT ไม่ได้ส่งตารางหัวข้อที่อ่านได้')
    process.exit(2)
  }
  for (const t of topics) console.log(`   ${String(t.score).padStart(3)} คะแนน · ${t.title}${t.why ? ` — ${t.why}` : ''}`)
  topicPick = { chosen: topics[0], candidates: topics, at: Date.now() }
  title = topics[0].title
  console.log(`   เลือก: ${title} (${topics[0].score} คะแนน)`)
}
const slug = slugify(title)
if (autoTopic) {
  // บอกโปรแกรมในเครื่องว่าคลิปนี้ชื่ออะไร (runner อ่านบรรทัดนี้แล้วไม่แสดง)
  console.log(`@@autopilot ${JSON.stringify({ slug, title })}`)
  writeFileSync(join(projectDir(slug, 'script'), 'topics_scored.json'), JSON.stringify(topicPick, null, 2))
}

// ── สถานะของแต่ละแผนก ──
const DEPARTMENTS = [
  { id: 'script', label: 'แผนกเขียนบท' },
  { id: 'voice', label: 'แผนกเสียงพากย์' },
  { id: 'art', label: 'แผนกกำกับภาพ' },
  { id: 'images', label: 'แผนกวาดภาพ' },
  { id: 'edit', label: 'แผนกตัดต่อ' },
]
const stateFile = join(projectDir(slug), 'autopilot.json')
writeFileSync(join(ROOT, 'projects', '_autopilot_last.json'), JSON.stringify({ slug, title, language: config.script.language, minutes: config.script.targetMinutes, at: Date.now() }, null, 2))
const previous = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
const state = {
  title,
  slug,
  status: 'running',
  startedAt: Date.now(),
  updatedAt: Date.now(),
  current: null,
  error: null,
  video: null,
  departments: Object.fromEntries(DEPARTMENTS.map((d) => [d.id, { status: 'waiting', detail: '', attempts: 0 }])),
  runs: (previous?.runs ?? 0) + 1,
  topic: topicPick ? { score: topicPick.chosen.score, why: topicPick.chosen.why, candidates: topicPick.candidates.length } : previous?.topic ?? null,
}
function save() {
  state.updatedAt = Date.now()
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
}
function dept(id, changes) {
  const d = state.departments[id]
  // เริ่มทำแผนกนี้ → จับเวลา (ใช้ประมาณเวลาที่เหลือ)
  if (changes.status === 'working' && d.status !== 'working') changes = { startedAt: Date.now(), ...changes }
  if (changes.status === 'done' && d.progress?.total) changes = { progress: { ...d.progress, done: d.progress.total }, ...changes }
  Object.assign(d, changes)
  if (changes.detail) console.log(`   ${changes.detail}`)
  save()
}

/** ตัวเลขความคืบหน้า (n/N) ของแผนก — เขียนไฟล์ไม่ถี่เกินทุก 1.5 วิ */
let lastProgressSave = 0
function progress(id, done, total) {
  const d = state.departments[id]
  if (!total || (d.progress?.done === done && d.progress?.total === total)) return
  d.progress = { done: Math.min(done, total), total }
  if (Date.now() - lastProgressSave > 1500) {
    lastProgressSave = Date.now()
    save()
  }
}
save()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mtime = (f) => (existsSync(f) ? statSync(f).mtimeMs : 0)

/** รันสคริปต์ขั้นเดิมของ pipeline — ส่ง log ต่อให้แผงข้างเห็น */
function step(script, args, { onText } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [join(ROOT, 'pipeline', script), ...args], { cwd: ROOT, windowsHide: true })
    let tail = ''
    const pass = (stream) => (d) => {
      stream.write(d)
      const text = d.toString('utf8')
      tail = (tail + text).slice(-1500)
      onText?.(text)
    }
    proc.stdout.on('data', pass(process.stdout))
    proc.stderr.on('data', pass(process.stderr))
    proc.on('close', (code) => resolve({ ok: code === 0, code, tail }))
  })
}

const lastLine = (text) => String(text).trim().split(/\r?\n/).filter(Boolean).pop() ?? ''

/** ถาม ChatGPT ผ่านคิวของ bridge — ลองใหม่เมื่อหน้าเว็บค้างหรือ ChatGPT ตอบไม่ได้ */
async function askChatGPT(prompt, label, { tries = 3, attachments } = {}) {
  let lastError
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const result = await runJob({ agent: 'chatgpt', kind: 'prompt', payload: { prompt, newChat: true, ...(attachments?.length && { attachments }) }, timeoutMs: 40 * 60_000, label })
      if (result?.text?.trim()) return result.text
      lastError = new Error('ChatGPT ตอบกลับว่าง')
    } catch (err) {
      lastError = err
    }
    if (attempt < tries) {
      console.warn(`   ${label}: ${lastError.message} — ลองใหม่ใน 30 วิ (${attempt}/${tries})`)
      await sleep(30_000)
    }
  }
  throw lastError
}

/** บทที่ใช้ไม่ได้ → เปลี่ยนชื่อเก็บไว้ (ไม่ลบ) ให้รอบหน้าเขียนใหม่ */
function setAsideScript(file) {
  if (existsSync(file)) renameSync(file, file.replace(/\.txt$/, `_offtarget_${Date.now()}.txt`))
}

// ── แผนก 1: เขียนบท ──
async function scriptDepartment() {
  const existing = loadScript(config, title)
  // บทเดิมยาวผิดเป้าหลายเท่า (เช่นค้างจากรอบที่ ChatGPT เขียนเกิน) → เขียนใหม่ ไม่ใช้ต่อ
  const existingRatio = existing ? existing.minutes / existing.target : 1
  if (existing && existingRatio <= 2 && existingRatio >= 0.5) return dept('script', { status: 'done', detail: `ใช้บทเดิม (~${existing.minutes.toFixed(1)} นาที)` })
  if (existing) {
    console.warn(`   บทเดิมยาว ${existing.minutes.toFixed(1)} นาที ห่างจากเป้า ${existing.target} นาทีหลายเท่า — เขียนใหม่`)
    setAsideScript(existing.file)
  }
  let feedback = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    dept('script', { status: 'working', attempts: attempt, expectSec: 150 + config.script.targetMinutes * 20, detail: `ChatGPT กำลังเขียนบท (${config.script.targetMinutes} นาที)` })
    const text = await askChatGPT(scriptPrompt(config, title) + feedback, `เขียนบท "${title}"`)
    const saved = saveScript(config, title, text)
    const ratio = saved.minutes / saved.target
    // บทสั้น/ยาวผิดเป้าเล็กน้อย รอบสุดท้ายยอมรับ · ผิดเป้าหลายเท่า (เช่น เป้า 1 นาทีได้ 13 นาที) ห้ามไปต่อ — เสียเวลาทำเสียงและภาพเป็นร้อยช็อต
    if (!saved.offTarget || (attempt === 3 && ratio <= 2 && ratio >= 0.5)) {
      return dept('script', { status: 'done', detail: `ได้บท ~${saved.minutes.toFixed(1)} นาที (เป้า ${saved.target})` })
    }
    if (attempt === 3) {
      setAsideScript(saved.file)
      throw new Error(`ChatGPT เขียนบทยาว ${saved.minutes.toFixed(1)} นาที ห่างจากเป้า ${saved.target} นาทีเกินไป 3 รอบ — ลองกดทำคลิปอัตโนมัติอีกครั้ง หรือเพิ่มความยาวเป้าหมาย`)
    }
    const words = Math.round(saved.target * config.script.wordsPerMinute)
    feedback = `\n\n⚠️ รอบก่อนบทยาวประมาณ ${saved.minutes.toFixed(1)} นาที แต่เป้าคือ ${saved.target} นาที — เขียนใหม่ให้${ratio > 1 ? 'สั้นลง' : 'ยาวขึ้น'} รวมประมาณ ${words} ${config.script.language === 'th' ? 'คำ' : 'words'} (${Math.round(saved.target * 60)} วินาที) เท่านั้น`
    console.warn(`   บทยาว ${saved.minutes.toFixed(1)} นาที ห่างจากเป้า ${saved.target} นาทีเกินไป — ขอเขียนใหม่`)
  }
}

/** ภาพของเสียงชุดเก่าชื่อ timecode ตรงกันได้แต่เนื้อหาไม่ตรง → ย้ายเก็บไว้ ไม่ลบ */
function archiveOldImages() {
  const dir = projectDir(slug, 'images')
  const old = collectImages(dir).images
  if (!old.length) return
  const dest = join(dir, `_old_${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(dest, { recursive: true })
  for (const img of old) renameSync(img.file, join(dest, img.name))
  console.log(`   ย้ายภาพของเสียงชุดเก่า ${old.length} ใบไปไว้ที่ ${dest}`)
}

// ── แผนก 2: เสียงพากย์ (+ timecode) ──
async function voiceDepartment() {
  const scriptFile = join(projectDir(slug, 'script'), `script_${slug}.txt`)
  const voiceover = join(projectDir(slug, 'audio'), 'voiceover.wav')
  const slots = shotlistFiles(slug).slots
  if (mtime(voiceover) > mtime(scriptFile) && existsSync(slots)) {
    return dept('voice', { status: 'done', detail: 'ใช้เสียงพากย์เดิม' })
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    dept('voice', { status: 'working', attempts: attempt, detail: `สร้างเสียงพากย์ (${config.tts.engine})` })
    const run = await step('2_tts.mjs', [slug], {
      onText: (t) => {
        const m = [...t.matchAll(/(\d+)\/(\d+) segments/g)].pop()
        if (m) progress('voice', Number(m[1]), Number(m[2]))
      },
    })
    if (run.ok && existsSync(voiceover) && existsSync(slots)) {
      resetRounds(slug) // เสียงใหม่ = จังหวะช็อตใหม่ → prompt ภาพเก่าใช้ไม่ได้
      archiveOldImages()
      return dept('voice', { status: 'done', detail: 'ได้เสียงพากย์ + timecode' })
    }
    if (attempt === 2) throw new Error(`ทำเสียงพากย์ไม่สำเร็จ: ${lastLine(run.tail)}`)
    await sleep(10_000)
  }
}

// ── แผนก 3: กำกับภาพ (Style/Character Bible + prompt ภาพทุกช็อต) ──
async function artDepartment() {
  const files = shotlistFiles(slug)
  const context = {
    title: readFileSync(join(projectDir(slug, 'script'), 'title.txt'), 'utf8').trim(),
    timecodeText: readFileSync(join(projectDir(slug, 'timecode'), 'timecode.txt'), 'utf8'),
  }
  const slots = JSON.parse(readFileSync(files.slots, 'utf8'))
  let merged = readRounds(slug).length ? mergeRounds(slug) : { total: slots.length, withPrompt: 0 }
  let stalls = 0
  const maxRounds = Math.ceil(slots.length / 40) + 6
  for (let round = 0; round < maxRounds; round++) {
    const next = nextRoundPrompt(config, slug, context)
    if (!next) break
    progress('art', merged.withPrompt, merged.total)
    dept('art', { status: 'working', attempts: round + 1, detail: `รอบ ${next.round}: ขอ prompt ${next.batch} ช็อต (มีแล้ว ${merged.withPrompt}/${merged.total})` })
    const text = await askChatGPT(next.prompt, `กำกับภาพ รอบ ${next.round} (${next.batch} ช็อต)`, {
      attachments: next.attachCharacter ? characterAttachments() : undefined,
    })
    const before = merged.withPrompt
    merged = saveRound(slug, text)
    stalls = merged.withPrompt > before ? 0 : stalls + 1
    if (stalls >= 3) throw new Error(`ChatGPT ไม่ให้ prompt ช็อตที่ขาดเพิ่ม 3 รอบติด (ได้ ${merged.withPrompt}/${merged.total})`)
  }
  merged = mergeRounds(slug)
  if (merged.withPrompt < merged.total) throw new Error(`prompt ภาพยังไม่ครบ ${merged.withPrompt}/${merged.total}`)
  if (!merged.hasBible) console.warn('   เตือน: ไม่พบ Style/Character Bible ในคำตอบ — ภาพอาจไม่ต่อเนื่อง')
  dept('art', { status: 'done', detail: `prompt ภาพครบ ${merged.total} ช็อต` })
}

// ── แผนก 4: วาดภาพ (Google Flow) ──
function imageCoverage() {
  const shots = JSON.parse(readFileSync(shotlistFiles(slug).shots, 'utf8'))
  const have = new Set(collectImages(projectDir(slug, 'images')).images.map((i) => i.name))
  return { total: shots.length, have: shots.filter((s) => have.has(s.filename)).length }
}

/**
 * ช็อตที่ Flow สร้างไม่ได้จริงๆ (Failed ซ้ำหลายรอบ) → คัดลอกภาพก่อนหน้า (หรือถัดไปถ้าเป็นช็อตแรก) มาใช้ชื่อนั้น
 * คลิปจึงไม่มีช่องว่าง และบันทึกไว้ใน images/_filled.json เพื่อสั่งสร้างจริงทีหลังได้
 */
function fillMissingImages() {
  const dir = projectDir(slug, 'images')
  const shots = JSON.parse(readFileSync(shotlistFiles(slug).shots, 'utf8'))
  const have = new Set(collectImages(dir).images.map((i) => i.name))
  const filled = []
  for (let i = 0; i < shots.length; i++) {
    if (have.has(shots[i].filename)) continue
    const source = [...shots.slice(0, i).reverse(), ...shots.slice(i + 1)].find((s) => have.has(s.filename))
    if (!source) continue
    copyFileSync(join(dir, source.filename), join(dir, shots[i].filename))
    filled.push(shots[i].filename)
  }
  const log = join(dir, '_filled.json')
  const previous = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : []
  writeFileSync(log, JSON.stringify([...new Set([...previous, ...filled])], null, 2))
  return filled
}

async function imagesDepartment() {
  let cov = imageCoverage()
  let stalls = 0
  for (let attempt = 1; cov.have < cov.total; attempt++) {
    progress('images', cov.have, cov.total)
    dept('images', { status: 'working', attempts: attempt, detail: `Google Flow รอบ ${attempt}: มีภาพ ${cov.have}/${cov.total} — สร้างที่ขาด ${cov.total - cov.have} ช็อต` })
    const base = cov.have
    const run = await step('5_images.mjs', [slug, '--missing'], {
      onText: (t) => {
        // "ได้ภาพ 12/40 ใบ" · "บันทึกภาพ 8/40" — นับภาพของรอบนี้บวกภาพที่มีอยู่แล้ว
        const m = [...t.matchAll(/(?:ได้ภาพ|Flow สร้างภาพ|บันทึกภาพ)\s+(\d+)\/(\d+)/g)].pop()
        if (m) progress('images', base + Number(m[1]), cov.total)
      },
    })
    const before = cov.have
    cov = imageCoverage()
    if (!run.ok) console.warn(`   Flow รอบนี้มีปัญหา: ${lastLine(run.tail)}`)
    stalls = cov.have > before ? 0 : stalls + 1
    if (cov.have >= cov.total) break
    if (stalls >= 3 || attempt >= 12) {
      // ขาดไม่กี่ใบ → ภาพก่อนหน้าค้างแทนได้ ยังได้คลิปที่ดูรู้เรื่อง
      if (cov.have >= cov.total * 0.9) {
        const filled = fillMissingImages()
        console.warn(`   Flow สร้างไม่ได้ ${filled.length} ช็อต — ใช้ภาพข้างเคียงแทน: ${filled.join(', ')}`)
        cov = imageCoverage()
        break
      }
      throw new Error(`Google Flow สร้างภาพไม่เพิ่มหลายรอบติด (ได้ ${cov.have}/${cov.total}) — ${lastLine(run.tail)}`)
    }
    await sleep(stalls ? 60_000 : 5_000) // Flow แจ้ง high demand → เว้นช่วงก่อนสั่งใหม่
  }
  // ภาพปกคลิป: ปกติได้มาพร้อมรอบสร้างภาพ ถ้ายังไม่มีสั่งแค่ปก
  for (let attempt = 1; !hasCover(slug) && attempt <= 2; attempt++) {
    dept('images', { status: 'working', detail: `สร้างภาพปกคลิป (ครั้งที่ ${attempt})` })
    const run = await step('5_images.mjs', [slug, '--cover-only'])
    if (!run.ok) console.warn(`   สร้างปกไม่สำเร็จ: ${lastLine(run.tail)}`)
  }
  if (!hasCover(slug)) console.warn('   ยังไม่ได้ภาพปก — สร้างทีหลังได้จากคลังวิดีโอ')
  dept('images', { status: 'done', detail: `ภาพ ${cov.have}/${cov.total} ใบ${hasCover(slug) ? ' + ปกคลิป' : ' · ยังไม่มีปก'}` })
}

// ── แผนก 5: ตัดต่อ ──
async function editDepartment() {
  const out = join(projectDir(slug, 'render'), `${slug}.mp4`)
  const images = projectDir(slug, 'images')
  const newestImage = Math.max(0, ...collectImages(images).images.map((i) => mtime(i.file)))
  const rendered = existsSync(join(projectDir(slug, 'render'), 'render.json')) ? JSON.parse(readFileSync(join(projectDir(slug, 'render'), 'render.json'), 'utf8')) : null
  const sameSubs = (rendered?.subtitles ?? 'off') === (config.render.subtitles?.style ?? 'off') && (rendered?.motion ?? 'off') === (config.render.motion ?? 'off')
  if (sameSubs && mtime(out) > newestImage && mtime(out) > mtime(join(projectDir(slug, 'audio'), 'voiceover.wav'))) {
    state.video = out
    return dept('edit', { status: 'done', detail: 'ใช้วิดีโอเดิม' })
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    // ตัดต่อไม่มีตัวเลขระหว่างทาง → ประมาณจากความยาวคลิป (4 นาทีใช้ราว 40 วิ)
    const seconds = JSON.parse(readFileSync(join(projectDir(slug, 'timecode'), 'timecode.json'), 'utf8')).totalDuration ?? 240
    dept('edit', { status: 'working', attempts: attempt, expectSec: Math.round(seconds * 0.2 + 20), detail: 'รวมภาพ + เสียงเป็น MP4' })
    const run = await step('6_render.mjs', [slug])
    if (run.ok && existsSync(out)) {
      state.video = out
      return dept('edit', { status: 'done', detail: `ได้วิดีโอ ${(statSync(out).size / 1048576).toFixed(1)} MB` })
    }
    if (attempt === 2) throw new Error(`ตัดต่อไม่สำเร็จ: ${lastLine(run.tail)}`)
  }
}

const WORK = { script: scriptDepartment, voice: voiceDepartment, art: artDepartment, images: imagesDepartment, edit: editDepartment }

console.log(`🎬 ทำคลิปอัตโนมัติ: ${title}`)
console.log(`   ${config.script.language === 'en' ? 'อังกฤษ' : 'ไทย'} · ${config.script.targetMinutes} นาที · เสียง ${config.tts.engine}`)
await requireBridge()

for (const d of DEPARTMENTS) {
  state.current = d.id
  console.log(`\n▶ ${d.label}`)
  dept(d.id, { status: 'working' })
  try {
    await WORK[d.id]()
  } catch (err) {
    dept(d.id, { status: 'failed', detail: err.message })
    state.status = 'failed'
    state.error = `${d.label}: ${err.message}`
    save()
    console.error(`\n❌ หยุดที่${d.label} — ${err.message}`)
    console.error('   กดทำคลิปอัตโนมัติอีกครั้งด้วยหัวข้อเดิม ระบบจะทำต่อจากจุดนี้')
    process.exit(2)
  }
}

state.current = null
state.status = 'done'
save()
console.log(`\n✅ เสร็จแล้ว: ${state.video}`)
