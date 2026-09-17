import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, cpus } from 'node:os'

const exec = promisify(execFile)

export async function run(bin, args, { cwd } = {}) {
  try {
    const { stdout, stderr } = await exec(bin, args, { maxBuffer: 64 * 1024 * 1024, cwd })
    return stdout || stderr
  } catch (err) {
    throw new Error(`${bin} ล้มเหลว:\n${String(err.stderr || err.message).split('\n').slice(-15).join('\n')}`)
  }
}

export async function probeDuration(file) {
  const out = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ])
  const sec = Number.parseFloat(out.trim())
  if (!Number.isFinite(sec)) throw new Error(`อ่านความยาวไม่ได้: ${file}`)
  return sec
}

/**
 * ช่วงเงียบระหว่างประโยค — ค่าที่เลือกได้ในแผงข้าง (มิลลิวินาที)
 * ความเงียบหัวท้ายที่ TTS แถมมาในแต่ละไฟล์ถูกตัดทิ้งก่อน (trimSilence) จึงเหลือแค่ช่วงที่กำหนดตรงนี้จริงๆ
 */
export const PAUSE_PRESETS = {
  tight: { label: 'ชิด', segmentGapMs: 120, paragraphGapMs: 300 },
  normal: { label: 'ปกติ', segmentGapMs: 220, paragraphGapMs: 500 },
  wide: { label: 'เว้นมาก', segmentGapMs: 400, paragraphGapMs: 800 },
}

/**
 * ตัดความเงียบหัว/ท้ายไฟล์เสียงหนึ่งประโยค (เขียนทับไฟล์เดิม) — ช่วงหยุดกลางประโยคไม่โดนตัด
 * เก็บหัว 40ms ท้าย 80ms ไว้ ไม่ให้เสียงแรก/หางเสียงขาด
 */
export async function trimSilence(file, { threshold = -45, keepStart = 0.04, keepEnd = 0.08 } = {}) {
  const tmp = file.replace(/\.wav$/i, '.trim.wav')
  const edge = (keep) => `silenceremove=start_periods=1:start_duration=0:start_threshold=${threshold}dB:start_silence=${keep}`
  await run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-af', `${edge(keepStart)},areverse,${edge(keepEnd)},areverse`, tmp])
  // ไฟล์เงียบทั้งไฟล์หรือเสียงเบามาก → ตัดแล้วเหลือแทบไม่มี ให้ใช้ไฟล์เดิม
  if ((await probeDuration(tmp).catch(() => 0)) < 0.25) {
    if (existsSync(tmp)) unlinkSync(tmp)
    return false
  }
  renameSync(tmp, file)
  return true
}

/** ทำงานทีละหลายไฟล์พร้อมกัน */
export async function eachLimit(items, limit, fn) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      await fn(items[idx], idx)
    }
  }))
}

/** ffmpeg concat demuxer ต้องการ forward slash + escape single quote */
function concatLine(file, duration) {
  const p = file.replace(/\\/g, '/').replace(/'/g, "'\\''")
  return duration == null ? `file '${p}'` : `file '${p}'\nduration ${duration}`
}

function writeConcatFile(lines, tag) {
  const path = join(tmpdir(), `concat_${tag}_${Date.now()}.txt`)
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
  return path
}

/**
 * ต่อไฟล์เสียง segment เข้าด้วยกัน พร้อมแทรกความเงียบตาม gap ที่ timeline กำหนด
 * @param {{file:string, gapAfter:number}[]} parts
 */
export async function concatAudio(parts, outFile, { sampleRate = 24000 } = {}) {
  const inputs = []
  const filters = []
  parts.forEach((p, i) => {
    inputs.push('-i', p.file)
    filters.push(`[${i}:a]aresample=${sampleRate}[a${i}]`)
  })
  // แทรกความเงียบเป็น stream สังเคราะห์ระหว่างแต่ละชิ้น
  const chain = []
  parts.forEach((p, i) => {
    chain.push(`[a${i}]`)
    const isLast = i === parts.length - 1
    if (!isLast && p.gapAfter > 0) {
      const idx = parts.length + i
      inputs.push('-f', 'lavfi', '-t', String(p.gapAfter), '-i', `anullsrc=r=${sampleRate}:cl=mono`)
      filters.push(`[${idx}:a]aresample=${sampleRate}[s${i}]`)
      chain.push(`[s${i}]`)
    }
  })
  filters.push(`${chain.join('')}concat=n=${chain.length}:v=0:a=1[out]`)

  await run('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[out]', '-ar', String(sampleRate), '-ac', '1', '-c:a', 'pcm_s16le',
    outFile,
  ])
  return outFile
}

/**
 * ประกอบภาพ (ชื่อไฟล์ = timecode) + เสียงพากย์ + BGM → MP4
 * @param {{file:string, start:number}[]} images  เรียงตามเวลาแล้ว
 */
/** ขนาดภาพจริง — ใช้ตัดสินว่าคลิปนี้แนวตั้งหรือแนวนอน */
export async function probeSize(file) {
  const out = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
  const [width, height] = out.trim().split(',').map(Number)
  return { width, height }
}

/**
 * ภาพเคลื่อนไหว (ไม่ใช้ AI) — ซูม/เลื่อนกล้องช้าๆ ทีละช็อต สลับท่าไม่ให้ซ้ำกับช็อตก่อน
 * amount = ซูมสูงสุดกี่เท่าของภาพ (0.06 = 6%)
 */
export const MOTION_PRESETS = {
  off: { label: 'ภาพนิ่ง', amount: 0 },
  gentle: { label: 'ขยับเบาๆ', amount: 0.06 },
  lively: { label: 'ขยับมาก', amount: 0.14 },
}
// i*5 mod 8 เรียงครบทุกท่าและช็อตติดกันไม่ได้ท่าเดียวกัน
const MOVES = ['in', 'panRight', 'out', 'panLeft', 'in', 'panDown', 'out', 'panUp']

/** ขยายเฟรมก่อน zoompan — zoompan ปัดตำแหน่งเป็นพิกเซลเต็ม ภาพใหญ่ขึ้นจึงเลื่อนเนียนไม่สั่น */
const SUPERSAMPLE = 3

function frameFilter(w, h, fit) {
  // cover = ขยายเต็มจอแล้วตัดขอบนิดเดียว (ภาพ Flow 1376x768 ไม่ใช่ 16:9 พอดี) · contain = ย่อทั้งภาพ เติมขอบขาว
  return fit === 'cover'
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=white`
}

function motionFilter({ w, h, fit, fps, frames, amount, move }) {
  const d = Math.max(1, frames - 1)
  // ease in-out (smoothstep) — เริ่มและจบนุ่ม ไม่กระตุกตอนเปลี่ยนช็อต
  const e = `(on/${d})*(on/${d})*(3-2*on/${d})`
  const cx = '(iw-iw/zoom)/2'
  const cy = '(ih-ih/zoom)/2'
  const [z, x, y] = {
    in: [`1+${amount}*${e}`, cx, cy],
    out: [`1+${amount}-${amount}*${e}`, cx, cy],
    panRight: [`1+${amount}`, `(iw-iw/zoom)*${e}`, cy],
    panLeft: [`1+${amount}`, `(iw-iw/zoom)*(1-${e})`, cy],
    panDown: [`1+${amount}`, cx, `(ih-ih/zoom)*${e}`],
    panUp: [`1+${amount}`, cx, `(ih-ih/zoom)*(1-${e})`],
  }[move]
  return `${frameFilter(w * SUPERSAMPLE, h * SUPERSAMPLE, fit)},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${w}x${h}:fps=${fps},format=yuv420p`
}

/** สร้างคลิปสั้นของแต่ละช็อต — นับเวลาเป็นเฟรมจากเวลาจริงของช็อต ต่อกันแล้วไม่คลาดจากเสียง */
async function renderMotionShots({ images, totalDuration, w, h, fit, fps, amount, workDir, onProgress }) {
  mkdirSync(workDir, { recursive: true })
  const shots = images.map((img, i) => {
    const from = i === 0 ? 0 : Math.round(img.start * fps)
    const to = Math.round((images[i + 1]?.start ?? totalDuration) * fps)
    return { img, frames: Math.max(1, to - from), file: join(workDir, `shot_${String(i).padStart(4, '0')}.mp4`), move: MOVES[(i * 5) % MOVES.length] }
  })
  let done = 0
  await eachLimit(shots, Math.max(2, Math.min(6, Math.floor(cpus().length / 4))), async (s) => {
    await run('ffmpeg', [
      '-y', '-v', 'error', '-i', s.img.file,
      '-vf', motionFilter({ w, h, fit, fps, frames: s.frames, amount, move: s.move }),
      '-frames:v', String(s.frames), '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-an',
      s.file,
    ])
    onProgress?.(++done, shots.length)
  })
  return writeConcatFile(shots.map((s) => concatLine(s.file)), 'motion')
}

export async function renderVideo({ images, voiceover, bgm, outFile, totalDuration, config, resolution: size, subtitles, fit = 'contain', motion = 'off', onProgress }) {
  const { resolution: configured = '1920x1080', fps = 30, bgmDb = -21, voiceoverDb = 0, crf = 20 } = config ?? {}
  const resolution = size ?? configured
  const [w, h] = resolution.split('x').map(Number)
  const amount = MOTION_PRESETS[motion]?.amount ?? 0
  const workDir = join(dirname(outFile), 'motion_tmp')

  let listFile
  let frame
  if (amount > 0) {
    // ภาพเคลื่อนไหว: แต่ละช็อตเป็นคลิปขนาดจอแล้ว ขั้นสุดท้ายแค่ต่อ + ใส่ซับ + เสียง
    listFile = await renderMotionShots({ images, totalDuration, w, h, fit, fps, amount, workDir, onProgress })
    frame = 'null'
  } else {
    // ภาพแต่ละใบอยู่จนกว่าใบถัดไปจะขึ้น ใบสุดท้ายอยู่จนจบเสียง
    const lines = []
    images.forEach((img, i) => {
      const next = images[i + 1]?.start ?? totalDuration
      lines.push(concatLine(img.file, Math.max(0.04, next - img.start)))
    })
    lines.push(concatLine(images.at(-1).file)) // concat demuxer ต้องการบรรทัดปิดซ้ำใบสุดท้าย
    listFile = writeConcatFile(lines, 'img')
    frame = frameFilter(w, h, fit)
  }

  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-i', voiceover]
  if (bgm) args.push('-stream_loop', '-1', '-i', bgm)

  // ซับไตเติล: ffmpeg บน Windows escape path ใน filter ยาก → รันใน โฟลเดอร์ของไฟล์ .ass แล้วอ้างชื่อไฟล์เปล่าๆ
  const subs = subtitles ? `,ass=${subtitles.name}` : ''
  const vf = `${frame}${subs},fps=${fps},format=yuv420p`
  const audio = bgm
    ? [
        '-filter_complex',
        `[0:v]${vf}[v];[1:a]volume=${voiceoverDb}dB[vo];[2:a]volume=${bgmDb}dB[bg];[vo][bg]amix=inputs=2:duration=first:dropout_transition=0[a]`,
        '-map', '[v]', '-map', '[a]',
      ]
    : ['-vf', vf, '-map', '0:v', '-map', '1:a']

  args.push(
    ...audio,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf),
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart',
    outFile,
  )
  try {
    await run('ffmpeg', args, { cwd: subtitles?.dir })
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
  return outFile
}
