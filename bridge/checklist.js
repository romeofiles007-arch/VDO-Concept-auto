/**
 * หน้า "ตรวจความพร้อม" — เครื่องนี้ขาดอะไร ต้องลงอะไร ที่ไหน
 *
 * ฝั่งนี้ตรวจของในเครื่อง (ffmpeg, ระบบเสียง, การ์ดจอ, โมเดล, พื้นที่ดิสก์)
 * ส่วนที่ต้องดูจากเบราว์เซอร์ (ล็อกอิน ChatGPT / Flow) แผงข้างตรวจเอง
 *
 * แต่ละข้อ: { id, group, label, status: ok|missing|warn|info, need: required|optional, detail, fix? }
 *   fix: { text, url?, command?, action? } — action = ปุ่มที่แผงข้างกดแทนผู้ใช้ได้ (เช่น setupTts)
 */
import { execFile } from 'node:child_process'
import { existsSync, statfsSync, accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ROOT, loadConfig, ttsPython } from '../pipeline/lib/config.mjs'
import { selectedVoice } from '../pipeline/lib/voices.mjs'
import { edgePython } from '../pipeline/lib/cloud_tts.mjs'
import { hasKey } from '../pipeline/lib/env.mjs'

const HF = join(homedir(), '.cache', 'huggingface', 'hub')
const SETUP_CMD = 'powershell -ExecutionPolicy Bypass -File scripts\\setup-tts.ps1'

/** รันคำสั่งแบบไม่บล็อก bridge — คืนข้อความบรรทัดแรก หรือ null ถ้าไม่มี/พัง */
function probe(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, cwd: ROOT }, (err, stdout, stderr) => {
      if (err) return resolve(null)
      resolve(String(stdout || stderr).trim().split(/\r?\n/)[0])
    })
  })
}

const sitePackage = (name) => existsSync(join(ROOT, 'tts', '.venv', 'Lib', 'site-packages', name))
const hfModel = (repo) => existsSync(join(HF, `models--${repo.replace('/', '--')}`, 'snapshots'))

export async function checklist({ connected } = {}) {
  const config = loadConfig()
  const items = []
  const add = (item) => items.push(item)

  const [ffmpeg, ffprobe, gpu, py310] = await Promise.all([
    probe('ffmpeg', ['-version']),
    probe('ffprobe', ['-version']),
    probe('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']),
    probe('py', ['-3.10', '--version']),
  ])

  // ── พื้นฐาน ──
  const nodeMajor = Number(process.versions.node.split('.')[0])
  add({
    id: 'node', group: 'พื้นฐาน', label: 'Node.js 20 ขึ้นไป', need: 'required',
    status: nodeMajor >= 20 ? 'ok' : 'missing',
    detail: `ตอนนี้ ${process.version}`,
    fix: nodeMajor >= 20 ? null : { text: 'ลงเวอร์ชัน LTS ใหม่ แล้วดับเบิลคลิก ติดตั้งครั้งแรก.bat อีกครั้ง', url: 'https://nodejs.org/' },
  })
  add({
    id: 'ffmpeg', group: 'พื้นฐาน', label: 'ffmpeg (ตัดต่อวิดีโอ แปลงเสียง)', need: 'required',
    status: ffmpeg && ffprobe ? 'ok' : 'missing',
    detail: ffmpeg ? ffmpeg.replace(/ Copyright.*/, '') : 'ไม่พบคำสั่ง ffmpeg / ffprobe ในเครื่อง',
    fix: ffmpeg && ffprobe ? null : { text: 'เปิด PowerShell แล้วรันคำสั่งนี้ จากนั้นปิดเปิด Chrome', command: 'winget install Gyan.FFmpeg', url: 'https://www.gyan.dev/ffmpeg/builds/' },
  })
  const blueprint = join(ROOT, config.blueprint)
  add({
    id: 'blueprint', group: 'พื้นฐาน', label: 'ไฟล์ Blueprint', need: 'required',
    status: existsSync(blueprint) ? 'ok' : 'missing',
    detail: config.blueprint,
    fix: existsSync(blueprint) ? null : { text: `วางไฟล์ Blueprint (VDO Concept.txt) ไว้ที่ ${config.blueprint}` },
  })
  let freeGb = null
  try {
    const s = statfsSync(ROOT)
    freeGb = (s.bavail * s.bsize) / 1024 ** 3
  } catch {}
  let writable = true
  try {
    accessSync(join(ROOT, 'projects'), constants.W_OK)
  } catch {
    writable = !existsSync(join(ROOT, 'projects'))
  }
  add({
    id: 'disk', group: 'พื้นฐาน', label: 'พื้นที่ว่างในไดรฟ์โปรเจกต์', need: 'required',
    status: !writable ? 'missing' : freeGb == null ? 'info' : freeGb < 5 ? 'missing' : freeGb < 15 ? 'warn' : 'ok',
    detail: `${freeGb == null ? 'อ่านไม่ได้' : `ว่าง ${freeGb.toFixed(0)} GB`} · คลิปละ ~0.3–1 GB · ระบบเสียงใช้ ~8 GB${writable ? '' : ' · เขียนโฟลเดอร์ projects ไม่ได้'}`,
    fix: freeGb != null && freeGb < 15 ? { text: 'ลบคลิปเก่าในคลังวิดีโอ หรือล้างโฟลเดอร์ projects/_trash' } : null,
  })

  // ── extension ต่อกับโปรแกรมในเครื่อง ──
  for (const [agent, label] of [['chatgpt', 'ChatGPT'], ['flow', 'Google Flow']]) {
    const on = connected?.(agent)
    add({
      id: `poll-${agent}`, group: 'Extension', label: `Extension รับงาน ${label} จากโปรแกรมในเครื่อง`, need: 'required',
      status: on ? 'ok' : 'warn',
      detail: on ? 'ต่ออยู่' : 'ยังไม่เห็น extension มารับงานใน 1 นาทีที่ผ่านมา',
      fix: on ? null : { text: 'เปิด chrome://extensions แล้วกดรีโหลด Cartoon Auto Bridge · ถ้ายังไม่ขึ้น ปิดเปิด Chrome' },
    })
  }

  // ── เสียงพากย์ ──
  const venv = existsSync(ttsPython(config))
  const packages = [['f5_tts_th', 'F5-TTS-THAI'], ['faster_whisper', 'Whisper'], ['edge_tts', 'Edge TTS'], ['torch', 'PyTorch']]
  const lacking = packages.filter(([dir]) => !sitePackage(dir)).map(([, name]) => name)
  add({
    id: 'tts', group: 'เสียงพากย์', label: 'ระบบเสียงในเครื่อง (tts\\.venv)', need: config.tts.engine === 'gemini' ? 'optional' : 'required',
    status: venv && !lacking.length ? 'ok' : 'missing',
    detail: !venv ? 'ยังไม่ได้ติดตั้ง — ใช้สร้างเสียงไทย เทรนเสียง ถอดเสียง และเสียง Edge' : lacking.length ? `ยังขาด ${lacking.join(', ')}` : 'F5-TTS-THAI · Whisper · Edge TTS พร้อม',
    fix: venv && !lacking.length ? null : { text: 'กดปุ่มนี้เพื่อติดตั้ง (ดาวน์โหลด ~5 GB ใช้เวลา 10–30 นาที) หรือรันคำสั่งในโฟลเดอร์โปรเจกต์', command: SETUP_CMD, action: 'setupTts' },
  })
  if (!venv || lacking.includes('F5-TTS-THAI')) {
    add({
      id: 'python', group: 'เสียงพากย์', label: 'Python 3.10 (ใช้ตอนติดตั้งระบบเสียง)', need: 'required',
      status: py310 ? 'ok' : 'missing',
      detail: py310 ?? 'ไม่พบ py -3.10',
      fix: py310 ? null : { text: 'ดาวน์โหลด Windows installer (64-bit) ติ๊ก "py launcher" แล้วติดตั้ง', url: 'https://www.python.org/downloads/release/python-31011/' },
    })
  }
  add({
    id: 'gpu', group: 'เสียงพากย์', label: 'การ์ดจอ NVIDIA', need: 'optional',
    status: gpu ? 'ok' : 'warn',
    detail: gpu ?? 'ไม่พบ — เสียงของเราเอง/เทรนเสียง/ถอดเสียงจะช้ามาก · เสียง Edge ใช้ได้ปกติ',
    fix: gpu ? null : { text: 'ลงไดรเวอร์ NVIDIA ล่าสุด (ถ้ามีการ์ด) หรือเลือกเสียง Edge ในขั้นที่ 3', url: 'https://www.nvidia.com/Download/index.aspx' },
  })

  const engine = config.tts.engine
  let voiceOk = false
  let voiceDetail = ''
  let voiceFix = null
  if (engine === 'edge') {
    voiceOk = existsSync(edgePython())
    voiceDetail = `Edge · ${config.tts.edge?.voice}`
    voiceFix = voiceOk ? null : { text: 'ติดตั้งระบบเสียงในเครื่อง (มี Edge TTS รวมอยู่)', action: 'setupTts', command: SETUP_CMD }
  } else if (engine === 'gemini') {
    voiceOk = hasKey('GEMINI_API_KEY')
    voiceDetail = `Gemini · ${config.tts.gemini?.voice}${voiceOk ? '' : ' · ยังไม่มี API key'}`
    voiceFix = voiceOk ? null : { text: 'สร้าง key ฟรี แล้วใส่ในขั้นที่ 3 ของแผงข้าง', url: 'https://aistudio.google.com/apikey' }
  } else {
    const v = selectedVoice(config)
    voiceOk = !!v && venv
    voiceDetail = v ? `เสียงของเรา · ${v.label}` : `เสียง "${config.tts.myVoice?.voice}" ยังไม่มีในเครื่องหรือยังไม่เทรน`
    voiceFix = voiceOk ? null : { text: 'เลือกเสียง Edge ในขั้นที่ 3 หรืออัปโหลดไฟล์เสียงแล้วเทรนเสียงของตัวเอง' }
  }
  add({ id: 'voice', group: 'เสียงพากย์', label: 'เสียงพากย์ที่เลือกใช้', need: 'required', status: voiceOk ? 'ok' : 'missing', detail: voiceDetail, fix: voiceFix })

  const models = [
    ['charactr/vocos-mel-24khz', 'Vocoder ของ F5-TTS', '~50 MB', 'ครั้งแรกที่สร้างเสียงของเรา'],
    ['Systran/faster-whisper-large-v3', 'Whisper large-v3 (ถอดเสียง)', '~3 GB', 'ครั้งแรกที่นำเข้าเสียงหรือเทรนเสียง'],
    ['VIZINTZOR/F5-TTS-THAI', 'โมเดลตั้งต้นภาษาไทย (เทรนเสียง)', '~1.3 GB', 'ครั้งแรกที่เทรนเสียง'],
  ]
  for (const [repo, label, size, when] of models) {
    const have = hfModel(repo)
    add({
      id: `model-${repo}`, group: 'โมเดล (ดาวน์โหลดเองอัตโนมัติ)', label, need: 'optional',
      status: have ? 'ok' : 'info',
      detail: have ? 'ดาวน์โหลดไว้แล้ว' : `ยังไม่มี — ระบบดาวน์โหลดเอง ${size} ${when}`,
      fix: null,
    })
  }

  // ── เสียงเสริม ──
  add({
    id: 'gemini', group: 'ตัวเลือกเสริม', label: 'Gemini API key (เสียง Gemini)', need: 'optional',
    status: hasKey('GEMINI_API_KEY') ? 'ok' : 'info',
    detail: hasKey('GEMINI_API_KEY') ? 'ใส่ไว้แล้ว' : 'ไม่จำเป็น — ใช้เมื่ออยากได้เสียง Gemini เท่านั้น',
    fix: hasKey('GEMINI_API_KEY') ? null : { text: 'สร้าง key ฟรี แล้วใส่ในขั้นที่ 3', url: 'https://aistudio.google.com/apikey' },
  })

  return { items, checkedAt: Date.now() }
}
