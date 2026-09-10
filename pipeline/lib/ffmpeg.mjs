import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const exec = promisify(execFile)

export async function run(bin, args) {
  try {
    const { stdout, stderr } = await exec(bin, args, { maxBuffer: 64 * 1024 * 1024 })
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
export async function renderVideo({ images, voiceover, bgm, outFile, totalDuration, config }) {
  const { resolution = '1920x1080', fps = 30, bgmDb = -21, voiceoverDb = 0, crf = 20 } = config ?? {}
  const [w, h] = resolution.split('x').map(Number)

  // ภาพแต่ละใบอยู่จนกว่าใบถัดไปจะขึ้น ใบสุดท้ายอยู่จนจบเสียง
  const lines = []
  images.forEach((img, i) => {
    const next = images[i + 1]?.start ?? totalDuration
    lines.push(concatLine(img.file, Math.max(0.04, next - img.start)))
  })
  lines.push(concatLine(images.at(-1).file)) // concat demuxer ต้องการบรรทัดปิดซ้ำใบสุดท้าย
  const listFile = writeConcatFile(lines, 'img')

  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-i', voiceover]
  if (bgm) args.push('-stream_loop', '-1', '-i', bgm)

  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=white,fps=${fps},format=yuv420p`
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
  await run('ffmpeg', args)
  return outFile
}
