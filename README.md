# Youtube Free Animation Auto

ระบบทำคลิปการ์ตูน stick-figure อัตโนมัติ ตั้งแต่หัวข้อจนถึงไฟล์ MP4
อ้างอิงกติกาทั้งหมดจาก `Cartoon_Storytelling_Blueprint.txt` (V3)

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

รายละเอียดการเลือก stack: [docs/STACK.md](docs/STACK.md)
