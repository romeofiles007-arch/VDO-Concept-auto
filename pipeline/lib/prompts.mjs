import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, loadConfig } from './config.mjs'
import { characterFlowNote } from './character.mjs'

import * as shared from '../../extension/prompts.js'

export const { cleanScript, parseTopics, GENRES } = shared

/** Blueprint คือแหล่งความจริงเดียวของกติกาทั้งหมด — ส่งไปทั้งฉบับทุกครั้ง ไม่สรุปย่อ */
export function blueprint(config) {
  return readFileSync(join(ROOT, config.blueprint), 'utf8')
}

export function topicsPrompt(config) {
  return shared.topicsPrompt(blueprint(config), { titleLanguage: config.script.titleLanguage, genre: config.script.genre })
}

export const { parseScoredTopics } = shared

/** หัวข้อพร้อมคะแนน — ชื่อหัวข้อใช้ภาษาเดียวกับเสียงพากย์ของคลิป */
export function scoredTopicsPrompt(config, { avoid = [] } = {}) {
  return shared.scoredTopicsPrompt(blueprint(config), { titleLanguage: config.script.language, minutes: config.script.targetMinutes, avoid, genre: config.script.genre })
}

export function scriptPrompt(config, title) {
  return shared.scriptPrompt(blueprint(config), title, config.script)
}


/** ขั้นที่ 4 — ให้ AI เติม prompt ภาพลงในช่อง shot ที่เราคำนวณจังหวะมาแล้ว */
export function shotlistPrompt(config, { title, slots, timecodeText, slug }) {
  const table = slots
    .map((s) => `${s.filename} | SHOT ${String(s.shot).padStart(2, '0')} | ${s.duration}s | ${s.continuation ? '(ภาพต่อเนื่องจากช็อตก่อน)' : ''} ${s.narration}`)
    .join('\n')

  return `${blueprint(config)}

═══════════════════════════════════════
สร้าง OUTPUT 5 ให้ครบทั้ง 3 ส่วน สำหรับคลิปนี้:

หัวข้อ: "${title}"

Timecode Map:
${timecodeText}

ช่อง shot ที่คำนวณจังหวะมาแล้ว (${slots.length} ช็อต) — ห้ามเพิ่ม ห้ามลด ห้ามแก้ชื่อไฟล์:
${table}

ข้อกำหนดของ output:
- ตอบเป็นข้อความล้วนในแชต ห้ามใส่ code block ครอบทั้งคำตอบ อย่าสร้างไฟล์
- เรียงตามนี้: 5.1 Style Bible → 5.2 Character Bible → 5.3 Shot List
- ส่วน 5.3 ต้องขึ้นต้นด้วยบรรทัด "=== SHOT LIST ===" แล้วตามด้วย shot ทีละบรรทัด
- ทุก shot ขึ้นต้นด้วยชื่อไฟล์ที่ให้มาเป๊ะๆ ตามด้วย | คั่นแต่ละ field
- เว้น 1 บรรทัดว่างระหว่าง shot
- ช็อตที่กำกับว่า "ภาพต่อเนื่อง" ให้เป็น mini-sequence ของช็อตก่อนหน้า ไม่ใช่ฉากใหม่
- ใส่ pattern interrupt ทุก 15-30 วิ ตามกฎ 6
- ตัวละครทุกตัวต้องมี @TAG และห้ามเปลี่ยนรูปร่าง/สี/อุปกรณ์ข้ามช็อต
${imageLanguageRule(clipLanguage(config, slug))}`
}

/**
 * ตัดคำสั่ง "เว้นที่ว่างให้ซับไตเติล" ออกจาก prompt ภาพ — ถ้าส่งไป Flow จะวาดภาพมีแถบว่างด้านล่างทุกภาพ
 * (เคยใส่ไว้ในกฎแนวตั้ง ChatGPT จึงเขียนลงทั้ง Style Bible และทุกช็อต) ซับไตเติลมีกล่องพื้นทึบอยู่แล้ว ไม่ต้องเว้น
 */
export function stripSafeArea(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !/subtitle[- ]safe|reserve the (lower|bottom)|caption[- ]safe/i.test(line) || /^\d{2}_\d{2}_\d{2}|^cover\.png/i.test(line.trim()))
    .join('\n')
    .replace(/[,;]?\s*(?:with\s+)?(?:a\s+)?(?:clear|clean|empty|leave|keep)?\s*(?:the\s+)?(?:lower|bottom)\s+\d{1,2}\s*%\s*(?:of the frame\s*)?(?:as\s+)?(?:clean\s+|clear\s+|empty\s+)?(?:subtitle|caption)[- ]safe\s+(?:area|space|zone)(?:\s+with minimal visual clutter)?/gi, '')
    .replace(/[,;]?\s*(?:away from|avoid(?:ing)?)\s+(?:the\s+)?(?:bottom\s+)?(?:subtitle|caption)[- ]safe\s+(?:area|space|zone)/gi, '')
    // "lower 25% kept clear" · "keep the bottom 20% empty" · "leave lower third clear"
    .replace(/[,;]?\s*(?:(?:keep|leave)\s+)?(?:the\s+)?(?:lower|bottom)\s+(?:\d{1,2}\s*%|third|quarter)\s*(?:of the frame\s*)?(?:is\s+|kept\s+|left\s+|stays?\s+)?(?:clear|empty|clean|blank|open)(?:\s+for\s+(?:subtitles?|captions?|text))?/gi, '')
}

/** ภาษาของคลิป — ใช้ของ project (meta.json) ก่อน เพราะตั้งค่าอาจเปลี่ยนหลังเขียนบทแล้ว */
export function clipLanguage(config, slug) {
  const meta = slug ? join(ROOT, 'projects', slug, '01_script', 'meta.json') : null
  if (meta && existsSync(meta)) {
    const language = JSON.parse(readFileSync(meta, 'utf8')).language
    if (language) return language
  }
  return config.script.language
}

/** ภาษาของคำอธิบายช็อตและตัวอักษรในภาพ — ตามภาษาเสียงพากย์ของคลิป */
export function imageLanguageRule(language) {
  if (language === 'en') {
    return `- ภาษาในภาพ: English — เขียนคำอธิบายใน field (Env/Action/Frame) เป็นภาษาอังกฤษ · ตัวอักษรในภาพ (on-screen text, label, thought bubble) เป็นภาษาอังกฤษ ALL CAPS คำสั้น`
  }
  return `- ภาษาในภาพ: ไทย — เขียนคำอธิบายใน field (Env/Action/Frame) เป็นภาษาไทย แต่คงชื่อ field (SHOT, Chars, Env, Action, Frame) และ @TAG เป็นภาษาอังกฤษตามเดิม
- ตัวอักษรในภาพ (on-screen text, label, thought bubble) เป็นภาษาไทย คำสั้น 1–4 คำ ตัวหนา สะกดถูก — ใส่ข้อความที่จะให้อยู่ในภาพในเครื่องหมายคำพูด เช่น ข้อความบนภาพ "เวลาหยุด?" · ห้ามใช้ภาษาอังกฤษในภาพ`
}

/** แนวภาพของคลิปใหม่: landscape 16:9 (ค่าเดิมของ Blueprint) | portrait 9:16 */
export function orientationOf(config = loadConfig()) {
  return config.render?.orientation === 'portrait' ? 'portrait' : 'landscape'
}
export const aspectOf = (config) => (orientationOf(config) === 'portrait' ? '9:16' : '16:9')

/** Blueprint ใช้ 16:9 เป็นค่าเริ่มต้น — คลิปแนวตั้งต้องบอกให้ใช้ 9:16 แทน */
export function orientationRule(config = loadConfig()) {
  if (orientationOf(config) !== 'portrait') return ''
  return `- คลิปนี้เป็นวิดีโอแนวตั้ง 9:16 (Shorts / Reels / TikTok) — ใช้ ASPECT RATIO 9:16 แทนค่าเริ่มต้น 16:9 ใน Style Bible ของ Blueprint ทุกภาพเป็น 9:16
- จัดองค์ประกอบแนวตั้ง: ตัวละครและจุดสนใจอยู่กลางภาพ ฉากหลังต้องเต็มเฟรมถึงขอบทุกด้าน
- ห้ามเว้นพื้นที่ว่าง แถบสี ขอบขาว หรือโซน subtitle-safe ในภาพ และห้ามเขียนคำพวกนี้ลงใน prompt (ซับไตเติลมีกล่องพื้นทึบของตัวเองอยู่แล้ว)`
}

/** ข้อความที่วางลง Flow — คำกำกับข้างบนตามที่ผู้ใช้ระบุในข้อ 5 ของสเปก */
export function flowPrompt(agentBrief, config = loadConfig()) {
  const portrait = orientationOf(config) === 'portrait'
  const charNote = characterFlowNote()
  return `สร้างรูป ตามนี้ อย่าลืม lock ตัวละครต่างๆ ด้วยนะ${charNote ? `\n${charNote}` : ''}${portrait ? '\nทุกภาพเป็นแนวตั้ง 9:16 จัดองค์ประกอบแนวตั้ง ตัวละครอยู่กลางภาพ' : ''}
ทุกภาพต้องเต็มเฟรม ฉากหลังยาวถึงขอบทุกด้าน ห้ามมีแถบว่าง ขอบขาว หรือพื้นที่เปล่าด้านบน/ล่าง
ตั้งชื่อแต่ละภาพเป็นชื่อไฟล์ที่อยู่หน้าบรรทัดของ shot นั้นเป๊ะๆ เช่น "00_00_00.png SHOT 01"
ชื่อไฟล์ เลข SHOT และ @TAG ใช้ตั้งชื่อภาพเท่านั้น ห้ามเขียนลงในภาพ

${agentBrief}`
}

/** แยก shot list ออกจาก OUTPUT 5 แล้วจับคู่กับช่อง shot ที่เราคำนวณไว้ */
export function parseShotList(text, slots) {
  const byFilename = new Map()
  // ChatGPT อาจใส่ bullet / เลขข้อ / ตัวหนา หน้าชื่อไฟล์ — ยอมรับได้ ขอแค่ชื่อไฟล์อยู่ต้นบรรทัด
  for (const m of text.matchAll(/^(?:[ \t>*•-]+|\d+[.)][ \t]+)?\**(\d{2}_\d{2}_\d{2}(?:_\d)?\.png)\**[ \t:]*(.*)$/gm)) {
    if (m[2].trim()) byFilename.set(m[1], m[2].trim())
  }
  const matched = slots.map((s) => ({ ...s, prompt: byFilename.get(s.filename) ?? null }))
  return { shots: matched, missing: matched.filter((s) => !s.prompt).map((s) => s.filename) }
}
