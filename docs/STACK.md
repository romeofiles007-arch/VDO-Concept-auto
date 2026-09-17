# Stack ที่ล็อกแล้ว — Youtube Free Animation Auto

เครื่องเป้าหมาย: Windows 11 · RTX 4070 Ti SUPER (16GB VRAM) · Node 24 · ffmpeg 8.1

ทุกขั้นมี **ทางหลัก (A)** ที่นิ่ง และ **ทางสำรอง (B)** ที่ฟรี/ตรงตามสเปกเดิม
สลับได้ที่ `config/project.config.json` โดยไม่ต้องแก้โค้ด

---

## ขั้นที่ 1 — หัวข้อ + Script

| | ทาง | ใช้อะไร | ข้อดี | ข้อเสีย |
|---|---|---|---|---|
| **A (default)** | Claude API | `claude-opus-5` เขียน script, `claude-sonnet-5` งานย่อย | เสถียร, batch ได้, ไม่พังเวลาเว็บเปลี่ยน | ~$0.3–1/คลิป |
| B | Chrome Extension → ChatGPT web | MV3 + bridge server | ฟรี | ผิด ToS OpenAI, DOM เปลี่ยนบ่อย, ทำทีละคลิป |

Input: `extension/VDO Concept.txt` (Blueprint) (STAGE 1 → 5 หัวข้อ, STAGE 2 → script 1,800–2,500 คำ)
Output: `projects/<slug>/01_script/script_<slug>.txt` (narration ล้วน ตามกฎ OUTPUT 2)

## ขั้นที่ 2 — TTS ไทย/อังกฤษ (local)

| | โมเดล | หมายเหตุ |
|---|---|---|
| **A (default)** | **F5-TTS-THAI** (VIZINTZOR) | fine-tune ไทยโดยเฉพาะ · voice clone จาก ref 10 วิ · 16GB พอเหลือ |
| B | **Chatterbox Multilingual** (Resemble AI, MIT) | อังกฤษดีกว่า, ไทยพอใช้ · ใช้เมื่อคลิปมีอังกฤษปน |
| C | ElevenLabs API | คุณภาพไทยสูงสุด · ใช้เมื่อคลิปสำคัญจริง |

ต้องลง **Python 3.11** แยก venv (3.14 ที่มีอยู่ PyTorch ยังไม่รองรับ)

## ขั้นที่ 3 — Timecode ⭐ จุดที่ต่างจาก Blueprint

Blueprint V3 บอกให้ผู้ใช้ฟังแล้วพิมพ์ timestamp เอง / หรือรัน Whisper ถอดกลับ
**เราไม่ทำทั้งสองอย่าง** เพราะเราเป็นคนสร้างเสียงเอง จึงรู้ความยาวอยู่แล้ว

```
script → ซอยเป็น segment → TTS ทีละ segment → วัดความยาวไฟล์จริง
       → concat ด้วย ffmpeg → timecode สะสม = แม่น 100%
```

ได้ฟรีในขั้นเดียว: `timecode.json` · `timecode.txt` (format `[M:SS] ข้อความ`) · `subtitle.srt`
ไม่มี ASR error แบบในไฟล์ตัวอย่าง (`วิวัตถนาการ`, `กนกาย`, `break recharge`)

## ขั้นที่ 4 — Shot List (OUTPUT 5)

ทำด้วย Claude API จาก `timecode.json` + Blueprint 5.1/5.2/5.3
กติกาที่บังคับในโค้ด: shot 2.0–3.0 วิ (target 2.5) · filename = timecode · hook ทุก 15–30 วิ

## ขั้นที่ 5 — Gen ภาพ

| | ทาง | หมายเหตุ |
|---|---|---|
| **A (default)** | **Gemini API — image model (nano-banana)** | มี API จริง · lock ตัวละครด้วย reference image · ตั้งชื่อไฟล์เอง ไม่ต้องขอ agent เปลี่ยนชื่อ · ~$0.04/ภาพ → 40 ภาพ ≈ 50฿/คลิป |
| B | Google Flow Agent (browser automation) | ตรงตามสเปกเดิม · ต้อง Google AI Pro/Ultra · เปราะที่ขั้นเปลี่ยนชื่อ shot + download |

ทาง A ตัด step 5, 6, 7 ของสเปกเดิมทิ้งได้ทั้งหมด (ไม่ต้อง login/new project/เปลี่ยนชื่อ/โหลด)

## ขั้นที่ 6 — ตัดต่อ + Render

**ffmpeg ล้วน ไม่ใช้ AI** — เพราะชื่อไฟล์ = timecode อยู่แล้ว (กฎ 4 ของ Blueprint)
อ่านชื่อไฟล์ `00_00_05.png` → วางบน timeline ที่วินาที 5 → ต่อ voiceover + BGM (−18 ถึง −24 dB) → MP4 1080p 16:9

ผลลัพธ์ deterministic ทำซ้ำได้เป๊ะ ไม่ต้องรอ AI ไม่ต้องใช้ HyperFrame/DaVinci/CapCut

---

## ของที่ต้องติดตั้งเพิ่ม

- [ ] **Python 3.11** (สำหรับ venv ของ TTS) — https://www.python.org/downloads/release/python-3119/
- [ ] `ANTHROPIC_API_KEY` — https://console.anthropic.com
- [ ] `GEMINI_API_KEY` — https://aistudio.google.com/apikey
- [ ] (ถ้าใช้ทาง B) Google AI Pro/Ultra + Chrome ที่ login ค้างไว้

มีอยู่แล้ว: Node 24 · ffmpeg 8.1 · git · CUDA driver 610.62

---

## โครงสร้างโปรเจกต์

```
config/project.config.json     ← สวิตช์เลือกทาง A/B ทุกขั้น
pipeline/                      ← orchestrator (Node)
tts/                           ← Python venv + F5-TTS wrapper
bridge/                        ← local server (เฉพาะทาง B ขั้น 1)
extension/                     ← Chrome MV3 (เฉพาะทาง B ขั้น 1)
projects/<slug>/
  01_script/  02_audio/  03_timecode/  04_shotlist/  05_images/  06_render/
```
