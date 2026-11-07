// กล่องตั้งเวลาผลิต: เลือก 1 ใน 3 แบบ แล้วแปลงเป็นค่าเดิมของตัวตั้งเวลา (bridge/production.js) — ไฟล์นี้ไม่ตั้งเวลาเอง
//   batch  ทำ N คลิปต่อกันจนครบ (เริ่มตอนนี้ หรือรอเริ่มตอน HH:MM ครั้งเดียว)
//   daily  ทุกวันตอน HH:MM ทำ N คลิป
//   loop   ทำไปเรื่อยๆ ทีละคลิป เว้น X ชั่วโมงระหว่างคลิป จนกดหยุด
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const invalid = (field, message) => Object.assign(new Error(message), { field })
function integer(value, min, max, field, message) {
  const n = Number(value)
  if (String(value).trim() === '' || !Number.isInteger(n) || n < min || n > max) throw invalid(field, message)
  return n
}

/** ค่าที่บันทึกไว้ → ค่าในช่องของทั้ง 3 แบบ (แบบที่ไม่ได้เลือกได้ค่าตั้งต้นที่ใช้ต่อได้เลย) */
export function modeFields(s) {
  const mode = s.start === 'daily' ? 'daily' : !s.count ? 'loop' : 'batch'
  return {
    mode,
    batchCount: s.count || 1,
    later: s.start === 'at',
    batchTime: s.time,
    dailyTime: s.time,
    dailyCount: s.count || 1,
    loopHours: s.count === 0 ? Math.floor((s.delayMin || 0) / 60) : 2,
    loopMins: s.count === 0 ? (s.delayMin || 0) % 60 : 0,
  }
}

/** ค่าในช่อง → ค่าของตัวตั้งเวลา { count, start, time, delayMin, delayMax } · ผิด = throw พร้อมชื่อช่อง */
export function scheduleFromMode(f) {
  if (f.mode === 'batch') {
    const count = integer(f.batchCount, 1, 100, 'prodBatchCount', 'ใส่จำนวนคลิปเป็นจำนวนเต็ม 1–100')
    if (f.later && !clock.test(f.batchTime)) throw invalid('prodBatchTime', 'เลือกเวลาเริ่มให้ครบ')
    return { count, start: f.later ? 'at' : 'now', time: f.later ? f.batchTime : f.dailyTime || f.batchTime || '22:00', delayMin: 0, delayMax: 0 }
  }
  if (f.mode === 'daily') {
    if (!clock.test(f.dailyTime)) throw invalid('prodDailyTime', 'เลือกเวลาทำคลิปของแต่ละวันให้ครบ')
    const count = integer(f.dailyCount, 1, 100, 'prodDailyCount', 'ใส่จำนวนคลิปต่อวันเป็นจำนวนเต็ม 1–100')
    return { count, start: 'daily', time: f.dailyTime, delayMin: 0, delayMax: 0 }
  }
  if (f.mode === 'loop') {
    // ว่าง = 0 (ใส่แค่นาทีหรือแค่ชั่วโมงก็ได้)
    const hours = String(f.loopHours ?? '').trim() === '' ? 0 : integer(f.loopHours, 0, 12, 'prodLoopHours', 'ใส่ชั่วโมงเป็นจำนวนเต็ม 0–12')
    const mins = String(f.loopMins ?? '').trim() === '' ? 0 : integer(f.loopMins, 0, 59, 'prodLoopMins', 'ใส่นาทีเป็นจำนวนเต็ม 0–59')
    const gap = hours * 60 + mins
    if (gap > 720) throw invalid('prodLoopHours', 'เว้นระหว่างคลิปได้ไม่เกิน 12 ชั่วโมง')
    return { count: 0, start: 'now', time: f.dailyTime || f.batchTime || '22:00', delayMin: gap, delayMax: gap }
  }
  throw invalid('prodModeBatch', 'เลือกแบบที่จะทำคลิป')
}

export function nextProductionStart(time, now = new Date()) {
  const d = new Date(now)
  const [h, m] = time.split(':').map(Number)
  d.setHours(h, m, 0, 0)
  if (d <= now) d.setDate(d.getDate() + 1)
  return d
}

/** นาที → "30 นาที" · "2 ชั่วโมง" · "1 ชั่วโมง 30 นาที" */
export function gapLabel(min) {
  const h = Math.floor(min / 60), m = min % 60
  return h ? `${h} ชั่วโมง${m ? ` ${m} นาที` : ''}` : `${m} นาที`
}

export function scheduleCopy(s, now = new Date()) {
  const amount = s.count ? `${s.count} คลิป` : 'ต่อเนื่องจนกดหยุด'
  const headline = s.start === 'daily' && s.count ? `ทุกวัน ${s.time} น. · วันละ ${amount}`
    : `${s.start === 'now' ? 'เริ่มตอนนี้' : `เริ่ม ${s.time} น.`} · ${amount}`
  const rest = !s.delayMax ? (s.count === 1 ? 'ทำคลิปเดียวแล้วหยุด' : 'ทำคลิปถัดไปต่อเลยทันทีที่คลิปก่อนเสร็จ')
    : `เว้น ${s.delayMin === s.delayMax ? gapLabel(s.delayMin) : `${s.delayMin}–${s.delayMax} นาที`} หลังทำแต่ละคลิปเสร็จ`
  const date = s.start === 'now' ? null : nextProductionStart(s.time, now)
  return { headline, detail: rest + (s.start === 'daily' && !s.count ? ' · ทำต่อจนกดหยุด ไม่เริ่มชุดใหม่ทุกวัน' : ''),
    firstStart: date ? `เริ่ม${date.toDateString() === new Date(now).toDateString() ? 'วันนี้' : 'พรุ่งนี้'} ${s.time} น.${s.start === 'daily' && s.count ? ' แล้วทำซ้ำทุกวัน' : ''}` : 'เริ่มเมื่อกดปุ่มด้านล่าง',
    action: s.start === 'daily' && s.count ? 'เปิดผลิตทุกวัน' : s.start !== 'now' ? 'ตั้งเวลาเริ่มผลิต' : `เริ่มผลิต${s.count ? ` ${amount}` : 'ต่อเนื่อง'}` }
}
