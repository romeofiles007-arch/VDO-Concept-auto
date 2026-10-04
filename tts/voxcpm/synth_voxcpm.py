"""
TTS worker VoxCPM2 — โคลนเสียงจากคลิปเสียงเรา (เสียงอ้างอิง + ข้อความที่พูดในคลิป) ไม่ต้องเทรน

ทดสอบเทียบกับ F5-TTS-THAI แล้ว (tts/eval): อ่านไทยผิดน้อยกว่าประมาณ 2 เท่า อ่านตัวเลข/ทศนิยม/คำย่อได้เอง
ไม่ต้องแปลงเป็นคำอ่านก่อน และไม่มีคำจากเสียงอ้างอิงหลุดเข้ามากลางประโยค

job:
{
  "model": "openbmb/VoxCPM2",
  "ref_wav": "path/ref.wav", "ref_text": "ข้อความที่พูดในคลิปอ้างอิง",
  "cfg_value": 2.0, "inference_timesteps": 10,
  "segments": [{"index": 0, "text": "...", "out": "x.wav"}]
}
สถานะพิมพ์เป็น JSON ทีละบรรทัด (loading / loaded / segment / done / error) เหมือน worker ตัวอื่น

ใช้:  tts/.venv-voxcpm/Scripts/python.exe tts/voxcpm/synth_voxcpm.py job.json
"""
import json
import os
import sys
import time
from pathlib import Path

# ไลบรารีพิมพ์ข้อความ/progress ลง stdout — แยก stdout จริงไว้ส่งสถานะ JSON ให้ Node อย่างเดียว
_STATUS = sys.stdout
sys.stdout = open(os.devnull, "w", encoding="utf-8")


def log(**kw):
    print(json.dumps(kw, ensure_ascii=False), file=_STATUS, flush=True)


def main():
    if len(sys.argv) < 2:
        log(event="error", message="ต้องระบุ job file")
        sys.exit(1)
    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    started = time.time()
    log(event="loading", engine="voxcpm2")
    try:
        import soundfile as sf
        import torch
        from voxcpm import VoxCPM
    except ImportError as exc:
        log(event="error", message=f"ยังไม่ได้ติดตั้ง VoxCPM2 — รัน scripts/setup-voxcpm.ps1 ({exc})")
        sys.exit(2)
    if not Path(job.get("ref_wav", "")).is_file():
        log(event="error", message=f"ไม่พบเสียงอ้างอิง: {job.get('ref_wav')}")
        sys.exit(2)

    torch.manual_seed(int(job.get("seed", 42)))
    model = VoxCPM.from_pretrained(job.get("model", "openbmb/VoxCPM2"), load_denoiser=False)
    sr = model.tts_model.sample_rate
    # อุ่นเครื่องด้วยเสียงอ้างอิงชุดเดียวกันก่อนประโยคจริง — ประโยคแรกหลังโหลดโมเดลมักเพี้ยน/มีเสียงแปลกปลอมนำหน้า
    try:
        model.generate(
            text="ทดสอบเสียงก่อนเริ่มอ่านจริง",
            prompt_wav_path=job["ref_wav"],
            prompt_text=job["ref_text"],
            reference_wav_path=job["ref_wav"],
            cfg_value=float(job.get("cfg_value", 2.0)),
            inference_timesteps=int(job.get("inference_timesteps", 10)),
        )
    except Exception:
        pass
    log(event="loaded", seconds=round(time.time() - started, 1))

    import numpy as np

    def tail_seconds(wav):
        """ช่วงเงียบท้ายไฟล์ — ต่ำกว่า 0.08 วิ = เสียงยังดังตอนจบ แปลว่าโมเดลหยุดก่อนพูดจบคำสุดท้าย"""
        hop = int(sr * 0.02)
        loud = [i for i in range(0, max(0, len(wav) - hop), hop) if 20 * np.log10(np.sqrt(np.mean(wav[i:i + hop] ** 2)) + 1e-9) > -40]
        return (len(wav) - (loud[-1] + hop)) / sr if loud else 0.0

    def fade_out(wav, ms=25):
        n = min(len(wav), int(sr * ms / 1000))
        wav = np.array(wav, dtype=np.float32, copy=True)
        if n:
            wav[-n:] *= np.linspace(1.0, 0.0, n, dtype=np.float32)
        return wav

    total = len(job["segments"])
    for seg in job["segments"]:
        out = Path(seg["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        try:
            # โมเดลตัดพยางค์สุดท้ายแบบสุ่ม (~1 ใน 3 ประโยค เช่น "เฉยๆ" เหลือ "เฉย") → ตรวจแล้วสร้างใหม่
            # สร้างใหม่ด้วยข้อความเดิม (ผลสุ่มต่างกันทุกรอบ) — ห้ามเติม "." ท้ายประโยค โมเดลอ่านจุดออกเสียงเป็นคำแปลก ("นัด")
            # ได้ไม่ครบทุกรอบ → เก็บรอบที่หางเงียบยาวที่สุด
            best, best_tail = None, -1.0
            for attempt, text in enumerate([seg["text"]] * 3):
                wav = model.generate(
                    text=text,
                    prompt_wav_path=job["ref_wav"],
                    prompt_text=job["ref_text"],
                    reference_wav_path=job["ref_wav"],
                    cfg_value=float(job.get("cfg_value", 2.0)),
                    inference_timesteps=int(job.get("inference_timesteps", 10)),
                    retry_badcase=True,
                )
                if wav is None or len(wav) == 0:
                    continue
                tail = tail_seconds(wav)
                if tail > best_tail:
                    best, best_tail = wav, tail
                if tail >= 0.08:
                    break
            if best is None:
                raise RuntimeError("ไม่มีเสียงออกมา")
            sf.write(str(out), fade_out(best), sr)
        except Exception as exc:  # หยุดทันทีเพื่อไม่ให้ได้เสียงขาดกลางคัน
            log(event="error", index=seg["index"], message=f"ประโยค {seg['index'] + 1}: {exc}")
            sys.exit(3)
        log(event="segment", index=seg["index"], total=total, seconds=round(time.time() - t0, 2))

    log(event="done", total=total, seconds=round(time.time() - started, 1))


if __name__ == "__main__":
    main()
