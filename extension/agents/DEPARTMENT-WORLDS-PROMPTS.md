# ฉากและสีตามแผนก AI

สร้างด้วย built-in imagegen แบบแก้ภาพ ocean-world.png ที่ผู้ใช้ยืนยัน คงโลกและองค์ประกอบเดิม ไม่ใช้ API ขณะรัน extension ภาพทั้งหมดเป็น PNG 1024×1536 พร้อมฝัง prompt ใน metadata

| แผนก | ภาพ | Prompt ที่ใช้จริง |
|---|---|---|
| เต่า · ChatGPT · เขียวทอง | [ocean-chatgpt.png](<E:/Youtube Free animation Auto Claude/extension/agents/ocean-chatgpt.png>) | [prompt](<E:/Youtube Free animation Auto Claude/docs/design/ocean-chatgpt.prompt.txt>) |
| ปลาหมึก · Google Flow · ม่วงชมพู | [ocean-flow.png](<E:/Youtube Free animation Auto Claude/extension/agents/ocean-flow.png>) | [prompt](<E:/Youtube Free animation Auto Claude/docs/design/ocean-flow.prompt.txt>) |
| โลมา · เสียงพากย์ · ฟ้า | [ocean-voice.png](<E:/Youtube Free animation Auto Claude/extension/agents/ocean-voice.png>) | [prompt](<E:/Youtube Free animation Auto Claude/docs/design/ocean-voice.prompt.txt>) |
| ปู · ตัดต่อ · ส้มปะการัง | [ocean-edit.png](<E:/Youtube Free animation Auto Claude/extension/agents/ocean-edit.png>) | [prompt](<E:/Youtube Free animation Auto Claude/docs/design/ocean-edit.prompt.txt>) |

`html[data-dept]` เลือกภาพผ่าน `--world-image` และเลือกสีพื้น/ปุ่มตามธีมระบบ `studioHero.update()` ตั้งแผนกเดียวกับตัวละครที่แสดง ใช้ค่าจาก polling 3 วินาทีเดิม การกดเลือกแผนกมีอายุ 20 วินาทีตามพฤติกรรมเดิม
