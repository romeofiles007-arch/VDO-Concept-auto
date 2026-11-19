// เทสต์กล่องตั้งเวลาผลิตแบบเลือก 1 ใน 3 (ทำ N คลิป · ทุกวัน · ทำไปเรื่อยๆ) ↔ ค่าเดิมของตัวตั้งเวลา
//   node --test scripts/test-production-schedule.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { modeFields, scheduleFromMode, scheduleCopy, nextProductionStart, gapLabel, nextProductionLabel } from '../extension/production-schedule.js'

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

test('แถบ "ผลิตครั้งต่อไป": เวลา + นับถอยหลัง · กำลังผลิต · ไม่เปิดผลิตไม่แสดง', () => {
  const now = new Date(2026, 10, 19, 18, 48).getTime()
  const settings = { count: 5, start: 'now', time: '22:00', delayMin: 120, delayMax: 120 }
  const at = (h, m, day = 19) => new Date(2026, 10, day, h, m).getTime()
  assert.equal(nextProductionLabel(null, now), null)
  assert.equal(nextProductionLabel({ settings, state: { active: false, made: 5, run: null, nextAt: null } }, now), null)

  const wait = nextProductionLabel({ settings, state: { active: true, made: 2, run: null, nextAt: at(22, 0) } }, now)
  assert.deepEqual(wait, { mode: 'wait', main: 'ผลิตครั้งต่อไป 22:00 น.', sub: 'อีก 3 ชั่วโมง 12 นาที · ทำแล้ว 2/5 คลิป' })
  assert.match(nextProductionLabel({ settings, state: { active: true, made: 0, run: null, nextAt: at(6, 30, 20) } }, now).main, /พรุ่งนี้ 06:30 น\./)
  assert.match(nextProductionLabel({ settings, state: { active: true, made: 0, run: null, nextAt: at(6, 30, 21) } }, now).main, /21 พ\.ย\. 06:30 น\./)
  assert.match(nextProductionLabel({ settings, state: { active: true, made: 0, run: null, nextAt: now + 20_000 } }, now).sub, /^อีก 1 นาที/)
  assert.equal(nextProductionLabel({ settings, state: { active: true, made: 1, run: null, nextAt: now - 1000 } }, now).mode, 'due')

})

test('แถบ "ผลิตครั้งต่อไป" ระหว่างกำลังทำคลิป: บอกเป็นกี่โมง ประมาณจากเวลาที่คลิปก่อนๆ ใช้', () => {
  const now = new Date(2026, 10, 19, 18, 48).getTime()
  const at = (h, m, day = 19) => new Date(2026, 10, day, h, m).getTime()
  const settings = { count: 5, start: 'now', time: '22:00', delayMin: 120, delayMax: 120 }
  // คลิปก่อนใช้ 20, 30, 40 นาที (+1 คลิปที่ล้ม ไม่นับ) → ค่ากลาง 30 นาที
  const history = [
    { ok: true, startedAt: at(12, 0), endedAt: at(12, 20) }, { ok: true, startedAt: at(13, 0), endedAt: at(13, 40) },
    { ok: true, startedAt: at(15, 0), endedAt: at(15, 30) }, { ok: false, startedAt: at(16, 0), endedAt: at(16, 2) },
  ]
  const run = (extra = {}, made = 1, startedAt = at(18, 40)) => nextProductionLabel({ settings: { ...settings, ...extra }, state: { active: true, made, run: { startedAt }, nextAt: null, history } }, now)

  // เริ่ม 18:40 + 30 นาที = เสร็จ 19:10 · เว้น 2 ชม. → 21:10
  assert.deepEqual(run(), { mode: 'run', main: 'ผลิตครั้งต่อไปประมาณ 21:10 น.', sub: 'กำลังผลิตคลิปที่ 2/5 · หลังคลิปนี้เสร็จเว้น 2 ชั่วโมง' })
  // เว้นสุ่ม 20–40 นาที → บอกเป็นช่วงเวลา
  assert.equal(run({ delayMin: 20, delayMax: 40 }).main, 'ผลิตครั้งต่อไปประมาณ 19:30–19:50 น.')
  // ไม่เว้น → คลิปถัดไปเริ่มตอนคลิปนี้เสร็จ
  assert.deepEqual(run({ delayMin: 0, delayMax: 0 }), { mode: 'run', main: 'ผลิตครั้งต่อไปประมาณ 19:10 น.', sub: 'กำลังผลิตคลิปที่ 2/5 · หลังคลิปนี้เสร็จทำต่อทันที' })
  // คลิปนี้ช้ากว่าปกติ (เริ่ม 17:00 ควรเสร็จ 17:30 แต่ยังไม่เสร็จ) → ไม่บอกเวลาที่ผ่านไปแล้ว
  assert.equal(run({ delayMin: 0, delayMax: 0 }, 1, at(17, 0)).main, 'ผลิตครั้งต่อไปประมาณ 18:49 น.')
  // คลิปสุดท้ายของรอบ
  assert.deepEqual(run({}, 4), { mode: 'run', main: 'คลิปสุดท้ายของรอบ — เสร็จประมาณ 19:10 น.', sub: 'กำลังผลิตคลิปที่ 5/5 · เสร็จแล้วหยุดผลิต' })
  assert.deepEqual(run({ start: 'daily' }, 4), { mode: 'run', main: 'ผลิตครั้งต่อไป 22:00 น.', sub: 'กำลังผลิตคลิปที่ 5/5 · คลิปสุดท้ายของรอบวันนี้' })
  // ทำไปเรื่อยๆ (count 0): ไม่มี "/N" และไม่มีคลิปสุดท้าย
  assert.match(run({ count: 0 }, 7).sub, /^กำลังผลิตคลิปที่ 8 ·/)
  // ยังไม่มีคลิปไหนเสร็จ → ยังบอกเวลาไม่ได้ บอกตรงๆ
  const first = nextProductionLabel({ settings, state: { active: true, made: 0, run: { startedAt: at(18, 40) }, nextAt: null, history: [] } }, now)
  assert.deepEqual(first, { mode: 'run', main: 'กำลังผลิตคลิปที่ 1/5', sub: 'ยังบอกเวลาคลิปถัดไปไม่ได้จนกว่าคลิปแรกจะเสร็จ · หลังคลิปนี้เสร็จเว้น 2 ชั่วโมง' })
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
