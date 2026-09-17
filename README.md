# Youtube Free Animation Auto

ระบบทำคลิปการ์ตูน stick-figure อัตโนมัติ ตั้งแต่หัวข้อจนถึงไฟล์ MP4
อ้างอิงกติกาทั้งหมดจาก `extension/VDO Concept.txt` (Blueprint) (V3) — อยู่ในโฟลเดอร์ extension เพื่อให้แผงข้างอ่านได้

## ติดตั้ง (เครื่องใหม่)

ต้องมี: Windows · Chrome ที่ล็อกอิน ChatGPT และ Google Flow ไว้ · [Node.js](https://nodejs.org) · ffmpeg (`winget install Gyan.FFmpeg`)
ถ้าจะใช้เสียงในเครื่อง (เสียงไทย F5-TTS, เทรนเสียงตัวเอง, ถอดเสียง Whisper): การ์ดจอ NVIDIA + Python 3.10

1. ดับเบิลคลิก `ติดตั้งครั้งแรก.bat` — ลงตัวเชื่อม Chrome และถามว่าจะลงระบบเสียง (`tts\.venv` ~5GB) เลยไหม
2. Chrome → `chrome://extensions` → เปิด Developer mode → Load unpacked → เลือกโฟลเดอร์ `extension`
3. ปิดเปิด Chrome แล้วกดไอคอน Cartoon Auto

ทุกอย่างอยู่ในโฟลเดอร์นี้โฟลเดอร์เดียว ไม่ต้องมีโปรเจกต์อื่น · เสียงที่เทรนไว้อยู่ใน `tts/voices/<ชื่อเสียง>/` (model.pt + คลิปต้นแบบ)
คัดลอกโฟลเดอร์เสียงไปเครื่องอื่นได้ตรงๆ · เสียงส่วนตัวไม่ถูกแชร์ไปกับ git (`.gitignore`) — คนอื่นใช้เสียง Edge ได้ทันที หรือเทรนเสียงตัวเองในขั้นที่ 3

## ⚡ ทำคลิปอัตโนมัติ (กดครั้งเดียว)

พิมพ์หัวข้อ เลือกภาษาและความยาว กด **▶ ทำคลิปอัตโนมัติ** — ทำงานเป็นแผนกต่อกันจนได้ MP4:

| แผนก | ใช้ | ถ้าพลาด |
| --- | --- | --- |
| เขียนบท | ChatGPT | ลองใหม่ 3 ครั้ง, บทยาวผิดเป้ามากขอเขียนใหม่ |
| เสียงพากย์ | เสียงที่เลือกในขั้นที่ 3 | ลองใหม่ |
| กำกับภาพ | ChatGPT (Style/Character Bible + prompt ทีละ 40 ช็อต) | ขอช็อตที่ขาดต่อจนครบ |
| วาดภาพ | Google Flow Agent · Nano Banana 2 Lite · 0 credits | สั่งเฉพาะช็อตที่ขาดต่อจนครบ, หยุดเมื่อไม่ได้ภาพเพิ่ม 3 รอบติด |
| ตัดต่อ | ffmpeg ในเครื่อง | ลองใหม่ |

เสร็จแล้วมีหน้าต่างสำเร็จ + แจ้งเตือนบนเครื่อง (แม้ปิดแผงข้าง) · หยุดกลางทาง → กดอีกครั้งด้วยหัวข้อเดิม ทำต่อจากแผนกที่ค้าง
คำสั่งเดียวกันจาก terminal: `node pipeline/autopilot.mjs "หัวข้อ" --lang th --minutes 5`

## ทำทีละขั้นในแผงข้าง

1. **หัวข้อ + บทพากย์** — แผงสั่ง ChatGPT แล้วดึงคำตอบกลับมาเอง
2. **เสียง ภาพ วิดีโอ** — โปรแกรมในเครื่องเปิดเองและหยิบบทที่เขียนไว้ไปทำต่อ

ทุกขั้นทำผ่านหน้าเว็บ ChatGPT / Google Flow หรือรันในเครื่อง — ไม่ใช้ API (ยกเว้นเสียง Gemini ที่เลือกใช้เองได้)

## Pipeline

```
1_script    หัวข้อ + VO script        → 01_script/script_<slug>.txt
2_tts       script → เสียงพากย์       → 02_audio/voiceover.wav + durations.json
3_timecode  ความยาวจริง → timecode    → 03_timecode/*.{json,txt,srt} + 04_shotlist/slots.json
4_shotlist  slots → OUTPUT 5 ครบ      → 04_shotlist/agent_brief.txt
5_images    shot list → ภาพ           → 05_images/00_00_05.png ...
6_render    ภาพ + เสียง → MP4         → 06_render/<slug>.mp4
```

แต่ละขั้นอ่าน/เขียนไฟล์ล้วน ไม่มี state ในหน่วยความจำ → รันซ้ำขั้นไหนก็ได้โดยไม่ต้องเริ่มใหม่

## เริ่มใช้

```powershell
node scripts/check-setup.mjs                                  # ตรวจความพร้อม
powershell -ExecutionPolicy Bypass -File scripts\setup-tts.ps1 # ลง TTS (ครั้งเดียว)
node scripts/selftest.mjs                                      # ทดสอบขั้น 3+6 โดยไม่ต้องมี key
```

รันจริงทีละขั้น:

```powershell
node pipeline/2_tts.mjs my_topic
node pipeline/3_timecode.mjs my_topic
node pipeline/6_render.mjs my_topic --bgm assets\bgm.mp3
```

## สิ่งที่ต่างจาก Blueprint V3 โดยตั้งใจ

| Blueprint | ที่นี่ | เหตุผล |
|---|---|---|
| ผู้ใช้ฟังแล้วพิมพ์ timestamp เอง / รัน Whisper | คำนวณจากความยาวไฟล์เสียงตอน TTS | แม่น 100% ฟรี ไม่มี ASR error |
| สั่ง agent เปลี่ยนชื่อ shot ก่อนโหลด | extension ตั้งชื่อจากลำดับ shot ตอนเซฟ | ตัดขั้นที่พังง่ายที่สุดทิ้ง (เปิดคืนได้ด้วย --rename) |
| ตัดต่อใน DaVinci/CapCut | ffmpeg อ่านชื่อไฟล์ = timecode | deterministic รันซ้ำได้เหมือนเดิม |

## เลือกภาษา (ไทย / อังกฤษ)

ชื่อเรื่องกับ narration แยกภาษากันได้ — คู่ที่ใช้บ่อยคือชื่ออังกฤษ (ติด search) narration ไทย

ตั้งถาวรใน `config/project.config.json`:

```json
"language": "th",        // narration ที่จะเอาไปพากย์
"titleLanguage": "en"    // ชื่อเรื่องและหัวข้อ
```

หรือสั่งเฉพาะครั้งด้วย flag:

```powershell
node pipeline/1_script.mjs topics --title-lang th
node pipeline/1_script.mjs script 3 --lang en --minutes 12
```

ภาษาถูกบันทึกลง `01_script/meta.json` เพื่อให้ขั้นที่ 2 เลือก TTS engine ให้ถูก
(engine ไทย `f5-tts-thai` / อังกฤษ `chatterbox` — ถ้าตั้งไม่เข้าคู่กัน ขั้นที่ 2 จะเตือนก่อน gen)

รายละเอียดการเลือก stack: [docs/STACK.md](docs/STACK.md)
