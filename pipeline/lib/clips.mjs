import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { projectDir } from './config.mjs'
import { parseTimecodeFilename } from './shotfile.mjs'

/**
 * คลิปขยับจริงด้วย AI
 *
 * ภาพจาก Flow บางช็อตถูกส่งให้ Kie ทำเป็นวิดีโอสั้น แล้วเก็บเป็น 05_images/clips/<timecode>.mp4
 * ชื่อเดียวกับภาพ (แค่นามสกุล .mp4) → ขั้นตัดต่อใช้คลิปแทนภาพของช็อตนั้น ช็อตที่ไม่มีคลิปใช้ภาพเหมือนเดิม
 * ลบโฟลเดอร์ clips ทิ้ง = กลับเป็นคลิปแบบเดิมทันที
 */
export const CLIP_PROVIDERS = { off: 'ปิด', kie: 'Kie API' }
export const CLIP_COVERAGES = [20, 60, 80, 100]
export const CLIP_TIERS = ['cheap', 'mid', 'pro'] // ถูก · พอใช้ · เก่ง (รายละเอียดโมเดลอยู่ใน kie.mjs)

export function clipSettings(config) {
  const c = config.clips ?? {}
  const provider = CLIP_PROVIDERS[c.provider] ? c.provider : 'off'
  const requested = Number(c.coveragePercent)
  const coveragePercent = CLIP_COVERAGES.includes(requested) ? requested : 60
  const tier = CLIP_TIERS.includes(c.tier) ? c.tier : 'cheap'
  return { provider, coveragePercent, tier, enabled: provider !== 'off' }
}

/** จำนวนฉากที่ต้องทำคลิป โดยปัดขึ้นเพื่อให้ครอบคลุมไม่น้อยกว่าเปอร์เซ็นต์ที่เลือก */
export function clipTarget(totalScenes, coveragePercent) {
  const total = Math.max(0, Number(totalScenes) || 0)
  if (!total) return 0
  const percent = CLIP_COVERAGES.includes(Number(coveragePercent)) ? Number(coveragePercent) : 60
  return Math.min(total, Math.max(1, Math.ceil(total * percent / 100)))
}

export function clipsDir(slug) {
  return join(projectDir(slug, 'images'), 'clips')
}

export const clipName = (imageName) => imageName.replace(/\.(png|jpe?g|webp)$/i, '.mp4')

/** คลิปที่มีแล้ว: ชื่อภาพ → { file, mtime } (ไฟล์เล็กผิดปกติ = โหลดไม่ครบ ไม่นับ) */
export function collectClips(slug) {
  const dir = clipsDir(slug)
  const clips = new Map()
  if (!existsSync(dir)) return clips
  for (const name of readdirSync(dir)) {
    if (!/\.mp4$/i.test(name) || parseTimecodeFilename(name.replace(/\.mp4$/i, '.png')) == null) continue
    const file = join(dir, name)
    const st = statSync(file)
    if (st.size < 20_000) continue
    clips.set(name.replace(/\.mp4$/i, '.png'), { file, mtime: st.mtimeMs })
  }
  return clips
}

/**
 * ฉาก = ช็อตเปิดฉาก + ช็อตต่อเนื่องที่ตามมา (continuation) — คลิปหนึ่งคลิปเล่นทั้งฉาก
 * ไม่ให้ภาพนิ่งของฉากเดียวกันมาตัดกลางการเคลื่อนไหว (จรวดทะยานแล้วกลับไปอยู่บนฐาน)
 * ฉากยาวเกินคลิป (~5 วิ) → ช็อตที่เกินใช้ภาพเหมือนเดิม (เป็นมุมกล้องใหม่ของฉาก ตัดภาพได้เนียน)
 */
export function scenes(shots) {
  const out = []
  for (const s of shots) {
    if (!out.length || !s.continuation) out.push([s])
    else out.at(-1).push(s)
  }
  return out
}

/** ช็อตเปิดฉากของช็อตนี้ — ChatGPT เลือกช็อตกลางฉากมา → ถอยไปเริ่มต้นฉาก */
export function sceneStart(shots, shot) {
  return scenes(shots).find((sc) => sc.includes(shot))?.[0] ?? shot
}

/**
 * เลือกช่วงสำคัญด้วยกฎในเครื่อง (ใช้เมื่อ ChatGPT เลือกให้ไม่ได้) — คืนช็อตเปิดฉาก
 * ฉากแรก (hook) มาก่อนเสมอ · ประโยคหักมุม คำถาม อุทาน / ฉากสุดท้าย / ฉากหลายช็อต (คลิปใช้ได้เต็มความยาว) ได้คะแนนเพิ่ม
 * ฉากที่เลือกห่างกันอย่างน้อย 2 ฉาก ไม่ให้คลิป AI กองอยู่ช่วงเดียว
 */
const TWIST = /แต่|ความจริง|ที่แท้|ปรากฏว่า|ทันใดนั้น|สุดท้าย|ความลับ|ไม่มีใคร|รู้ไหม|ลองจินตนาการ|[?!]/
export function pickKeyShots(shots, count) {
  const all = scenes(shots)
  if (all.length <= count) return all.map((sc) => sc[0])
  const scored = all.map((sc, i) => {
    let score = i === 0 ? 100 : 0
    if (sc.some((s) => TWIST.test(s.narration ?? ''))) score += 2
    if (sc.length > 1) score += 1
    if (i === all.length - 1) score += 1
    return { s: sc[0], i, score: score - i / all.length } // คะแนนเท่ากัน → ต้นคลิปก่อน
  })
  const picked = []
  for (const gap of [2, 1]) {
    for (const c of [...scored].sort((a, b) => b.score - a.score)) {
      if (picked.length >= count) break
      if (picked.some((p) => Math.abs(p.i - c.i) < gap)) continue
      picked.push(c)
    }
  }
  return picked.sort((a, b) => a.i - b.i).map((c) => c.s)
}

/** คำขอให้ ChatGPT อ่านบททั้งคลิปแล้วเลือกฉากสำคัญที่ควรเป็นคลิปขยับ (ตอบด้วยชื่อไฟล์ช็อตแรกของฉาก) */
export function keyShotRequest(shots, count) {
  return [
    `นี่คือรายการฉากของคลิปการ์ตูน (ชื่อไฟล์ช็อตแรกของฉาก | บทพูดของฉาก | สิ่งที่เกิดในภาพ) จะเอา ${count} ฉากที่สำคัญที่สุดไปทำเป็นวิดีโอขยับจริง ฉากอื่นเป็นภาพนิ่งซูมช้าๆ`,
    'เลือกฉากที่การเคลื่อนไหวช่วยเล่าเรื่องได้มากที่สุด เช่น ฉากเปิดที่ดึงคนดู จุดหักมุม/เฉลย ไคลแมกซ์ ช่วงอารมณ์พีค และตอนจบ',
    '- ภาพต้องมีสิ่งที่ขยับได้ชัด (ตัวละครทำท่า ระเบิด ของตก น้ำไหล ยานพุ่ง ฯลฯ) ไม่ใช่ภาพแผนภาพหรือตัวหนังสือ',
    '- อย่าเลือกฉากติดกัน กระจายให้ทั่วเรื่อง',
    `ตอบเป็นข้อความล้วน บรรทัดละฉาก เฉพาะชื่อไฟล์ ${count} บรรทัด เรียงตามเวลา ห้ามมีคำอื่น`,
    '',
    ...scenes(shots).map((sc) => `${sc[0].filename} | ${sc.map((s) => s.narration ?? '').join(' ')} | ${sc.map((s) => actionOf(s.prompt)).join(' → ')}`),
  ].join('\n')
}

export function parseKeyShots(text, shots, count) {
  const byName = new Map(shots.map((s) => [s.filename, s]))
  const names = [...new Set([...String(text).matchAll(/\d{2}_\d{2}_\d{2}(?:_\d)?\.png/g)].map((m) => m[0]))].filter((n) => byName.has(n))
  const starts = [...new Set(names.map((n) => sceneStart(shots, byName.get(n))))]
  return starts.slice(0, count).sort((a, b) => a.start - b.start)
}

/** ช่อง Action ของ prompt ภาพ — ใช้เป็นท่าขยับสำรองเมื่อ ChatGPT ดูภาพให้ไม่ได้ */
export function actionOf(prompt = '') {
  return /Action:\s*([^|]+)/i.exec(prompt)?.[1]?.trim() ?? ''
}

/**
 * คำขอให้ ChatGPT ดูภาพที่แนบแล้วคิดท่าขยับทีละภาพ — item = { filename, scene: ช็อตทั้งฉาก }
 * กติกากล้องต้องเข้ากับภาพนิ่งที่ซูมช้าๆ ในช็อตอื่น ไม่ให้คนดูรู้สึกว่าเป็นคนละระบบ
 */
export function motionRequest(items) {
  return [
    'ภาพที่แนบคือภาพแรกของฉากในคลิปการ์ตูน เรียงตามลำดับรายการด้านล่าง จะเอาแต่ละภาพไปสร้างวิดีโอสั้นประมาณ 5 วินาทีด้วย AI (image-to-video) ต่อกับฉากอื่นที่เป็นภาพนิ่งซูมช้าๆ',
    'ดูภาพจริงแต่ละภาพ แล้วเขียนคำสั่งวิดีโอเป็นภาษาอังกฤษ (โมเดลวิดีโอเข้าใจแค่อังกฤษ/จีน ห้ามมีภาษาไทยในคำสั่ง) 3 ส่วนต่อภาพ:',
    '- Start: บรรยายภาพตั้งต้นตามที่เห็นจริง — ใคร (ลักษณะภายนอก เช่น man in navy blazer and glasses) อยู่ตรงไหน ท่าทาง/สีหน้าเริ่มต้น และของสำคัญในฉาก',
    '- Action: สิ่งที่เกิดขึ้นชัดๆ ใน 5 วินาที ต่อจากท่าเริ่มต้น ให้ตรงกับ "สิ่งที่เกิดในภาพนี้" และบทพูด — ตัวละครทำอะไร มือ/หัว/ตัวขยับยังไง สีหน้าเปลี่ยนเป็นอะไร ของในฉากขยับยังไง (1–2 action หลัก เห็นชัด ไม่ใช่แค่กะพริบตา)',
    '- Camera: static หรือ very slow push-in เท่านั้น',
    '- ต่อเนื่องเป็นช็อตเดียว ไม่เปลี่ยนฉาก ไม่ตัดภาพ ไม่เพิ่มตัวละครหรือของใหม่',
    '- กล้อง: นิ่ง หรือซูมเข้าช้ามากเท่านั้น (ห้ามแพนเร็ว หมุน บินรอบ หรือเปลี่ยนมุม) ให้เข้ากับฉากอื่นที่เป็นภาพนิ่ง',
    '- ห้ามมีตัวอักษรในวิดีโอเด็ดขาด ห้ามพูดถึงข้อความ ป้าย คำบรรยาย ลูกศร หรือ speech/thought bubble ในคำสั่ง (ถ้าภาพมีตัวหนังสือ ให้สั่งเฉพาะการเคลื่อนไหวของตัวละครและสิ่งของ)',
    'ตอบเป็นข้อความล้วน บรรทัดละภาพ รูปแบบ: ชื่อไฟล์ | Start: … Action: … Camera: … (ห้ามมีคำอื่นนอกจากนี้ ห้ามขึ้นบรรทัดใหม่ในภาพเดียวกัน)',
    'ตัวอย่าง: 00_00_03_7.png | Start: a man in a navy blazer and glasses sits at a cluttered desk, frowning at his laptop. Action: he pushes the laptop away, leans back and rubs his forehead with one hand, then exhales and his shoulders drop; papers on the desk flutter slightly. Camera: static.',
    '',
    ...items.map((it, i) => {
      const scene = it.scene ?? [it]
      const next = scene.slice(1).map((s) => actionOf(s.prompt)).filter(Boolean)
      const own = actionOf(it.prompt)
      return `ภาพที่ ${i + 1}: ${it.filename} — บทพูด: "${scene.map((s) => s.narration ?? '').join(' ')}"${own ? ` — สิ่งที่เกิดในภาพนี้: ${own}` : ''}${next.length ? ` — สิ่งที่เกิดต่อในฉาก: ${next.join(' → ')}` : ''}`
    }),
  ].join('\n')
}

const THAI = /[฀-๿]/

/** ท่าขยับมาตรฐาน — ใช้เมื่อ ChatGPT คิดให้ไม่ได้ (ไม่ใช้ Action ของ prompt ภาพเพราะเป็นภาษาไทยและมักสั่งให้เขียนข้อความ) */
export const DEFAULT_MOTION = 'Start: the frame exactly as given. Action: the main character performs one clear, expressive gesture that fits their pose and mood — turns the head, moves both hands and changes facial expression — while props and lights in the background move gently. Camera: very slow push-in.'

/** คำสั่งท่าขยับที่ส่งไป Kie ได้ — ภาษาไทยหลุดมา (เช่น motions.json ของรอบก่อน) → ใช้ท่ามาตรฐาน */
export const motionFor = (motion) => (motion && !THAI.test(motion) ? motion : DEFAULT_MOTION)

export function parseMotions(text, filenames) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = /(\d{2}_\d{2}_\d{2}(?:_\d)?\.png)\s*[|:：\-–]+\s*(.+)$/.exec(line.replace(/[*`]/g, ''))
    // มีภาษาไทยปน = ChatGPT ไม่ทำตาม → ไม่รับ ใช้ท่ามาตรฐานภาษาอังกฤษแทน
    if (m && filenames.includes(m[1]) && m[2].trim().length > 5 && !THAI.test(m[2])) out[m[1]] = m[2].trim()
  }
  return out
}
