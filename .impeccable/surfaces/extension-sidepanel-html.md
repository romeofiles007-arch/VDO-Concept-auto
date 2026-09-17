---
version: 1
slug: "extension-sidepanel-html"
primary_target: "extension/sidepanel.html"
related_targets: []
---

# แผงข้างทีมสัตว์ทะเล

Scope: ปรับสีธีมและของตกแต่งแบนเนอร์เดิม · visitor mode: Operate
คงข้อความ การเลือกแผนก ภาพตัวละครและ polling 3 วินาที ไม่แตะ bridge หรือ pipeline

## Direction contract

THESIS: ทีมสร้างคลิปในสตูดิโอมหาสมุทร อ่านสถานะได้ก่อนชมฉาก ของตกแต่งบอกหน้าที่แผนก ไม่เพิ่มการ์ดหรือเครื่องมือใหม่

OWN-WORLD: น้ำทะเลเขียวอมฟ้า ทรายอุ่น พื้นเปลือกหอยในธีมสว่าง น้ำลึกกับทองทรายในธีมมืด ปุ่มหลักเป็นสีทะเล สีสถานะคงความหมายเดิม ฉากภาพ 3D ใหญ่เต็มหน้าต่างอยู่หลังทั้งแผง ไม่ใช่เฉพาะแบนเนอร์

STORY: เห็นงานและเวลาทันที กดสัตว์เพื่อดูแผนก ทั้งฉากใหญ่ แบนเนอร์ พื้นกล่องและสีปุ่มตามตัวละครที่แสดงเสมอ รวม idle/offline นักเขียนเป็นฉากเขียวทองกับกระดาษ นักวาดเป็นม่วงชมพูกับกองสีบีบหลายสี เสียงเป็นฟ้ากับไมค์ ตัดต่อเป็นส้มปะการังกับฟิล์ม การส่งต่องานใช้สถานะเดิม ไม่เพิ่ม polling

FIRST VIEWPORT: คงตรา แบนเนอร์ และแถวสัตว์เดิม แบนเนอร์สูงประมาณ 200px ตัวละคร 104px ทางซ้าย ข้อความกลาง พื้นที่ของตกแต่งแยกไว้ด้านล่างขวา รองรับ 360–450px ฉากมหาสมุทรติดเต็ม viewport ตามด้วยทราย/ปะการังรอบขอบ กล่องงานโปร่งใสเล็กน้อย 92% แต่ตัวหนังสือไม่วางบนภาพโดยตรง

FORM: ขยายสตูดิโอสัตว์ทะเลที่ผู้ใช้ยืนยัน ไม่เปลี่ยนโลกหรือโครงสร้างหน้า seed: not applicable — local extension, pinned ocean world

MOTION: อุปกรณ์ขยับไม่เกิน 2px/1deg บน CSS เมื่อทำงานหรือว่าง หยุดเมื่อซ่อน พ้นจอ offline หรือ reduced-motion ไม่มี animation loop ใน JavaScript

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
