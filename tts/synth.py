"""
TTS batch worker — โหลดโมเดลครั้งเดียว แล้วสังเคราะห์ทุก segment รวดเดียว

รับ job file เป็น JSON:
{
  "engine": "f5-tts-thai" | "chatterbox",
  "ref_audio": "path.wav",       # เสียงต้นแบบสำหรับ voice clone
  "ref_text": "ข้อความในเสียงต้นแบบ",
  "sample_rate": 24000,
  "segments": [{"index": 0, "text": "...", "out": "path.wav"}, ...]
}

ใช้:  python tts/synth.py job.json
พิมพ์สถานะทีละบรรทัดเป็น JSON เพื่อให้ฝั่ง Node อ่าน progress ได้
"""
import json
import sys
import time
from pathlib import Path


def log(**kw):
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def load_f5(job):
    """F5-TTS-THAI (VIZINTZOR) — fine-tune ภาษาไทยของ F5-TTS"""
    from f5_tts.api import F5TTS

    model = F5TTS(
        model=job.get("model_name", "F5TTS_v1_Base"),
        ckpt_file=job.get("ckpt_file", ""),
        vocab_file=job.get("vocab_file", ""),
        device=job.get("device", "cuda"),
    )

    def synth(text, out_path):
        model.infer(
            ref_file=job["ref_audio"],
            ref_text=job.get("ref_text", ""),
            gen_text=text,
            file_wave=out_path,
            speed=job.get("speed", 1.0),
            remove_silence=True,
        )

    return synth


def load_chatterbox(job):
    """Chatterbox Multilingual (Resemble AI) — สำรองสำหรับคลิปที่มีอังกฤษปน"""
    import torchaudio
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    model = ChatterboxMultilingualTTS.from_pretrained(device=job.get("device", "cuda"))

    def synth(text, out_path):
        wav = model.generate(
            text,
            language_id=job.get("language", "th"),
            audio_prompt_path=job.get("ref_audio") or None,
        )
        torchaudio.save(out_path, wav, model.sr)

    return synth


ENGINES = {"f5-tts-thai": load_f5, "chatterbox": load_chatterbox}


def main():
    if len(sys.argv) < 2:
        log(event="error", message="ต้องระบุ job file")
        sys.exit(1)

    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    engine = job.get("engine", "f5-tts-thai")
    if engine not in ENGINES:
        log(event="error", message=f"ไม่รู้จัก engine: {engine}")
        sys.exit(1)

    started = time.time()
    log(event="loading", engine=engine)
    try:
        synth = ENGINES[engine](job)
    except ImportError as exc:
        log(event="error", message=f"ยังไม่ได้ติดตั้ง {engine}: {exc}. รัน scripts/setup-tts.ps1 ก่อน")
        sys.exit(2)
    log(event="loaded", seconds=round(time.time() - started, 1))

    total = len(job["segments"])
    for seg in job["segments"]:
        out = Path(seg["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        try:
            synth(seg["text"], str(out))
        except Exception as exc:  # หยุดทันทีเพื่อไม่ให้ได้เสียงขาดกลางคัน
            log(event="error", index=seg["index"], message=str(exc))
            sys.exit(3)
        if not out.exists() or out.stat().st_size == 0:
            log(event="error", index=seg["index"], message="ไม่มีไฟล์เสียงออกมา")
            sys.exit(3)
        log(event="segment", index=seg["index"], total=total, seconds=round(time.time() - t0, 2))

    log(event="done", total=total, seconds=round(time.time() - started, 1))


if __name__ == "__main__":
    main()
