/**
 * ป้ายเจ้าของแท็บ ChatGPT / Google Flow — กันสองระบบ (ธรรมะ · Cartoon · ตำนานจีน · Ebook) ที่ติดตั้งในโปรไฟล์ Chrome เดียวกัน
 * ใช้แท็บเดียวกันแล้วอ่านคำตอบของกันและกัน (เจอจริง 23 พ.ย. 2026: ธรรมะ Auto ได้บทและ shot list เรื่องนักบินอวกาศ
 * ของ Cartoon Auto ไปทั้งก้อน เพราะสองระบบส่ง prompt ลงแท็บ ChatGPT แท็บเดียวกัน)
 *
 * ป้ายเก็บใน sessionStorage ของหน้าเว็บ: อยู่กับแท็บนั้น รอดการโหลดหน้าใหม่ในเว็บเดียวกัน และทุก extension อ่านได้
 * (extension มองไม่เห็นข้อมูลของกันและกัน แต่เห็นหน้าเว็บเดียวกัน) · ป้ายของระบบอื่นที่ไม่ต่ออายุเกิน CLAIM_TTL_MS = ว่างแล้ว
 * แท็บที่ระบบอื่นถือป้ายอยู่ → เปิดแท็บของตัวเองแทน (เสียแค่แท็บเพิ่มหนึ่งแท็บ ไม่แย่งงานกัน)
 *
 * ไฟล์นี้ต้องเหมือนกันทุกระบบ — แก้ที่ไหนให้แก้ทุก repo (buddha-Content · VDO-Concept-auto · china)
 */
export const CLAIM_KEY = '__autoBridgeTabOwner'
export const CLAIM_TTL_MS = 20 * 60_000
export const CLAIM_REFRESH_MS = 60_000

export function createTabClaims({ scripting, id, name = '', now = () => Date.now(), settleMs = 500 }) {
  const run = async (tabId, func, args = []) => {
    const [result] = await scripting.executeScript({ target: { tabId }, func, args }).catch(() => [])
    return result?.result
  }
  /** ป้ายบนแท็บ · อ่านไม่ได้ (หน้ายังโหลด/ถูกพักไว้) = ไม่มีป้าย */
  const read = (tabId) =>
    run(tabId, (key) => {
      try { return JSON.parse(sessionStorage.getItem(key) || 'null') } catch { return null }
    }, [CLAIM_KEY])
  const write = (tabId) =>
    run(tabId, (key, value) => {
      try { sessionStorage.setItem(key, value); return true } catch { return false }
    }, [CLAIM_KEY, JSON.stringify({ id, name, at: now() })])

  /** ป้ายนี้เป็นของระบบอื่นที่ยังทำงานอยู่ไหม */
  const foreign = (claim) => !!claim?.id && claim.id !== id && now() - Number(claim.at || 0) < CLAIM_TTL_MS

  /** เหลือเฉพาะแท็บที่ไม่มีระบบอื่นถืออยู่ */
  async function free(tabs) {
    const owners = await Promise.all(tabs.map((t) => read(t.id)))
    return tabs.filter((_, i) => !foreign(owners[i]))
  }

  /**
   * ติดป้ายของเรา แล้วอ่านซ้ำหลังรอสักครู่ — ระบบอื่นเขียนทับในช่วงเดียวกัน (คนเขียนทีหลังได้แท็บ) → false ให้ไปหาแท็บอื่น
   * อ่านป้ายไม่ได้เลย (เขียนไม่ลง) → ถือว่าได้ ไม่ให้งานล้มเพราะเรื่องนี้
   */
  async function claim(tabId) {
    if (foreign(await read(tabId))) return false
    await write(tabId)
    await new Promise((r) => setTimeout(r, settleMs))
    const after = await read(tabId)
    return !after?.id || after.id === id
  }

  /** ต่ออายุป้ายระหว่างทำงาน (ไม่ทับป้ายของระบบอื่น) */
  async function touch(tabId) {
    if (!foreign(await read(tabId))) await write(tabId)
  }

  /** งานจบ → ถอดป้ายของเรา (ไม่แตะป้ายของระบบอื่น) */
  const release = (tabId) =>
    run(tabId, (key, mine) => {
      try {
        const c = JSON.parse(sessionStorage.getItem(key) || 'null')
        if (c?.id === mine) sessionStorage.removeItem(key)
      } catch {}
    }, [CLAIM_KEY, id])

  return { read, foreign, free, claim, touch, release }
}
