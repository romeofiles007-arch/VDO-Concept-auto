/**
 * ตัดกรอบออกจากภาพที่ Flow วาดมา — กฎ "ห้ามมีกรอบ" ในคำสั่งกันได้ไม่ครบ (ลูกค้าแจ้ง 14 พ.ย. 2026: ภาพราว 80% มีขอบ)
 * Flow ชอบวาดเป็น "แผ่นภาพวางบนกระดาษ": เว้นขอบสีเดียว (ขาว/ครีม) รอบภาพทั้ง 4 ด้าน บางใบมีเส้นกรอบหรือมุมโค้ง
 *
 * วิธีตรวจ (ต้องผ่านทุกข้อ ไม่งั้นไม่แตะภาพ):
 *   1. แถวนอกสุดทั้ง 4 ด้านเป็นสีเดียวกันเกือบทั้งแถว (ภาพเต็มเฟรมปกติตกข้อนี้ทันที)
 *   2. ไล่เข้าไปจากแต่ละด้าน หา "ขอบภาพด้านใน" = แถวที่เกือบทั้งแถวไม่ใช่สีขอบ ภายใน 20% ของภาพ และขอบต้องคม
 *      (การ์ตูนพื้นหลังสีเรียบตกข้อนี้ — ตัวละครกลางภาพไม่ได้ยาวเต็มแถว · ภาพที่จางเข้าหาขอบก็ตก)
 *   3. กรอบบาง ≤ 8% ต้องเจอ 3 ด้านขึ้นไป · กรอบหนากว่านั้นต้องครบ 4 ด้าน
 * เจอแล้ว: ตัดเหลือภาพด้านใน → ตัดให้ได้สัดส่วนเดิม → ขยายกลับเป็นขนาดเดิม · ต้นฉบับเก็บไว้ใน _original/
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, copyFileSync, renameSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { probeSize, run, eachLimit } from './ffmpeg.mjs'

const exec = promisify(execFile)

const N = 240 // ย่อภาพเป็น N×N ก่อนตรวจ — ระยะขอบคิดเป็นสัดส่วนของภาพ
const TOLERANCE = 40 // ผลรวมส่วนต่าง R+G+B ที่ยังนับว่าเป็น "สีขอบ"
const MAX_DEPTH = 0.2 // ขอบลึกเกินนี้ไม่ใช่กรอบ
const MIN_DEPTH = 0.01
const THIN_DEPTH = 0.08 // กรอบไม่เกินนี้นับเป็น "กรอบบาง" — ตัดผิดก็เสียภาพนิดเดียว จึงผ่อนเกณฑ์ได้
const INSET = 0.006 // ตัดลึกเข้าไปอีกนิด เก็บเส้นกรอบและขอบฟุ้ง
const MAX_CORNER = 0.04 // มุมโค้ง: ขยับเข้าได้อีกไม่เกินเท่านี้
export const ORIGINAL_DIR = '_original'

async function sample(file) {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${N}:${N}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
  if (stdout.length < N * N * 3) throw new Error(`อ่านภาพไม่ได้: ${file}`)
  return stdout
}

const median = (values) => values.sort((a, b) => a - b)[values.length >> 1]

/**
 * หาขอบของภาพด้านใน จากพิกเซล rgb24 ขนาด n×n
 * @returns {{ top: number, bottom: number, left: number, right: number } | null} ระยะกรอบแต่ละด้าน เป็นสัดส่วน 0–1 ของภาพ
 */
export function findFrame(rgb, n = N) {
  const at = (x, y) => (y * n + x) * 3
  const ring = []
  for (let k = 0; k < n; k++) ring.push(at(k, 0), at(k, n - 1), at(0, k), at(n - 1, k))
  const ref = [0, 1, 2].map((c) => median(ring.map((i) => rgb[i + c])))
  const isRef = (i) => Math.abs(rgb[i] - ref[0]) + Math.abs(rgb[i + 1] - ref[1]) + Math.abs(rgb[i + 2] - ref[2]) <= TOLERANCE

  // แต่ละด้าน: พิกเซลที่ k ของแถวที่ลึก d จากขอบ
  const sides = {
    top: (d, k) => at(k, d),
    bottom: (d, k) => at(k, n - 1 - d),
    left: (d, k) => at(d, k),
    right: (d, k) => at(n - 1 - d, k),
  }
  /** สัดส่วนพิกเซลในแถวที่ "ไม่ใช่สีขอบ" — นับเฉพาะช่วง from..to ของแถว */
  const painted = (side, d, from = 0, to = n) => {
    let count = 0
    for (let k = from; k < to; k++) if (!isRef(sides[side](d, k))) count++
    return count / (to - from)
  }
  const limit = Math.floor(n * MAX_DEPTH)
  const depth = (side, threshold, from, to) => {
    for (let d = 0; d <= limit; d++) if (painted(side, d, from, to) >= threshold) return d
    return -1
  }

  const names = Object.keys(sides)
  // 1. แถวนอกสุดทุกด้านต้องเป็นสีขอบ
  for (const side of names) if (painted(side, 0) > 0.1) return null
  // 2. รอบแรกดูทั้งแถว (รวมกรอบของด้านข้างด้วย จึงใช้เกณฑ์หลวม) แล้วรอบสองดูเฉพาะช่วงภาพด้านใน
  const rough = {}
  for (const side of names) rough[side] = Math.max(0, depth(side, 0.5))
  const found = {} // ด้านที่มีกรอบ → ความลึกของกรอบ (ด้านที่ไม่มีกรอบไม่อยู่ในนี้)
  for (const side of names) {
    const [a, b] = side === 'top' || side === 'bottom' ? [rough.left, rough.right] : [rough.top, rough.bottom]
    const d = depth(side, 0.7, a, n - b)
    if (d < Math.ceil(n * MIN_DEPTH)) continue
    // ขอบต้องคม: ถอยออกมา 5 แถวยังเป็นสีขอบ — ภาพที่จาง/มืดลงทีละน้อยเข้าหาขอบ (หมอก, vignette) ไม่ใช่กรอบ
    if (painted(side, Math.max(0, d - 5), a, n - b) > 0.3) continue
    found[side] = d
  }
  // 3. กรอบบาง (ทุกด้าน ≤ 8%) ขอ 3 ด้านพอ — ภาพวาดที่ด้านล่างจางเป็นหมอกมีกรอบแค่ 3 ด้าน
  //    กรอบหนากว่านั้นต้องครบ 4 ด้าน — ห้องที่วาดเป็นลายเส้นบนพื้นสีเรียบ (ผนัง+เพดาน) มีเส้นตรงยาวแค่ 2–3 ด้าน
  const framed = names.filter((side) => side in found)
  const thin = framed.every((side) => found[side] <= n * THIN_DEPTH)
  if (framed.length < (thin ? 3 : 4)) return null

  // ตัดลึกกว่าขอบที่เจอเล็กน้อย + ขยับเข้าเพิ่มถ้ามุมยังเป็นสีขอบ (มุมโค้ง)
  const base = Math.max(2, Math.round(n * INSET))
  const maxExtra = base + Math.round(n * MAX_CORNER)
  const edge = (side, e) => (side in found ? found[side] + e : 0)
  const corners = [['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right']].filter(([v, h]) => v in found && h in found)
  const cornersClean = (e) =>
    corners.every(([v, h]) => {
      const y = v === 'top' ? edge('top', e) : n - 1 - edge('bottom', e)
      const x = h === 'left' ? edge('left', e) : n - 1 - edge('right', e)
      return !isRef(at(x, y))
    })
  let extra = base
  while (extra < maxExtra && !cornersClean(extra)) extra++
  if (!cornersClean(extra)) extra = base // ภาพด้านในมีสีเดียวกับขอบอยู่แล้ว ไม่ใช่มุมโค้ง

  const out = {}
  for (const side of names) out[side] = edge(side, extra) / n
  return out
}

export async function detectFrame(file) {
  return findFrame(await sample(file))
}

/** กรอบ (สัดส่วน) → กรอบตัดเป็นพิกเซล ที่มีสัดส่วนกว้าง:สูงเท่าภาพเดิม */
export function cropBox(frame, width, height) {
  let x = Math.round(frame.left * width)
  let y = Math.round(frame.top * height)
  let w = width - x - Math.round(frame.right * width)
  let h = height - y - Math.round(frame.bottom * height)
  const aspect = width / height
  if (w / h > aspect) {
    const keep = Math.round(h * aspect)
    x += Math.round((w - keep) / 2)
    w = keep
  } else {
    const keep = Math.round(w / aspect)
    y += Math.round((h - keep) / 2)
    h = keep
  }
  return { x, y, w, h }
}

/** ตัดกรอบของภาพหนึ่งใบ (เขียนทับไฟล์เดิม เก็บต้นฉบับไว้ใน _original/) — คืน false ถ้าภาพไม่มีกรอบ */
export async function trimFrame(file) {
  const frame = await detectFrame(file)
  if (!frame) return false
  const { width, height } = await probeSize(file)
  const { x, y, w, h } = cropBox(frame, width, height)
  if (w < width * 0.5 || h < height * 0.5) return false
  const backupDir = join(dirname(file), ORIGINAL_DIR)
  mkdirSync(backupDir, { recursive: true })
  const tmp = join(backupDir, `_tmp_${basename(file)}`)
  await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},scale=${width}:${height}:flags=lanczos`, tmp])
  copyFileSync(file, join(backupDir, basename(file)))
  renameSync(tmp, file)
  return true
}

/**
 * ตัดกรอบทุกภาพในโฟลเดอร์ (ช็อต + ปก) — เรียกซ้ำได้ ภาพที่ตัดแล้วไม่ตรวจซ้ำ จนกว่าไฟล์จะถูกสร้างใหม่
 * @returns {Promise<string[]>} ชื่อไฟล์ที่ถูกตัดกรอบรอบนี้
 */
export async function trimFrames(dir) {
  if (!existsSync(dir)) return []
  const names = readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
  const stateFile = join(dir, ORIGINAL_DIR, '_trimmed.json')
  let state = {}
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch {}
  const stamp = (file) => { const s = statSync(file); return `${s.size}:${Math.round(s.mtimeMs)}` }
  const trimmed = []
  await eachLimit(names, 4, async (name) => {
    const file = join(dir, name)
    if (state[name] === stamp(file)) return
    try {
      if (!(await trimFrame(file))) return
      state[name] = stamp(file)
      trimmed.push(name)
    } catch (err) {
      rmSync(join(dir, ORIGINAL_DIR, `_tmp_${name}`), { force: true })
      console.warn(`ตัดกรอบภาพ ${name} ไม่สำเร็จ: ${String(err.message).split('\n')[0]}`)
    }
  })
  if (trimmed.length) writeFileSync(stateFile, JSON.stringify(state, null, 2))
  return trimmed.sort()
}
