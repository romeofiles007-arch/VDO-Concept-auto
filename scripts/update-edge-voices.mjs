#!/usr/bin/env node
/**
 * ดึงรายชื่อเสียง Microsoft Edge ทั้งหมดมาเก็บเป็น pipeline/lib/edge_voices.json
 * เก็บเฉพาะเสียงที่พากย์คลิปได้จริง: ไทย · หลายภาษา (Multilingual อ่านไทยได้) · อังกฤษทุกสำเนียง
 * เสียงภาษาอื่นอ่านข้อความไทย/อังกฤษไม่ออก (Microsoft ไม่ส่งเสียงกลับมา) จึงไม่เก็บ
 *
 *   node scripts/update-edge-voices.mjs
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../pipeline/lib/config.mjs'
import { edgePython } from '../pipeline/lib/cloud_tts.mjs'

const env = { ...process.env, PYTHONIOENCODING: 'utf-8' }
delete env.PYTHONHOME
delete env.PYTHONPATH
const res = spawnSync(edgePython(), ['-c', 'import asyncio,json,edge_tts;print(json.dumps(asyncio.run(edge_tts.list_voices()),ensure_ascii=False))'], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
if (res.status !== 0) {
  console.error(`ดึงรายชื่อเสียงไม่สำเร็จ:\n${res.stderr}`)
  process.exit(1)
}

const voices = JSON.parse(res.stdout)
  .filter((v) => /^th-/.test(v.Locale) || /^en-/.test(v.Locale) || /Multilingual/.test(v.ShortName))
  .map((v) => ({
    id: v.ShortName,
    gender: v.Gender,
    locale: v.Locale,
    localeName: v.LocaleName,
    personalities: v.VoiceTag?.VoicePersonalities ?? [],
  }))

const file = join(ROOT, 'pipeline', 'lib', 'edge_voices.json')
writeFileSync(file, JSON.stringify(voices, null, 1) + '\n')
console.log(`บันทึก ${voices.length} เสียง → ${file}`)
