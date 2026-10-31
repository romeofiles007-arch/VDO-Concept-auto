/**
 * กฎของแพ็กเกจลูกค้า — ใช้ร่วมกันระหว่างตัวสร้างแพ็กเกจ (scripts/build-package.mjs)
 * และตัวอัปเดตของเครื่องที่ติดตั้งจาก zip (bridge/update-package.js) ให้สองทางได้ไฟล์ชุดเดียวกันเสมอ
 */

/** ไฟล์ที่ git ติดตาม แต่ไม่ควรไปถึงลูกค้า */
export const EXCLUDE = [
  /^\.impeccable\//,
  /^docs\/design\//,
  /^scripts\/(test-|preview-|selftest|build-icons|build-package|build-setup)/,
  /^\.claude\//,
  /^Ex sample audio/,
  /^DESIGN\.md$/,
  /^PRODUCT\.md$/,
  /^extension\/agents\/.*PROMPT.*\.md$/,
  /(^|\/)desktop\.ini$/i, // ไฟล์ตกแต่งโฟลเดอร์ของ Windows
]

/** ไฟล์ข้อมูลที่ git ติดตาม แต่เป็นของเรา — ลูกค้าได้ค่าว่างแทน */
export const RESET = {
  'projects/topics.json': '[]\n',
  'projects/_topic_history.json': '[]\n',
}

/** ไฟล์การตั้งค่าของเรา — ลูกค้าได้เป็น default.config.json (ผ่าน customerDefaults) ไม่ใช่ไฟล์นี้ */
export const USER_CONFIG = 'config/project.config.json'
export const DEFAULT_CONFIG = 'config/default.config.json'

export const shipsToCustomer = (rel) => !EXCLUDE.some((re) => re.test(rel))

/**
 * ของลูกค้าที่ตัวอัปเดตห้ามแตะ — ค่าที่ตั้งเอง, key, งานคลิป, เสียงที่ทำไว้, โปรแกรมที่แถม
 * projects/ เขียนได้เฉพาะไฟล์ที่ลูกค้ายังไม่มี (เช่นไฟล์ข้อมูลตัวใหม่)
 */
const PROTECTED = [
  /^\.env$/,
  /^config\/project\.config\.json$/,
  /^runtime\//,
  /^tts\/voices\//,
  /^bridge\/(jobs.*\.json|bridge\.log)$/,
  /^VERSION\.json$/,
  /^\.git\//,
]
export const isProtected = (rel) => PROTECTED.some((re) => re.test(rel))
export const isCustomerData = (rel) => rel.startsWith('projects/')

/** ค่าการตั้งค่าของเรา → ค่าเริ่มต้นของลูกค้า: ล้างสิ่งที่ผูกกับบัญชีของเรา และเปิดเฉพาะของที่ใช้ได้ทันทีโดยไม่ต้องมี key */
export function customerDefaults(config) {
  const c = structuredClone(config)
  if (c.tts?.elevenlabs) Object.assign(c.tts.elevenlabs, { voiceId: '', voiceName: '' })
  // เสียงที่โคลนไว้ไม่ได้ติดไปด้วย → ลูกค้าเริ่มที่เสียง Edge ซึ่งใช้ได้ทันที
  if (c.tts) c.tts.engine = 'edge'
  if (c.clips) c.clips.provider = 'off' // Kie มีค่าใช้จ่าย — ให้ลูกค้าเปิดเองเมื่อมี key
  return c
}

/** ไฟล์ที่ cmd.exe / PowerShell 5 ต้องอ่านได้ — คืนรายการปัญหา (ว่าง = ผ่าน) */
export function installerProblems(read) {
  const bad = []
  for (const bat of ['ติดตั้งครั้งแรก.bat', 'เปิดโปรแกรม.bat', 'ปิดโปรแกรม.bat']) {
    const buf = read(bat)
    if (!buf) bad.push(`ไม่มี ${bat}`)
    // cmd.exe อ่าน .bat ที่ขึ้นบรรทัดแบบ LF ผิด (.gitattributes บังคับ CRLF ไว้แล้ว — กันไว้อีกชั้น)
    else if (/(^|[^\r])\n/.test(buf.toString('latin1'))) bad.push(`${bat} ไม่ได้ขึ้นบรรทัดแบบ CRLF`)
  }
  // ตัวติดตั้งหลักต้องเป็น ASCII ล้วน — ภาษาไทยใน .bat ทำให้ cmd บางรุ่นรันคำสั่งเพี้ยน (ข้อความไทยอยู่ใน bootstrap.ps1 / install.mjs)
  if (read('ติดตั้งครั้งแรก.bat')?.some((b) => b > 0x7f)) bad.push('ติดตั้งครั้งแรก.bat มีอักษรที่ไม่ใช่ ASCII')
  const ps = read('native/bootstrap.ps1')
  if (!ps || !(ps[0] === 0xef && ps[1] === 0xbb && ps[2] === 0xbf)) bad.push('native/bootstrap.ps1 ต้องเป็น UTF-8 แบบมี BOM (PowerShell 5 อ่านภาษาไทยเพี้ยน)')
  for (const f of ['native/install.mjs', 'native/host.mjs', 'native/extension-id.txt', 'setup.exe']) if (!read(f)) bad.push(`ไม่มี ${f}`)
  return bad
}

/** https://github.com/owner/repo(.git) หรือ git@github.com:owner/repo.git → https://github.com/owner/repo */
export function githubRepoUrl(remote) {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(remote ?? '').trim())
  return m ? `https://github.com/${m[1]}/${m[2]}` : null
}
