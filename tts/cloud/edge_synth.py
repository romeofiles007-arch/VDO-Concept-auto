"""
Microsoft Edge TTS (edge-tts) — เสียงออนไลน์ฟรี ไม่ต้องใช้ key

job: { "voice": "th-TH-NiwatNeural", "rate": "+0%", "segments": [{"index": 0, "text": "...", "out": "x.mp3"}] }
พิมพ์สถานะเป็น JSON ทีละบรรทัด เหมือน tts/synth.py

ใช้:  tts/.venv-edge/Scripts/python.exe tts/cloud/edge_synth.py job.json
"""
import asyncio
import json
import sys
import time
from pathlib import Path

CONCURRENCY = 4
RETRIES = 4


def log(**kw):
    print(json.dumps(kw, ensure_ascii=False), flush=True)


async def synth_one(edge_tts, job, seg, sem, done, total):
    async with sem:
        out = Path(seg["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(1, RETRIES + 1):
            try:
                t0 = time.time()
                com = edge_tts.Communicate(seg["text"], job["voice"], rate=job.get("rate", "+0%"))
                await com.save(str(out))
                if not out.exists() or out.stat().st_size == 0:
                    raise RuntimeError("ไม่มีไฟล์เสียงออกมา")
                done.append(seg["index"])
                log(event="segment", index=len(done) - 1, total=total, seconds=round(time.time() - t0, 2))
                return
            except Exception as exc:  # เน็ตสะดุด/เซิร์ฟเวอร์ปฏิเสธชั่วคราว → รอแล้วลองใหม่
                if attempt == RETRIES:
                    raise RuntimeError(f"ประโยค {seg['index'] + 1}: {exc}") from exc
                await asyncio.sleep(2 * attempt)


async def main():
    if len(sys.argv) < 2:
        log(event="error", message="ต้องระบุ job file")
        sys.exit(1)
    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    started = time.time()
    log(event="loading", engine="edge")
    try:
        import edge_tts
    except ImportError as exc:
        log(event="error", message=f"ยังไม่ได้ติดตั้ง edge-tts: {exc}")
        sys.exit(2)
    log(event="loaded", seconds=0)

    total = len(job["segments"])
    sem = asyncio.Semaphore(CONCURRENCY)
    done: list[int] = []
    try:
        await asyncio.gather(*(synth_one(edge_tts, job, s, sem, done, total) for s in job["segments"]))
    except Exception as exc:
        log(event="error", message=str(exc))
        sys.exit(3)
    log(event="done", total=total, seconds=round(time.time() - started, 1))


if __name__ == "__main__":
    asyncio.run(main())
