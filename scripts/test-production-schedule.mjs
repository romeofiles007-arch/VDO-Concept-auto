// เทสต์กล่องตั้งเวลาผลิตแบบเลือก 1 ใน 3 (ทำ N คลิป · ทุกวัน · ทำไปเรื่อยๆ) ↔ ค่าเดิมของตัวตั้งเวลา
//   node --test scripts/test-production-schedule.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { modeFields, scheduleFromMode, scheduleCopy, nextProductionStart, gapLabel } from '../extension/production-schedule.js'

const base = { batchCount: '3', later: false, batchTime: '22:00', dailyTime: '22:00', dailyCount: '2', loopHours: '2', loopMins: '0' }

test('ทั้ง 3 แบบบันทึกแล้วเปิดกลับมาได้แบบเดิม', () => {
  for (const saved of [
    { count: 3, start: 'now', time: '22:00', delayMin: 0, delayMax: 0 },
    { count: 3, start: 'at', time: '06:30', delayMin: 0, delayMax: 0 },
    { count: 2, start: 'daily', time: '22:00', delayMin: 0, delayMax: 0 },
    { count: 0, start: 'now', time: '22:00', delayMin: 120, delayMax: 120 },
    { count: 0, start: 'now', time: '22:00', delayMin: 95, delayMax: 95 },
  ]) assert.deepEqual(scheduleFromMode(modeFields(saved)), saved)
})

test('ค่าเก่าที่ตั้งแบบเดิมเปิดแล้วเลือกแบบให้ถูก', () => {
  assert.equal(modeFields({ count: 1, start: 'now', time: '22:00', delayMin: 120, delayMax: 120 }).mode, 'batch') // 1 คลิป + พัก 120 = ทำ 1 คลิป
  assert.equal(modeFields({ count: 5, start: 'daily', time: '22:00', delayMin: 20, delayMax: 40 }).mode, 'daily')
  const loop = modeFields({ count: 0, start: 'now', time: '22:00', delayMin: 20, delayMax: 40 })
  assert.equal(loop.mode, 'loop')
  assert.deepEqual([loop.loopHours, loop.loopMins], [0, 20])
  const loop2 = modeFields({ count: 0, start: 'now', time: '22:00', delayMin: 135, delayMax: 135 })
  assert.deepEqual([loop2.loopHours, loop2.loopMins], [2, 15])
})

test('ทำ N คลิป: ต่อกันไม่พัก · รอเริ่มต้องมีเวลา', () => {
  assert.deepEqual(scheduleFromMode({ ...base, mode: 'batch' }), { count: 3, start: 'now', time: '22:00', delayMin: 0, delayMax: 0 })
  assert.throws(() => scheduleFromMode({ ...base, mode: 'batch', later: true, batchTime: '' }), /เวลา/)
  for (const n of ['', '0', '1.5', '101']) assert.throws(() => scheduleFromMode({ ...base, mode: 'batch', batchCount: n }), /จำนวนคลิป/)
})

test('ทุกวัน: ต้องมีเวลาและจำนวน', () => {
  assert.deepEqual(scheduleFromMode({ ...base, mode: 'daily', dailyTime: '06:30' }), { count: 2, start: 'daily', time: '06:30', delayMin: 0, delayMax: 0 })
  assert.throws(() => scheduleFromMode({ ...base, mode: 'daily', dailyTime: '24:01' }), /เวลา/)
  assert.throws(() => scheduleFromMode({ ...base, mode: 'daily', dailyCount: '0' }), /จำนวนคลิป/)
})

test('ทำไปเรื่อยๆ: ตั้งเป็นชั่วโมง + นาที ได้ละเอียดถึงนาที ไม่เกิน 12 ชั่วโมง', () => {
  const gap = (h, m) => scheduleFromMode({ ...base, mode: 'loop', loopHours: h, loopMins: m }).delayMin
  assert.equal(gap('1', '30'), 90)
  assert.equal(gap('0', '45'), 45)
  assert.equal(gap('2', '15'), 135)
  assert.equal(gap('', '20'), 20, 'ช่องชั่วโมงว่าง = 0')
  assert.equal(gap('3', ''), 180, 'ช่องนาทีว่าง = 0')
  assert.equal(gap('0', '0'), 0)
  assert.equal(gap('12', '0'), 720)
  for (const [h, m] of [['-1', '0'], ['13', '0'], ['1.5', '0'], ['12', '1']]) assert.throws(() => gap(h, m), /ชั่วโมง/)
  for (const m of ['60', '-5', '2.5']) assert.throws(() => gap('1', m), /นาที/)
})

test('เวลาเริ่มที่ผ่านไปแล้ววันนี้ → พรุ่งนี้', () => {
  const now = new Date(2026, 10, 3, 22, 0, 0)
  assert.equal(nextProductionStart('22:00', now).getDate(), 4)
  assert.equal(nextProductionStart('23:00', now).getDate(), 3)
})

test('ข้อความสรุปอ่านเข้าใจ', () => {
  const now = new Date(2026, 10, 3, 23)
  assert.equal(gapLabel(120), '2 ชั่วโมง')
  assert.equal(gapLabel(90), '1 ชั่วโมง 30 นาที')
  assert.equal(gapLabel(30), '30 นาที')
  assert.match(scheduleCopy(scheduleFromMode({ ...base, mode: 'daily' }), now).headline, /ทุกวัน 22:00.*วันละ 2 คลิป/)
  assert.match(scheduleCopy(scheduleFromMode({ ...base, mode: 'loop' }), now).detail, /เว้น 2 ชั่วโมง/)
  assert.equal(scheduleCopy(scheduleFromMode({ ...base, mode: 'batch', batchCount: '1' }), now).detail, 'ทำคลิปเดียวแล้วหยุด')
  assert.equal(scheduleCopy(scheduleFromMode({ ...base, mode: 'batch' }), now).action, 'เริ่มผลิต 3 คลิป')
})
