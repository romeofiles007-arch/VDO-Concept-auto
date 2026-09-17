import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { projectDir, slugify, ROOT } from './config.mjs'
import { cleanScript } from './prompts.mjs'
import { estimateMinutes } from './segment.mjs'

// ห่างจากเป้าเกินนี้ถือว่าต้องสั่งใหม่หรือแก้เองก่อนไปขั้นที่ 2
const TOLERANCE = 0.25

/**
 * บันทึกผล STAGE 2 (OUTPUT 2 — VO Script) ให้เป็นไฟล์ชุดเดียวกันทั้งจาก CLI และหน้า UI
 * ชื่อไฟล์ script_<slug>.txt ตาม Blueprint
 */
export function saveScript(config, title, raw) {
  const script = cleanScript(raw)
  const slug = slugify(title)
  const dir = projectDir(slug, 'script')
  const file = join(dir, `script_${slug}.txt`)

  writeFileSync(file, script, 'utf8')
  writeFileSync(join(dir, 'title.txt'), title, 'utf8')
  // ขั้นถัดไปต้องรู้ว่าสคริปต์เป็นภาษาอะไร เพื่อเลือก TTS engine ให้ถูก
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify(
      {
        title,
        slug,
        language: config.script.language,
        titleLanguage: config.script.titleLanguage,
        targetMinutes: config.script.targetMinutes,
      },
      null,
      2,
    ),
  )

  return { slug, file, script, ...lengthCheck(config, script) }
}

export function lengthCheck(config, script, target = config.script.targetMinutes) {
  const minutes = estimateMinutes(script, config.script.wordsPerMinute)
  return { minutes, target, offTarget: Math.abs(minutes - target) > target * TOLERANCE }
}

/** สคริปต์ที่เคยเขียนไว้แล้วของหัวข้อนี้ — ไว้ให้หน้า UI เปิดกลับมาแล้วเห็นงานเดิม */
export function loadScript(config, title) {
  const slug = slugify(title)
  const dir = join(ROOT, 'projects', slug, '01_script')
  const file = join(dir, `script_${slug}.txt`)
  if (!existsSync(file)) return null
  const script = readFileSync(file, 'utf8')
  const meta = existsSync(join(dir, 'meta.json')) ? JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) : {}
  return { slug, file, script, language: meta.language, ...lengthCheck(config, script, meta.targetMinutes) }
}
