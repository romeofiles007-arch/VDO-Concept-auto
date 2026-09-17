#!/usr/bin/env node
/**
 * เทรนเสียงใหม่เข้าคลังเสียง — เรียก tts/myvoice/train_voice.py ด้วย python ของระบบเสียง (tts/.venv)
 *
 *   node pipeline/train_voice.mjs <voice-id> [--epochs 40]
 *
 * ต้องอัปโหลดไฟล์เสียงไว้ที่ tts/voices/<voice-id>/raw/ ก่อน (แผงข้างทำให้)
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, ROOT, ttsPython } from './lib/config.mjs'
import { voiceDir, rawFiles } from './lib/voices.mjs'

const [id, ...rest] = process.argv.slice(2)
if (!id) {
  console.error('ใช้: node pipeline/train_voice.mjs <voice-id> [--epochs 40]')
  process.exit(1)
}
const config = loadConfig()
const epochsArg = rest.indexOf('--epochs')
const epochs = epochsArg >= 0 ? Number(rest[epochsArg + 1]) : (config.tts.myVoice?.trainEpochs ?? 40)

const python = ttsPython(config)
if (!existsSync(python)) {
  console.error(`ยังไม่ได้ติดตั้งระบบเสียง (${python})\nรัน: powershell -ExecutionPolicy Bypass -File scripts\\setup-tts.ps1`)
  process.exit(1)
}
if (!rawFiles(id).length) {
  console.error(`ยังไม่มีไฟล์เสียงใน ${join(voiceDir(id), 'raw')}`)
  process.exit(1)
}

// PYTHONHOME/PYTHONPATH ของ Python ตัวอื่นในเครื่อง (เช่น DaVinci Resolve) ทำให้ venv เปิดไม่ขึ้น
const env = { ...process.env, KMP_DUPLICATE_LIB_OK: 'TRUE', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
delete env.PYTHONHOME
delete env.PYTHONPATH

const proc = spawn(python, [join(ROOT, 'tts/myvoice/train_voice.py'), voiceDir(id), '--epochs', String(epochs)], {
  cwd: ROOT,
  env,
  windowsHide: true,
})
proc.stdout.pipe(process.stdout)
// warning ของ torch/whisper ยาวมาก — ส่งต่อเฉพาะบรรทัดที่ดูเป็น error หรือ progress bar ของการเทรน
proc.stderr.on('data', (d) => {
  for (const line of d.toString('utf8').split(/(?<=[\r\n])/)) {
    if (/error|traceback|exception|epoch|\d+%\|/i.test(line) && !/warn/i.test(line)) process.stdout.write(line)
  }
})
proc.on('close', (code) => process.exit(code ?? 1))
