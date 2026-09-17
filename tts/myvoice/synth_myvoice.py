"""
TTS worker เสียงของเราเอง — ใช้โมเดล F5-TTS-THAI ที่ fine-tune ไว้ในโปรเจกต์ Copy My Voice

รัน job ชุดเดียวกับ tts/synth.py (โหลดโมเดลครั้งเดียว สังเคราะห์ทีละ segment)
แต่เพิ่มของที่ Copy My Voice ทำไว้ดี:
  - เลือกคลิปต้นแบบให้เข้ากับจังหวะของแต่ละประโยค ตามอารมณ์ที่เลือก (prosody_match.py)
  - ซอยประโยคยาวเป็นวลี แล้วต่อด้วย crossfade
  - แปลงคำอังกฤษเป็นคำอ่านไทยจากพจนานุกรม + g2p ในเครื่อง (ไม่เรียก LLM/API)

job เพิ่มเติมจาก synth.py:
{
  "ckpt": "path/model.pt", "vocab": "path/vocab.txt",
  "references": "tts/voices/my_voice/selections.json",   # file ในนี้อ้างอิงจากโฟลเดอร์ของไฟล์ json
  "emotion": "calm" | "excited" | "serious" | "soft",
  "speed": 1.0, "nfe_step": 32, "cfg_strength": 2.0, "transliterate": true
}

ใช้:  tts/.venv/Scripts/python.exe tts/myvoice/synth_myvoice.py job.json
"""
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# f5_tts_th พิมพ์ข้อความ debug ลง stdout เยอะมาก — แยก stdout จริงไว้ส่งสถานะ JSON ให้ Node อย่างเดียว
_STATUS = sys.stdout
sys.stdout = open(os.devnull, "w", encoding="utf-8")


def log(**kw):
    print(json.dumps(kw, ensure_ascii=False), file=_STATUS, flush=True)


def load_references(path: str) -> dict:
    ref_file = Path(path).resolve()
    sels = json.loads(ref_file.read_text(encoding="utf-8"))
    for items in sels.values():
        for it in items:
            it["file"] = str((ref_file.parent / it["file"]).resolve())
    return sels


def main():
    if len(sys.argv) < 2:
        log(event="error", message="ต้องระบุ job file")
        sys.exit(1)
    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))

    started = time.time()
    log(event="loading", engine="my-voice")
    try:
        import soundfile as sf
        from f5_tts_th.utils_infer import load_model, load_vocoder
        from prosody_match import generate_long
        from transliterate import transliterate_text
    except ImportError as exc:
        log(event="error", message=f"python ที่ใช้ไม่มี f5_tts_th — รัน scripts/setup-tts.ps1 ก่อน ({exc})")
        sys.exit(2)

    for key in ("ckpt", "vocab", "references"):
        if not Path(job.get(key, "")).is_file():
            log(event="error", message=f"ไม่พบไฟล์ {key}: {job.get(key)}")
            sys.exit(2)

    # สเปกเดียวกับที่ Copy My Voice ใช้ fine-tune (F5-TTS v1 base)
    model_cfg = dict(dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512,
                     text_mask_padding=False, conv_layers=4, pe_attn_head=1)
    model = load_model(model_cfg, job["ckpt"], mel_spec_type="vocos", vocab_file=job["vocab"])
    vocoder = load_vocoder("vocos")
    sels = load_references(job["references"])
    emotion = job.get("emotion", "calm")
    if not sels.get(emotion):
        log(event="error", message=f"ไม่มีคลิปต้นแบบของอารมณ์ {emotion}")
        sys.exit(2)
    log(event="loaded", seconds=round(time.time() - started, 1))

    total = len(job["segments"])
    for seg in job["segments"]:
        out = Path(seg["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        text = seg["text"]
        try:
            if job.get("transliterate", True):
                text = transliterate_text(text, use_llm=False)
            sr, wav, _ = generate_long(
                text, emotion, sels, model, vocoder,
                speed=float(job.get("speed", 1.0)),
                cfg_strength=float(job.get("cfg_strength", 2.0)),
                nfe_step=int(job.get("nfe_step", 32)),
                mel_spec_type="vocos",
            )
            if wav is None:
                raise RuntimeError("ไม่มีเสียงออกมา")
            sf.write(str(out), wav, sr)
        except Exception as exc:  # หยุดทันทีเพื่อไม่ให้ได้เสียงขาดกลางคัน
            log(event="error", index=seg["index"], message=str(exc))
            sys.exit(3)
        log(event="segment", index=seg["index"], total=total, seconds=round(time.time() - t0, 2))

    log(event="done", total=total, seconds=round(time.time() - started, 1))


if __name__ == "__main__":
    main()
