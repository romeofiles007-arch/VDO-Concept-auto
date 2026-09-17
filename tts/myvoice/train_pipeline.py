"""
End-to-end voice training pipeline.

Usage (CLI, streams progress to stdout — designed for Popen+log):
    python train_pipeline.py \
        --voice-name myvoice \
        --raw-dir <uploaded audio dir> \
        --epochs 40 \
        --batch-size 3200 \
        --lr 1e-5

Steps:
  1. Preprocess raw audio -> 24kHz chunks (silence-split)
  2. Whisper batch transcribe -> metadata.csv
  3. prepare_csv_wavs -> arrow dataset
  4. f5_tts.train.finetune_cli (resume from VIZINTZOR ckpt)
  5. select_references -> top-5 per emotion
  6. Write trained_voices/<name>/config.json

Output: trained_voices/<voice_name>/
  raw/             (original uploads, copied)
  chunks_24k/      (preprocessed)
  meta.csv
  ckpts/           (training checkpoints)
  data_arrow/      (f5_tts arrow dir, symlink/copy)
  references/      (selected references + selections.json)
  config.json
"""
import os
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

import argparse
import csv
import json
import shutil
import subprocess
import sys
import time
from importlib.resources import files
from pathlib import Path

PROJECT = Path(__file__).parent.resolve()
TRAINED_DIR = PROJECT / "trained_voices"
BASE_REPO = "VIZINTZOR/F5-TTS-THAI"


def base_model_file(name: str) -> Path:
    """โมเดลตั้งต้นภาษาไทย — เครื่องใหม่จะดาวน์โหลดจาก Hugging Face ครั้งแรกครั้งเดียว (~1.3GB) แล้วใช้จาก cache"""
    from huggingface_hub import hf_hub_download

    return Path(hf_hub_download(BASE_REPO, name))


def log(msg: str):
    """Print + flush for live streaming."""
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def step(n, total, name):
    log(f"\n{'='*70}\n[{n}/{total}] {name}\n{'='*70}")


# ---------- Step 1: preprocess ----------
def preprocess(raw_dir: Path, chunks_dir: Path, min_dur=3.0, max_dur=9.0, silence_db=35):
    import librosa
    import numpy as np
    import soundfile as sf

    chunks_dir.mkdir(parents=True, exist_ok=True)
    # clean
    for f in chunks_dir.glob("*.wav"):
        f.unlink()

    audio_exts = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac", ".opus"}
    audio_files = [p for p in sorted(raw_dir.iterdir()) if p.suffix.lower() in audio_exts]
    log(f"Found {len(audio_files)} source audio files")

    idx = 0
    total_dur = 0.0
    for src in audio_files:
        try:
            y, sr = librosa.load(str(src), sr=24000, mono=True)
        except Exception as e:
            log(f"  skip {src.name}: {e}")
            continue
        # normalize
        peak = float(np.abs(y).max())
        if peak > 1e-6:
            y = y / peak * 0.95

        # Try silence-based split first
        intervals = librosa.effects.split(y, top_db=silence_db)
        # Filter meaningful intervals
        valid = [(s, e) for s, e in intervals if (e - s) / sr >= min_dur]

        # Fallback: if silence-split yields < 10 chunks (likely BGM), use time-based split
        if len(valid) < 10:
            log(f"  {src.name}: silence-split got only {len(valid)} segments → switching to time-based split")
            chunk_sec = 7.0  # target chunk length
            step_n = int(chunk_sec * sr)
            valid = []
            for off in range(0, len(y) - int(min_dur * sr), step_n):
                end = min(off + int(max_dur * sr), len(y))
                if (end - off) / sr >= min_dur:
                    valid.append((off, end))

        n_added = 0
        for s, e in valid:
            seg = y[s:e]
            dur = len(seg) / sr
            if dur < min_dur:
                continue
            # further chop if too long
            if dur <= max_dur:
                pieces = [seg]
            else:
                step_n = int(max_dur * sr * 0.85)
                pieces = []
                for off in range(0, len(seg), step_n):
                    piece = seg[off:off + step_n]
                    if len(piece) / sr >= min_dur:
                        pieces.append(piece)
            for p in pieces:
                fname = chunks_dir / f"chunk_{idx:05d}.wav"
                sf.write(str(fname), p, 24000, subtype="PCM_16")
                idx += 1
                n_added += 1
                total_dur += len(p) / sr
        log(f"  {src.name}: +{n_added} chunks")

    log(f"\nTotal chunks: {idx}, duration: {total_dur/60:.1f} min")
    return idx


# ---------- Step 2: transcribe ----------
def transcribe(chunks_dir: Path, meta_csv: Path):
    from faster_whisper import WhisperModel
    log("Loading Whisper large-v3 (GPU/float16)...")
    t0 = time.time()
    try:
        model = WhisperModel("large-v3", device="cuda", compute_type="float16")
        log(f"  loaded in {time.time()-t0:.1f}s [CUDA]")
    except Exception as e:
        log(f"  CUDA failed: {e} -> falling back to CPU int8")
        model = WhisperModel("large-v3", device="cpu", compute_type="int8")
        log(f"  loaded in {time.time()-t0:.1f}s [CPU]")

    chunks = sorted(chunks_dir.glob("chunk_*.wav"))
    log(f"Transcribing {len(chunks)} chunks...")

    rows = []
    start = time.time()
    for i, wav in enumerate(chunks):
        try:
            segs, _ = model.transcribe(str(wav), language="th", beam_size=5, vad_filter=True)
            text = " ".join(s.text for s in segs).strip()
            if text:
                rows.append((str(wav.resolve()), text))
        except Exception as e:
            log(f"  fail {wav.name}: {e}")
        if (i + 1) % 50 == 0:
            elapsed = time.time() - start
            rate = (i + 1) / elapsed
            eta = (len(chunks) - i - 1) / rate
            log(f"  [{i+1}/{len(chunks)}] {elapsed/60:.1f}m elapsed, ETA {eta/60:.1f}m, ok={len(rows)}")

    with open(meta_csv, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter="|")
        w.writerow(["audio_file", "text"])
        for p, t in rows:
            w.writerow([p, t])
    log(f"Wrote {len(rows)} entries to {meta_csv}")
    return len(rows)


# ---------- Step 3: arrow ----------
def prepare_arrow(meta_csv: Path, voice_name: str):
    arrow_dir = Path(str(files("f5_tts").joinpath(f"../../data/{voice_name}_custom"))).resolve()
    arrow_dir.parent.mkdir(parents=True, exist_ok=True)

    # Run prepare_csv_wavs as subprocess (it uses Emilia vocab as 'pretrained' placeholder)
    cmd = [
        sys.executable, "-m", "f5_tts.train.datasets.prepare_csv_wavs",
        str(meta_csv), str(arrow_dir),
    ]
    log("Running prepare_csv_wavs...")
    log(" ".join(cmd))
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, encoding="utf-8", errors="replace", bufsize=1)
    for line in iter(p.stdout.readline, ''):
        log(line.rstrip())
    p.wait()
    if p.returncode != 0:
        raise RuntimeError(f"prepare_csv_wavs failed (exit {p.returncode})")

    # Overwrite vocab with VIZINTZOR Thai (so we can resume from base ckpt)
    shutil.copy2(base_model_file("vocab.txt"), arrow_dir / "vocab.txt")
    log("Overwrote vocab.txt with VIZINTZOR Thai (2586 chars)")
    return arrow_dir


# ---------- Step 4: fine-tune ----------
def fine_tune(voice_name: str, vocab_path: Path, epochs: int, batch_size: int, lr: float,
              save_per: int = 500):
    log("ตรวจโมเดลตั้งต้น (ครั้งแรกจะดาวน์โหลด ~1.3GB)")
    viz_ckpt = base_model_file("model_1000000.pt")

    ckpt_dir = Path(str(files("f5_tts").joinpath(f"../../ckpts/{voice_name}"))).resolve()
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable, "-u", "-m", "f5_tts.train.finetune_cli",
        "--exp_name", "F5TTS_Base",
        "--dataset_name", voice_name,
        "--finetune",
        "--pretrain", str(viz_ckpt),
        "--tokenizer", "custom",
        "--tokenizer_path", str(vocab_path),
        "--learning_rate", str(lr),
        "--batch_size_per_gpu", str(batch_size),
        "--batch_size_type", "frame",
        "--max_samples", "16",
        "--grad_accumulation_steps", "1",
        "--epochs", str(epochs),
        "--num_warmup_updates", "100",
        "--save_per_updates", str(save_per),
        "--last_per_updates", "200",
        "--keep_last_n_checkpoints", "3",
    ]
    log("Launching finetune_cli...")
    log(" ".join(cmd))
    env = dict(os.environ)
    env["KMP_DUPLICATE_LIB_OK"] = "TRUE"
    env["PYTHONUNBUFFERED"] = "1"
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, encoding="utf-8", errors="replace",
                         bufsize=1, env=env)
    last_loss_t = 0
    for line in iter(p.stdout.readline, ''):
        s = line.rstrip()
        # heuristic: throttle loss-progress lines (1 per second)
        if "loss=" in s and "update=" in s:
            now = time.time()
            if now - last_loss_t < 1.0:
                continue
            last_loss_t = now
        log(s)
    p.wait()
    if p.returncode != 0:
        raise RuntimeError(f"finetune_cli failed (exit {p.returncode})")
    final_ckpt = ckpt_dir / "model_last.pt"
    if not final_ckpt.exists():
        raise RuntimeError(f"expected ckpt not found: {final_ckpt}")
    return final_ckpt


# ---------- Step 5: references ----------
def pick_references(meta_csv: Path, voice_dir: Path):
    """Re-use select_references logic, but write into voice_dir/references/."""
    log("Selecting top-5 references per emotion...")
    # Lazy import to keep startup cheap
    import sys as _sys
    sys.path.insert(0, str(PROJECT))
    # Reimplement minimal version targeting custom out dir
    import csv as _csv
    import shutil as _shutil
    import numpy as np
    import librosa

    out_base = voice_dir / "references"
    out_base.mkdir(parents=True, exist_ok=True)

    with open(meta_csv, encoding="utf-8") as f:
        rd = _csv.reader(f, delimiter="|")
        next(rd)
        rows = [(r[0], r[1]) for r in rd if len(r) >= 2]

    feats = []
    for wav_path, text in rows:
        try:
            y, sr = librosa.load(wav_path, sr=24000, mono=True)
            dur = len(y) / sr
            if dur < 3.0 or dur > 9.0:
                continue
            f0, voiced, _ = librosa.pyin(y, fmin=70, fmax=400, sr=sr)
            f0v = f0[voiced]
            if len(f0v) < 10:
                continue
            pitch_mean = float(np.nanmean(f0v))
            pitch_range = float(np.nanpercentile(f0v, 90) - np.nanpercentile(f0v, 10))
            rms = librosa.feature.rms(y=y)[0]
            rms_db = 20 * np.log10(np.maximum(rms, 1e-8))
            energy_mean = float(rms_db.mean())
            energy_std = float(rms_db.std())
            onset_env = librosa.onset.onset_strength(y=y, sr=sr)
            peaks = librosa.util.peak_pick(onset_env, pre_max=3, post_max=3,
                                            pre_avg=3, post_avg=3, delta=0.5, wait=2)
            rate = len(peaks) / dur
            feats.append({
                "path": wav_path, "text": text, "duration": dur,
                "pitch_mean": pitch_mean, "pitch_range": pitch_range,
                "energy_mean": energy_mean, "energy_std": energy_std,
                "speech_rate": rate,
            })
        except Exception:
            continue
    log(f"  {len(feats)} chunks passed filter")
    if len(feats) < 8:
        log("  WARNING: too few chunks for stable emotion picking")
        if not feats:
            return None

    arr_pm = np.array([f["pitch_mean"] for f in feats])
    arr_pr = np.array([f["pitch_range"] for f in feats])
    arr_em = np.array([f["energy_mean"] for f in feats])
    arr_es = np.array([f["energy_std"] for f in feats])
    arr_sr = np.array([f["speech_rate"] for f in feats])
    def pct(a, v): return float((a < v).mean())
    for f in feats:
        f["pct_pm"] = pct(arr_pm, f["pitch_mean"])
        f["pct_pr"] = pct(arr_pr, f["pitch_range"])
        f["pct_em"] = pct(arr_em, f["energy_mean"])
        f["pct_es"] = pct(arr_es, f["energy_std"])
        f["pct_sr"] = pct(arr_sr, f["speech_rate"])

    def s_calm(f):
        return -sum(abs(f[k]-0.5) for k in ["pct_pm","pct_pr","pct_em","pct_sr"])
    def s_excited(f):
        return (f["pct_pr"]+f["pct_em"]+f["pct_es"]+f["pct_sr"])/4
    def s_serious(f):
        return (1-f["pct_pr"])*.35 + (1-f["pct_pm"])*.2 + (1-f["pct_sr"])*.3 + abs(.5-f["pct_em"])*-.15
    def s_soft(f):
        return (1-f["pct_em"])*.4 + (1-f["pct_pr"])*.3 + (1-f["pct_sr"])*.3

    scorers = {"calm": s_calm, "excited": s_excited, "serious": s_serious, "soft": s_soft}

    def chunk_key(p):
        stem = Path(p).stem
        parts = stem.split("_")
        # Try voice_NNNN_chunk_MMM
        if len(parts) >= 4 and parts[-2] == "chunk":
            return parts[-1]
        return stem

    manifest = {}
    used_keys = set()
    for emo, sc in scorers.items():
        edir = out_base / emo
        edir.mkdir(parents=True, exist_ok=True)
        for f in edir.glob("*.wav"):
            f.unlink()
        ranked = sorted(feats, key=sc, reverse=True)
        picks = []
        for f in ranked:
            k = chunk_key(f["path"])
            if k in used_keys:
                continue
            picks.append(f)
            used_keys.add(k)
            if len(picks) >= 5:
                break
        items = []
        for rank, f in enumerate(picks, 1):
            src = Path(f["path"])
            dst = edir / f"{rank:02d}_{src.stem}.wav"
            _shutil.copy2(src, dst)
            items.append({
                "rank": rank, "file": str(dst), "text": f["text"],
                "duration": round(f["duration"], 2),
                "pitch_mean": round(f["pitch_mean"], 1),
                "pitch_range": round(f["pitch_range"], 1),
                "energy_mean": round(f["energy_mean"], 1),
                "speech_rate": round(f["speech_rate"], 2),
            })
            log(f"  [{emo}/{rank}] {src.name} | {f['text'][:40]}")
        manifest[emo] = items

    sel = out_base / "selections.json"
    with open(sel, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    log(f"References at: {out_base}")
    return sel


# ---------- Main ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice-name", required=True)
    ap.add_argument("--raw-dir", required=True, help="Directory containing source audio")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch-size", type=int, default=3200, help="frames per GPU")
    ap.add_argument("--lr", type=float, default=1e-5)
    ap.add_argument("--save-per", type=int, default=500)
    args = ap.parse_args()

    voice_name = "".join(c if c.isalnum() or c in "_-" else "_" for c in args.voice_name.strip())
    if not voice_name:
        log("❌ invalid voice name")
        sys.exit(2)

    voice_dir = TRAINED_DIR / voice_name
    voice_dir.mkdir(parents=True, exist_ok=True)
    chunks_dir = voice_dir / "chunks_24k"
    meta_csv = voice_dir / "meta.csv"

    log(f"Voice name: {voice_name}")
    log(f"Voice dir : {voice_dir}")
    log(f"Raw dir   : {args.raw_dir}")
    log(f"Params    : epochs={args.epochs} batch={args.batch_size} lr={args.lr}")

    step(1, 5, "Preprocess audio (split + 24kHz)")
    n_chunks = preprocess(Path(args.raw_dir), chunks_dir)
    if n_chunks < 30:
        log(f"❌ too few chunks ({n_chunks}); need at least 30 for stable fine-tune")
        sys.exit(3)

    step(2, 5, "Transcribe with Whisper")
    n_meta = transcribe(chunks_dir, meta_csv)
    if n_meta < 30:
        log(f"❌ too few transcripts ({n_meta})")
        sys.exit(4)

    step(3, 5, "Prepare arrow dataset")
    arrow_dir = prepare_arrow(meta_csv, voice_name)
    vocab_path = arrow_dir / "vocab.txt"

    step(4, 5, "Fine-tune (this is the long step)")
    ckpt_path = fine_tune(voice_name, vocab_path,
                           epochs=args.epochs,
                           batch_size=args.batch_size,
                           lr=args.lr,
                           save_per=args.save_per)

    step(5, 5, "Select top-5 references per emotion")
    sel_json = pick_references(meta_csv, voice_dir)

    # Write voice config so UI can switch to it
    cfg = {
        "ckpt": str(ckpt_path),
        "vocab": str(vocab_path),
        "references_json": str(sel_json) if sel_json else None,
        "label": voice_name,
        "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "epochs": args.epochs,
        "n_chunks": n_chunks,
    }
    (voice_dir / "config.json").write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    log(f"\n{'='*70}\n✅ DONE — voice '{voice_name}' ready\n{'='*70}")
    log(f"Config: {voice_dir / 'config.json'}")
    log(f"Ckpt  : {ckpt_path}")
    log(f"Refs  : {sel_json}")


if __name__ == "__main__":
    main()
