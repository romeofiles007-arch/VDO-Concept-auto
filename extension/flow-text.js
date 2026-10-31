/**
 * ตัวช่วยอ่านหน้า Google Flow ให้ทนต่อหน้าที่ถูกแปล / หน้ารุ่นใหม่ — โหลดก่อน content-flow-agent.js
 * แยกเป็นไฟล์ล้วน (ไม่แตะ chrome.*) เพื่อให้ scripts/test-flow-text.mjs ทดสอบได้ในเครื่อง
 *
 * เจอจริงที่ Ebook Plus (ต.ค. 2026): เครื่องที่ตั้ง Chrome ให้แปลอังกฤษเป็นไทยอัตโนมัติ
 * "Nano Banana 2 Lite" → "นาโน บานานา 2 Lite" · บางบัญชี Flow ก็แสดงชื่อรุ่นเป็นไทยเอง
 * no-translate.js กันการแปลไว้แล้ว ตัวนี้เป็นทางสำรองเมื่อยังหลุดมา
 */
;(() => {
  const THAI = /[฀-๿]/

  /**
   * ชื่อรุ่นแบบไม่สนภาษา: แปลงคำไทยที่รู้จักเป็นอังกฤษ ตัดอีโมจิ/ไอคอน/เครื่องหมาย แล้วเหลือคำคั่นด้วยช่องว่างเดียว
   * ไอคอนที่นำหน้า (อีโมจิ · เครื่องหมายถูกของรุ่นที่เลือก) ตัดทิ้งโดยเริ่มอ่านที่ "nano banana"
   * เหลือคำไทยที่ไม่รู้จักในชื่อรุ่น → คืน '' (ไม่เดา) เพราะเลือกรุ่นผิดอาจกินเครดิต
   */
  function modelKey(s) {
    let k = String(s ?? '')
      .toLowerCase()
      .replace(/arrow_drop_down/g, ' ')
      .replace(/นาโน/g, ' nano ')
      .replace(/บานาน่า|บานานา|บะนานา/g, ' banana ')
      .replace(/โปร/g, ' pro ')
      .replace(/ไลต์|ไลท์/g, ' lite ')
      .replace(/nano\s*banana/g, 'nano banana')
    const at = k.indexOf('nano banana')
    if (at > 0) k = k.slice(at)
    if (THAI.test(k)) return ''
    return k.replace(/[^a-z0-9.]+/g, ' ').trim()
  }

  /**
   * ป้ายบนหน้า (label) เป็นรุ่นเดียวกับที่ต้องการ (wanted) ไหม — เทียบทั้งคำ: "2" ≠ "2.1" · "Pro" ≠ "2 Lite"
   * รุ่นที่ไม่ใช่ Nano Banana ยังเทียบแบบเดิมได้ (ตัดคำแรกที่เป็นไอคอนทิ้ง)
   */
  function sameModel(label, wanted) {
    const want = modelKey(wanted)
    if (!want) return false
    if (modelKey(label) === want) return true
    return modelKey(String(label ?? '').trim().replace(/^\S+\s/, '')) === want
  }

  const isNanoBanana = (s) => modelKey(s).startsWith('nano banana')

  /** ข้อความของปุ่ม/รายการ โดยไม่เอาชื่อไอคอน (ชื่อไอคอนถูก Chrome แปลได้ เช่น arrow_drop_down) */
  const ICON = 'mat-icon, .material-icons, .material-symbols-outlined, .google-symbols, [class*="material-symbols"]'
  function labelText(el) {
    if (!el) return ''
    let s = el.innerText ?? el.textContent ?? ''
    if (el.querySelectorAll) for (const icon of el.querySelectorAll(ICON)) {
      const t = icon.innerText ?? icon.textContent ?? ''
      if (t) s = s.replace(t, ' ')
    }
    return s.replace(/\s+/g, ' ').trim()
  }

  /** Chrome แปลหน้านี้ไปแล้ว — ใส่คลาส translated-ltr / translated-rtl ที่ <html> */
  const pageTranslated = (doc = document) => /\btranslated-(ltr|rtl)\b/.test(doc.documentElement?.className || '')

  const TRANSLATED_HINT =
    'หน้า Google Flow ถูก Chrome แปลเป็นภาษาไทยอยู่ (แถบ "Translated to Thai") ชื่อปุ่ม/รุ่นจึงเปลี่ยน — ' +
    'กดไอคอนแปลภาษาที่ช่องที่อยู่ของ Chrome เลือก "แสดงต้นฉบับ" และ "ไม่แปลเว็บไซต์นี้" แล้วสั่งใหม่'

  /**
   * ปิดเมนู/แผงที่เปิดอยู่ด้วย Escape — หน้า Flow รุ่นใหม่ (ต.ค. 2026) ปิดเมนูเมื่อ Escape ส่งถึงตัว [role="menu"] เอง
   * ส่งระดับ document อย่างเดียวไม่ปิด จึงส่งทั้งสองทาง แล้วกด backdrop (ตรวจกับหน้าจริงที่ Ebook Plus แล้ว)
   * documentToo / backdrop = false เมื่ออยากปิดแค่เมนู ไม่ให้แผงตั้งค่าที่เปิดอยู่ปิดตามไปด้วย
   */
  function escapeMenus(doc = document, { documentToo = true, backdrop = true } = {}) {
    const esc = () => new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true })
    for (const menu of doc.querySelectorAll('[role="menu"]')) menu.dispatchEvent(esc())
    if (documentToo) doc.dispatchEvent(esc())
    if (backdrop) doc.querySelector('.cdk-overlay-backdrop')?.click()
  }

  /**
   * รายการเมนูที่เปิดค้างอยู่ไม่ใช่เมนูโมเดล (เช่นเมนูของภาพ · ตัวเลือกสื่อ) — ให้ปิดด้วย Escape แล้วทำต่อ
   * ห้ามกดรายการใดในเมนูนั้น · labels = ข้อความของรายการที่มองเห็น
   */
  const strayMenu = (labels) => labels.length > 0 && !labels.some(isNanoBanana)

  globalThis.CartoonFlowText = { modelKey, sameModel, isNanoBanana, labelText, pageTranslated, TRANSLATED_HINT, escapeMenus, strayMenu }
})()
