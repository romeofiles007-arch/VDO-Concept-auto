/**
 * ห้าม Chrome แปลหน้าเว็บที่ extension ขับอยู่ (Google Flow · ChatGPT) — ใส่ตั้งแต่หน้าเริ่มโหลด
 *
 * เจอจริงที่ Ebook Plus (ต.ค. 2026): เครื่องที่ตั้ง Chrome ให้แปลอังกฤษเป็นไทยอัตโนมัติ ("Translated to Thai")
 * หน้า Flow ถูกแปลทั้งหน้า — "Nano Banana" กลายเป็น "นาโน บานานา" ชื่อปุ่ม/เมนู/ไอคอนเปลี่ยน
 * ตัวขับที่อ่านข้อความบนปุ่มภาษาอังกฤษ (?hl=en) จึงหาปุ่มไม่เจอ แม้จะเปิดหน้าด้วย hl=en แล้วก็ตาม
 *
 * Chrome ไม่แปลหน้าที่ประกาศ translate="no" หรือ <meta name="google" content="notranslate">
 * ใส่ทั้งสองแบบ และเฝ้าไว้เผื่อหน้าเว็บวาด <html> ใหม่แล้วลบออก
 * หน้าที่ถูกแปลไปแล้วหายเองในงานถัดไป เพราะ background.js โหลด Flow/ChatGPT ใหม่ทุกงานอยู่แล้ว
 */
(() => {
  const html = document.documentElement
  if (!html) return
  const mark = () => {
    if (html.getAttribute('translate') !== 'no') html.setAttribute('translate', 'no')
    if (!html.classList.contains('notranslate')) html.classList.add('notranslate')
    if (!document.querySelector('meta[name="google"][content="notranslate"]')) {
      const meta = document.createElement('meta')
      meta.name = 'google'
      meta.content = 'notranslate'
      ;(document.head || html).appendChild(meta)
    }
  }
  mark()
  document.addEventListener('DOMContentLoaded', mark, { once: true })
  try {
    new MutationObserver(mark).observe(html, { attributes: true, attributeFilter: ['translate', 'class'] })
  } catch {
    /* ไม่มีตัวเฝ้าก็ยังกันได้จากการใส่ครั้งแรก */
  }
})()
