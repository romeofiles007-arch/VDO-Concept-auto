// เทสต์หมวดคลิป: รายชื่อในโค้ดตรงกับ GENRE CATALOG ใน Blueprint · หมวดพระพุทธศาสนาไม่ถูกสุ่มปน
//   node --test scripts/test-genres.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GENRES, pickGenres, isBuddhist, scoredTopicsPrompt, topicsPrompt, BLUEPRINT_FILE } from '../extension/prompts.js'

const blueprint = readFileSync(fileURLToPath(new URL(`../extension/${BLUEPRINT_FILE}`, import.meta.url)), 'utf8')
const BUDDHIST = ['พระพุทธศาสนา', 'พระพุทธศาสนา: คำสอนตามพระไตรปิฎก', 'พระพุทธศาสนา: พุทธประวัติ', 'พระพุทธศาสนา: คำสอนสำหรับฆราวาส']

test('ทุกหมวดในโค้ดมีแถวใน GENRE CATALOG ของ Blueprint', () => {
  for (const g of GENRES) assert.ok(blueprint.includes(`| ${g} |`), `Blueprint ไม่มีแถวของ "${g}"`)
})

test('มีหมวดพระพุทธศาสนา: รวม + 3 กลุ่ม และมีกติกาเฉพาะใน Blueprint', () => {
  for (const g of BUDDHIST) assert.ok(GENRES.includes(g), g)
  assert.deepEqual(GENRES.filter(isBuddhist), BUDDHIST)
  assert.match(blueprint, /\*\*แนวพระพุทธศาสนา\*\*/)
  assert.match(blueprint, /ห้ามแต่งพุทธพจน์/)
})

test('สุ่มหลากหลายแนวไม่มีหมวดพระพุทธศาสนาปน', () => {
  for (let i = 0; i < 300; i++) assert.equal(pickGenres('mix').some(isBuddhist), false)
  assert.deepEqual(pickGenres('พระพุทธศาสนา: พุทธประวัติ'), Array(5).fill('พระพุทธศาสนา: พุทธประวัติ'))
})

test('คำสั่งเสนอหัวข้อของหมวดพระพุทธศาสนา: กติกาความถูกต้อง + มุมเล่าของตัวเอง', () => {
  for (const g of BUDDHIST) {
    const scored = scoredTopicsPrompt('BP', { genre: g }).replace(/^BP/, '')
    assert.match(scored, new RegExp(`แนวของคลิปชุดนี้: ${g}\\*\\*`))
    assert.match(scored, /ห้ามแต่งพุทธพจน์/)
    assert.doesNotMatch(scored, /What if|The most ___/, 'ต้องไม่ใช้มุมเล่าแบบสมมติ/ที่สุดในโลก')
    assert.match(topicsPrompt('BP', { genre: g }), /ห้ามแต่งพุทธพจน์/)
  }
  assert.match(scoredTopicsPrompt('BP', { genre: 'พระพุทธศาสนา' }), /กระจายให้ครบทั้ง 3 กลุ่ม/)
  assert.doesNotMatch(scoredTopicsPrompt('BP', { genre: 'พระพุทธศาสนา: พุทธประวัติ' }), /กระจายให้ครบทั้ง 3 กลุ่ม/)
})

test('หมวดเดิมไม่เปลี่ยนพฤติกรรม', () => {
  const p = scoredTopicsPrompt('BP', { genre: 'อวกาศ & จักรวาล' })
  assert.match(p, /แนวของคลิปชุดนี้: อวกาศ & จักรวาล\*\* — ทั้ง 5 หัวข้อต้องอยู่ในแนวนี้ แต่ใช้ angle ต่างกันทุกข้อ/)
  assert.doesNotMatch(p, /พุทธพจน์/)
  assert.equal(pickGenres('mix').length, 5)
})
