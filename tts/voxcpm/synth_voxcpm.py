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
import math
import os
import re
import sys
import time
from pathlib import Path

# จำนวนเสียงที่ต้องพูดของข้อความ — ไม่นับช่องว่าง/เครื่องหมาย · ตัวเลขนับ 3 (อ่านออกเสียงยาวกว่าตัวอักษร เช่น "3" = "สาม")
_SILENT = re.compile(r"[\s.…,!?\"'“”‘’()\[\]\-–—:;]")


def spoken_units(text):
    text = _SILENT.sub("", text)
    return len(text) + 2 * sum(ch.isdigit() for ch in text)


# ยาวเกินคาดกี่เท่าถึงถือว่า "พูดไม่หยุด" (เสียงมั่วต่อท้าย) แล้วสร้างใหม่ — เผื่อจังหวะช้า/เว้นที่ "..." ไว้แล้ว
OVERRUN_RATIO = 1.6
OVERRUN_SLACK_S = 0.5
# เพดานความยาวที่ให้โมเดลสร้างได้ (เท่าของความยาวที่คาด) — ตัดเสียงมั่วเร็วขึ้น ไม่เปลืองเวลา (การ์ดช้าอย่าง 1080 Ti ต่างกันมาก)
MAX_LEN_RATIO = 2.2


def cap_pauses(wav, sr, max_pause=0.35, keep=0.3, threshold_db=-40.0, hop_s=0.02):
    """ช่วงเงียบกลางประโยคที่ยาวเกิน max_pause วิ → เหลือ keep วิ (หัว/ท้ายไฟล์ไม่แตะ — 2_tts ตัดเอง)

    VoxCPM2 ชอบหยุดกลางประโยคเอง 0.6–1.7 วิ แม้ไม่มีเครื่องหมาย ("เทียนจี้กำลังจะ ... แพ้พนัน") ฟังเป็น "มาๆ หยุดๆ"
    ElevenLabs หยุดกลางประโยคไม่เกิน ~0.55 วิ (ส่วนใหญ่ 0.3–0.4 ตรงช่องว่าง) — วัด 27 พ.ย. 2026 บทเดียวกัน 18 ประโยค
    ช่วงหยุดตรง "..." ในบท voxcpm.mjs ต่อให้ทีหลัง (0.28 วิ) ไม่โดนตัดตรงนี้
    """
    import numpy as np

    wav = np.asarray(wav, dtype=np.float32)
    if not max_pause or len(wav) == 0:
        return wav
    hop = max(1, int(sr * hop_s))
    n = len(wav) // hop
    if n < 3:
        return wav
    rms = np.sqrt(np.mean(wav[: n * hop].reshape(n, hop) ** 2, axis=1)) + 1e-9
    peak = float(np.max(np.abs(wav))) + 1e-9
    silent = 20 * np.log10(rms / peak) < threshold_db
    loud = np.flatnonzero(~silent)
    if len(loud) < 2:
        return wav
    keep_n = int(keep * sr)
    pieces, pos, i, last = [], 0, int(loud[0]), int(loud[-1])
    while i <= last:
        if not silent[i]:
            i += 1
            continue
        j = i
        while j <= last and silent[j]:
            j += 1
        if (j - i) * hop > max_pause * sr:
            # เก็บความเงียบครึ่งหนึ่งไว้ฝั่งละข้าง ตัดตรงกลาง (ตรงกลางเงียบสนิท ไม่มีเสียงคลิก)
            pieces.append(wav[pos: i * hop + keep_n // 2])
            pos = j * hop - (keep_n - keep_n // 2)
        i = j
    pieces.append(wav[pos:])
    return np.concatenate(pieces)

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
    # 1 step ของโมเดล = เสียงกี่วินาที (VoxCPM2 ≈ 0.16 วิ) — ใช้แปลงความยาวที่คาดเป็นเพดาน max_len
    tm = model.tts_model
    try:
        step_seconds = tm.patch_size * tm.chunk_size / tm._encode_sample_rate
    except (AttributeError, TypeError, ZeroDivisionError):
        step_seconds = 0.16
    # ความเร็วพูดของเสียงต้นแบบ (หน่วยเสียง/วินาที) → คาดความยาวของแต่ละประโยค
    ref_seconds = sf.info(job["ref_wav"]).duration
    units_per_second = spoken_units(job.get("ref_text", "")) / ref_seconds if ref_seconds > 0 else 0
    if units_per_second <= 0:
        units_per_second = 11.0  # ค่ากลางของเสียงเล่าเรื่องไทย
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
            # อีกแบบที่เจอ: โมเดลไม่หยุดตอนพูดจบ พูดคำมั่วต่อท้ายจนยาว 2–3 เท่า (~1 ใน 3 ประโยค ทดสอบ 27 พ.ย. 2026)
            # → จำกัดความยาวที่สร้างได้ และสร้างใหม่ถ้ายาวเกินที่คาดจากความเร็วพูดของเสียงต้นแบบ
            # ได้ไม่ครบทุกรอบ → เก็บรอบที่ความยาวพอดีก่อน แล้วค่อยดูหางเงียบ
            expected = max(0.8, spoken_units(seg["text"]) / units_per_second)
            limit = expected * OVERRUN_RATIO + OVERRUN_SLACK_S
            max_len = int(math.ceil(expected * MAX_LEN_RATIO / step_seconds)) + 10
            best, best_key = None, None
            for attempt in range(4):
                wav = model.generate(
                    text=seg["text"],
                    prompt_wav_path=job["ref_wav"],
                    prompt_text=job["ref_text"],
                    reference_wav_path=job["ref_wav"],
                    cfg_value=float(job.get("cfg_value", 2.0)),
                    inference_timesteps=int(job.get("inference_timesteps", 10)),
                    max_len=max_len,
                    # ตรวจความยาวเองด้านบน (เกณฑ์ของ voxcpm หลวมถึง 6 เท่าต่อ token จับเคสนี้ไม่ได้)
                    retry_badcase=False,
                )
                if wav is None or len(wav) == 0:
                    continue
                # หยุดกลางประโยคนานเกิน → ย่อก่อนวัดความยาว (ไม่งั้นรอบที่แค่หยุดนานจะถูกนับว่า "ยาวเกิน" แล้วสร้างใหม่เปล่าๆ)
                wav = cap_pauses(wav, sr, job.get("max_pause", 0.35))
                tail = tail_seconds(wav)
                seconds = len(wav) / sr
                fits, ends = seconds <= limit, tail >= 0.08
                key = (fits, ends, -abs(seconds - expected))
                if best_key is None or key > best_key:
                    best, best_key = wav, key
                if fits and ends:
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
