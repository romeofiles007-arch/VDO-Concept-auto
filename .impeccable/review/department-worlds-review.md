# ผลตรวจฉากและสีตาม AI agent

Verdict: ผ่านขอบเขตที่ขอ — ตรวจด้วยข้อมูลจำลองที่เสิร์ฟ HTML/CSS/JS จริง ไม่ได้ reload Chrome extension ให้ผู้ใช้

## ภาพและปฏิสัมพันธ์

- ตรวจภาพจริงทั้ง 4 แผนก: เต่า/เขียวทอง, ปลาหมึก/ม่วงชมพู, โลมา/ฟ้า, ปู/ส้มปะการัง ภาพคงโลกเปลือกหอยและทางเดินทรายเดิม เปลี่ยนอุปกรณ์ตามอาชีพ ไม่มีสัตว์ซ้ำ
- ตรวจ DOM ครบ 4 แผนก × light/dark; html[data-dept], hero.department และ URL ภาพ body::before ตรงกัน
- กดเลือกปลาหมึกจากแผนกตัดต่อแล้วฉากตามปลาหมึก ตรวจส่งต่องาน images → edit แล้วฉากตามปู
- waiting/idle/offline เมื่อเลือกโลมายังคงฉากโลมา; reduced-motion ทำให้ animationName เป็น none
- ขนาด 360 และ 450px ไม่มี horizontal overflow; แถวปุ่มและข้อความห่อบรรทัดได้

## หลักฐาน

ภาพสดใน projects/_previews/agents/: dept-chatgpt-dark-450.jpg, dept-flow-dark-360.jpg, dept-voice-light-450.jpg, dept-edit-light-360.jpg

node --check extension/sidepanel.js ผ่าน; node scripts/test-ocean-theme.mjs ผ่าน รวม contrast ≥4.5:1 สำหรับข้อความทั้ง 8 ชุดสีบน bg/panel/pick และพื้น panel 92% ทับภาพดำ/ขาวกรณีแย่ที่สุด

Polling ยังคง 3 วินาที; การจำลองซ่อนรายงาน hiddenRequests:0 และ roster nodes:4 ไม่เพิ่ม loop ภาพเคลื่อนไหว ไม่อ่านค่าลับ ไม่เปลี่ยน bridge/pipeline

## ข้อจำกัดขอบเขต

Detector ตรวจครั้งเดียวพบ 70 รายการ warning/advisory รวมสี/ขนาดที่ catalog ไม่ครอบคลุม และการตกแต่งปุ่ม/แถบเดิม ไม่ได้อ้างว่าทั้งหน้าไม่มีคำเตือน งานนี้คงโครงสร้างและพฤติกรรมเดิม ไม่ขยายไปแก้เงาปุ่ม/ฟอนต์/เครื่องหมายที่ไม่เกี่ยวข้อง บันทึก token ของพื้นแผนกใหม่ใน DESIGN.md แล้ว

PNG ใหม่ทั้ง 4 ภาพฝัง exact prompt ใน metadata และเก็บ prompt ต้นฉบับใน docs/design/ocean-{id}.prompt.txt; โหมด built-in imagegen
