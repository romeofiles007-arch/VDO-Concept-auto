/**
 * ความคืบหน้ารวมของทำคลิปอัตโนมัติ (0–100%) + เวลาที่น่าจะเหลือของขั้นปัจจุบัน
 *
 * น้ำหนักแต่ละแผนกตามเวลาที่ใช้จริงโดยประมาณ (วาดภาพนานสุด)
 * แผนกที่รู้จำนวนชิ้นงาน (เสียง n/N ประโยค · prompt n/N ช็อต · ภาพ n/N ใบ) ใช้สัดส่วนจริง
 * แผนกที่ไม่มีตัวเลข (เขียนบท · ตัดต่อ) ประมาณจากเวลาที่ผ่านไปเทียบเวลาปกติ ไม่เกิน 90%
 */
export const WEIGHTS = { topic: 4, script: 10, voice: 14, art: 18, images: 46, edit: 8 }
export const LABELS = { topic: 'คิดหัวข้อ', script: 'เขียนบท', voice: 'เสียงพากย์', art: 'กำกับภาพ', images: 'วาดภาพ', edit: 'ตัดต่อ' }
const UNITS = { voice: 'ประโยค', art: 'ช็อต', images: 'ภาพ' }

/** สัดส่วนงานของแผนกเดียว 0–1 */
export function deptFraction(d, now = Date.now()) {
  if (!d) return 0
  if (d.status === 'done') return 1
  if (d.status !== 'working') return 0
  const p = d.progress
  if (p?.total > 0) return Math.max(0, Math.min(0.99, p.done / p.total))
  if (d.startedAt && d.expectSec) return Math.min(0.9, (now - d.startedAt) / 1000 / d.expectSec)
  return 0.05
}

export function autopilotProgress(st, now = Date.now()) {
  if (!st?.departments) return null
  const ids = Object.keys(WEIGHTS).filter((id) => st.departments[id] || (id === 'topic' && st.topic))
  const deps = { ...st.departments, ...(st.topic && !st.departments.topic && { topic: { status: 'done' } }) }
  const totalWeight = ids.reduce((n, id) => n + WEIGHTS[id], 0) || 1
  const doneWeight = ids.reduce((n, id) => n + WEIGHTS[id] * deptFraction(deps[id], now), 0)
  const percent = st.status === 'done' ? 100 : Math.min(99, Math.floor((doneWeight / totalWeight) * 100))

  const current = st.current ?? null
  const d = current ? deps[current] : null
  const fraction = deptFraction(d, now)
  let etaSec = null
  if (d?.status === 'working' && d.startedAt) {
    const elapsed = (now - d.startedAt) / 1000
    // นับจากตัวเลขจริงเมื่อทำไปแล้วพอสมควร · ถ้าไม่มีตัวเลข ใช้เวลาปกติของแผนก
    if (d.progress?.total > 0 && fraction >= 0.05 && elapsed > 20) etaSec = Math.round((elapsed * (1 - fraction)) / fraction)
    else if (d.expectSec) etaSec = Math.max(0, Math.round(d.expectSec - elapsed))
  }
  const step = current ? ids.indexOf(current) + 1 : null
  const unit = UNITS[current]
  const count = d?.progress?.total > 0 ? `${d.progress.done}/${d.progress.total}${unit ? ` ${unit}` : ''}` : ''
  return {
    percent,
    status: st.status,
    current,
    label: current ? LABELS[current] : null,
    step,
    steps: ids.length,
    count,
    etaSec,
    departments: Object.fromEntries(ids.map((id) => [id, Math.round(deptFraction(deps[id], now) * 100)])),
  }
}

/** "~12 นาที" / "~40 วินาที" */
export function formatEta(sec) {
  if (sec == null) return ''
  if (sec < 60) return `~${Math.max(5, Math.round(sec / 5) * 5)} วินาที`
  const min = Math.round(sec / 60)
  return min >= 60 ? `~${Math.floor(min / 60)} ชม. ${min % 60} นาที` : `~${min} นาที`
}
