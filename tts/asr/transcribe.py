"""
ถอดเสียงพากย์จากไฟล์ภายนอก → ประโยคพร้อมเวลา (แบบ SayToWords) ด้วย faster-whisper ในเครื่อง

ใช้ tts/.venv (faster-whisper ในเครื่อง — ครั้งแรกดาวน์โหลดโมเดล large-v3 ไม่เรียก API)

  python tts/asr/transcribe.py <audio> <out.json> [--language th] [--model large-v3]

ผลลัพธ์: { "language", "duration", "segments": [{ "start", "end", "text" }] }
ประโยคยาวจะถูกซอยตรงช่วงหยุดหายใจ (จาก word timestamps) ให้เหลือไม่เกิน ~7 วิ
สถานะพิมพ์เป็น JSON ทีละบรรทัด: loading / loaded / progress / done / error
"""
import argparse
import json
import sys
import time
from pathlib import Path

MAX_SECONDS = 7.0   # ประโยคยาวกว่านี้ซอยตรงจุดหยุด — ภาพ 2–3 วิ/ช็อต ต้องการจังหวะละเอียดพอ
PAUSE_SECONDS = 0.35  # ช่องว่างระหว่างคำที่ถือว่าเป็นจุดหยุดหายใจ


def log(**kw):
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def split_segment(seg):
    """ซอยประโยคที่ยาวเกินตรงช่วงเงียบระหว่างคำที่กว้างที่สุด"""
    words = [w for w in (seg.words or []) if w.word.strip()]
    if seg.end - seg.start <= MAX_SECONDS or len(words) < 2:
        return [{"start": seg.start, "end": seg.end, "text": seg.text.strip()}]

    pieces, current = [], [words[0]]
    for prev, word in zip(words, words[1:]):
        long_enough = word.start - current[0].start >= MAX_SECONDS * 0.4
        if (word.start - prev.end >= PAUSE_SECONDS and long_enough) or word.end - current[0].start > MAX_SECONDS:
            pieces.append(current)
            current = []
        current.append(word)
    pieces.append(current)
    # ภาษาไทยไม่มีช่องว่างระหว่างคำ → ต่อ token ตรงๆ (whisper ใส่ช่องว่างเองเมื่อจำเป็น)
    return [
        {"start": p[0].start, "end": p[-1].end, "text": "".join(w.word for w in p).strip()}
        for p in pieces
        if "".join(w.word for w in p).strip()
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--language", default="th")
    ap.add_argument("--model", default="large-v3")
    args = ap.parse_args()

    started = time.time()
    log(event="loading", engine=f"whisper {args.model}")
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        log(event="error", message=f"ไม่มี faster-whisper: {exc}")
        sys.exit(2)
    try:
        model = WhisperModel(args.model, device="cuda", compute_type="float16")
    except Exception as exc:  # ไม่มีการ์ดจอ/หน่วยความจำไม่พอ → CPU (ช้ากว่ามาก)
        log(event="warning", message=f"ใช้การ์ดจอไม่ได้ ({exc}) — ถอดด้วย CPU แทน")
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
    log(event="loaded", seconds=round(time.time() - started, 1))

    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        beam_size=5,
        vad_filter=True,
        word_timestamps=True,
        condition_on_previous_text=False,  # กันประโยคซ้ำวนเมื่อเสียงยาว
    )
    out = []
    for seg in segments:
        out.extend(split_segment(seg))
        log(event="progress", seconds=round(seg.end, 1), total=round(info.duration, 1))

    Path(args.out).write_text(
        json.dumps({"language": info.language, "duration": info.duration, "segments": out}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    log(event="done", segments=len(out), seconds=round(time.time() - started, 1))


if __name__ == "__main__":
    main()
