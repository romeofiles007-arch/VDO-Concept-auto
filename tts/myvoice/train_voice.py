"""
เทรนเสียงใหม่เข้าคลังเสียงของโปรเจกต์ — ใช้ขั้นตอนเดียวกับ Copy My Voice (train_pipeline.py)

  tts/.venv/Scripts/python.exe tts/myvoice/train_voice.py tts/voices/<id> --epochs 40

โฟลเดอร์เสียง:
  raw/                ไฟล์เสียงต้นฉบับที่อัปโหลด
  chunks_24k/         ท่อนเสียง 3–9 วิ
  meta.csv            ข้อความที่ Whisper ถอดได้
  references/         คลิปต้นแบบ 5 อันต่ออารมณ์ + selections.json
  model.pt, vocab.txt โมเดลที่ใช้สร้างเสียง (เฉพาะ EMA fp16 ~640MB) — ทั้งโฟลเดอร์ย้ายไปเครื่องอื่นได้
  voice.json          { label, status, ckpt, vocab, references, ... } path อ้างอิงจากโฟลเดอร์นี้

checkpoint ระหว่างเทรนอยู่ที่ tts/.venv/Lib/ckpts/<id> (finetune_cli กำหนดตำแหน่งเอง)
หยุดกลางคันแล้วเริ่มใหม่ → ข้ามขั้นที่เสร็จแล้ว และเทรนต่อจาก checkpoint ล่าสุด
"""
import os

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

import argparse
import json
import re
import sys
import time
import traceback
from importlib.resources import files
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from train_pipeline import log, step, preprocess, transcribe, prepare_arrow, fine_tune, pick_references  # noqa: E402

AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac", ".opus"}


def read_voice(voice_dir: Path) -> dict:
    f = voice_dir / "voice.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def write_voice(voice_dir: Path, **changes) -> dict:
    data = {**read_voice(voice_dir), **changes}
    (voice_dir / "voice.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def newest_mtime(paths) -> float:
    return max((p.stat().st_mtime for p in paths), default=0.0)


def latest_checkpoint(ckpt_dir: Path) -> Path | None:
    if (ckpt_dir / "model_last.pt").exists():
        return ckpt_dir / "model_last.pt"
    numbered = [p for p in ckpt_dir.glob("model_*.pt") if re.fullmatch(r"model_\d+\.pt", p.name)]
    return max(numbered, key=lambda p: int(re.sub(r"\D", "", p.name)), default=None)


def export_voice_model(ckpt: Path, vocab: Path, voice_dir: Path) -> None:
    """เก็บเฉพาะ EMA weights แบบ fp16 ลงโฟลเดอร์เสียง — เล็กลงจาก ~5GB เหลือ ~640MB และไม่ผูกกับ venv"""
    import shutil

    import torch

    data = torch.load(str(ckpt), map_location="cpu", weights_only=True)
    ema = {k: (v.half() if torch.is_floating_point(v) else v) for k, v in data["ema_model_state_dict"].items()}
    tmp = voice_dir / "model.pt.tmp"
    torch.save({"ema_model_state_dict": ema, "update": data.get("update", 0)}, str(tmp))
    tmp.replace(voice_dir / "model.pt")
    shutil.copy2(vocab, voice_dir / "vocab.txt")


def relative_references(sel_json: Path) -> None:
    """คลังเสียงย้ายโฟลเดอร์ได้ — เก็บ path คลิปต้นแบบแบบอ้างอิงจาก selections.json"""
    data = json.loads(sel_json.read_text(encoding="utf-8"))
    for emo, items in data.items():
        for it in items:
            it["file"] = f"{emo}/{Path(it['file']).name}"
    sel_json.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("voice_dir")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch-size", type=int, default=3200)
    ap.add_argument("--lr", type=float, default=1e-5)
    args = ap.parse_args()

    voice_dir = Path(args.voice_dir).resolve()
    voice_id = voice_dir.name
    raw_dir = voice_dir / "raw"
    chunks_dir = voice_dir / "chunks_24k"
    meta_csv = voice_dir / "meta.csv"

    raw_files = [p for p in raw_dir.glob("*") if p.suffix.lower() in AUDIO_EXTS] if raw_dir.exists() else []
    if not raw_files:
        log("❌ ยังไม่มีไฟล์เสียงสำหรับเทรน — อัปโหลดไฟล์ก่อน")
        sys.exit(2)

    write_voice(voice_dir, status="training", error=None, epochs=args.epochs, startedAt=time.strftime("%Y-%m-%d %H:%M:%S"))
    log(f"เสียง: {read_voice(voice_dir).get('label', voice_id)} ({voice_id}) · ไฟล์ต้นฉบับ {len(raw_files)} ไฟล์ · epochs {args.epochs}")

    try:
        arrow_dir = Path(str(files("f5_tts").joinpath(f"../../data/{voice_id}_custom"))).resolve()
        # ไฟล์ต้นฉบับไม่เปลี่ยนตั้งแต่ถอดข้อความรอบก่อน → ข้ามขั้น 1–3 ที่ใช้เวลานาน
        prepared = (
            meta_csv.exists()
            and (arrow_dir / "raw.arrow").exists()
            and meta_csv.stat().st_mtime > newest_mtime(raw_files)
        )

        if prepared:
            log("\nข้ามขั้น 1–3 — ใช้ท่อนเสียงและข้อความที่เตรียมไว้แล้ว")
            n_chunks = len(list(chunks_dir.glob("chunk_*.wav")))
        else:
            step(1, 5, "ตัดไฟล์เสียงเป็นท่อน (24kHz)")
            n_chunks = preprocess(raw_dir, chunks_dir)
            if n_chunks < 30:
                raise RuntimeError(f"ได้ท่อนเสียงแค่ {n_chunks} ท่อน ต้องมีอย่างน้อย 30 (เสียงพูดรวมประมาณ 4 นาทีขึ้นไป)")

            step(2, 5, "ถอดข้อความด้วย Whisper")
            n_meta = transcribe(chunks_dir, meta_csv)
            if n_meta < 30:
                raise RuntimeError(f"ถอดข้อความได้แค่ {n_meta} ท่อน ต้องมีอย่างน้อย 30")

            step(3, 5, "เตรียม dataset")
            arrow_dir = prepare_arrow(meta_csv, voice_id)

        vocab_path = arrow_dir / "vocab.txt"
        ckpt_dir = Path(str(files("f5_tts").joinpath(f"../../ckpts/{voice_id}"))).resolve()
        resume = latest_checkpoint(ckpt_dir) if ckpt_dir.exists() else None
        step(4, 5, f"Fine-tune {'(ต่อจาก ' + resume.name + ')' if resume else ''} — ขั้นนี้นานที่สุด")
        try:
            fine_tune(voice_id, vocab_path, epochs=args.epochs, batch_size=args.batch_size, lr=args.lr)
        except RuntimeError as exc:
            # train_pipeline คาดว่าต้องมี model_last.pt แต่ finetune_cli อาจเก็บไว้แค่ model_<n>.pt
            if "expected ckpt not found" not in str(exc):
                raise
        ckpt = latest_checkpoint(ckpt_dir)
        if not ckpt:
            raise RuntimeError(f"เทรนจบแต่ไม่พบ checkpoint ใน {ckpt_dir}")

        step(5, 5, "เลือกคลิปต้นแบบแยกตามอารมณ์")
        sel_json = pick_references(meta_csv, voice_dir)
        if not sel_json:
            raise RuntimeError("เลือกคลิปต้นแบบไม่ได้ — ท่อนเสียงผ่านเกณฑ์น้อยเกินไป")
        relative_references(sel_json)

        log("\nบันทึกโมเดลลงโฟลเดอร์เสียง")
        export_voice_model(ckpt, vocab_path, voice_dir)

        write_voice(
            voice_dir,
            status="ready",
            ckpt="model.pt",
            vocab="vocab.txt",
            references="references/selections.json",
            chunks=n_chunks,
            trainedAt=time.strftime("%Y-%m-%d %H:%M:%S"),
        )
        log(f"\n✅ เทรนเสร็จ — เลือกเสียงนี้ในแผงข้างได้เลย\nโมเดล: {voice_dir / 'model.pt'} (จาก {ckpt.name})")
    except Exception as exc:
        write_voice(voice_dir, status="failed", error=str(exc))
        log(f"\n❌ เทรนไม่สำเร็จ: {exc}")
        traceback.print_exc(file=sys.stdout)
        sys.exit(3)


if __name__ == "__main__":
    main()
