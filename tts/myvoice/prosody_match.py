"""
Prosody-matched reference selection + multi-segment generation for F5-TTS Thai.

Two public functions:
- best_reference(text, emotion, selections, prefer_long=False) -> ref dict
- generate_long(text, emotion, voice_id, voice_loader, ...) -> (sr, wav, segments_info)
"""
from __future__ import annotations
import re
from pathlib import Path
from typing import Optional

import numpy as np

# Thai syllable tokenizer (from pythainlp, already installed by f5-tts-th)
try:
    from pythainlp.tokenize import syllable_tokenize, sent_tokenize
    _HAS_PYTHAINLP = True
except ImportError:
    _HAS_PYTHAINLP = False


# Per-emotion default speech rate (syllables/second) from Thai corpus analysis
EMOTION_RATES = {
    "calm":    5.8,
    "excited": 6.4,
    "serious": 5.0,
    "soft":    5.0,
}


# ============================================================
# Text analysis
# ============================================================
def count_syllables(text: str) -> int:
    """Approximate syllable count for Thai+EN mixed text."""
    text = text.strip()
    if not text:
        return 0
    if _HAS_PYTHAINLP:
        try:
            syls = syllable_tokenize(text)
            return len([s for s in syls if s.strip() and not re.match(r"^[\s\W_]+$", s)])
        except Exception:
            pass
    # Fallback: rough estimate
    # Thai: each Thai char ~ 1 syllable (very rough)
    # EN words: count by space
    thai = len(re.findall(r"[฀-๿]", text))
    en_words = len(re.findall(r"[a-zA-Z]+", text))
    digits = len(re.findall(r"\d+", text))
    return thai + en_words + digits


def split_phrases(text: str, max_syl: int = 15, min_syl: int = 4) -> list[str]:
    """Split long text into phrase-sized segments suitable for multi-segment generation.

    Heuristic:
    1. Split on hard breaks: . ! ? \n
    2. If a sub-piece has > max_syl, split on , or whitespace
    3. Merge very short pieces (< min_syl) with neighbor
    """
    text = text.strip()
    if not text:
        return []

    # First pass: hard breaks
    hard_re = re.compile(r"[.!?]+|\n+")
    raw_segs = [s.strip() for s in hard_re.split(text) if s.strip()]
    # also try Thai sentence tokenizer for fallback
    if _HAS_PYTHAINLP and len(raw_segs) <= 1:
        try:
            ts = [s.strip() for s in sent_tokenize(text) if s.strip()]
            if len(ts) > 1:
                raw_segs = ts
        except Exception:
            pass

    # Second pass: split overly long segs by comma / space
    out = []
    for seg in raw_segs:
        n = count_syllables(seg)
        if n <= max_syl:
            out.append(seg)
            continue
        # split by comma
        if "," in seg:
            parts = [p.strip() for p in seg.split(",") if p.strip()]
            buf = ""
            for p in parts:
                cand = (buf + ", " + p) if buf else p
                if count_syllables(cand) > max_syl and buf:
                    out.append(buf)
                    buf = p
                else:
                    buf = cand
            if buf:
                out.append(buf)
        else:
            # split by Thai sentence tokenizer phrase break (whitespace)
            words = seg.split()
            buf = ""
            for w in words:
                cand = (buf + " " + w) if buf else w
                if count_syllables(cand) > max_syl and buf:
                    out.append(buf)
                    buf = w
                else:
                    buf = cand
            if buf:
                out.append(buf)

    # Third pass: merge tiny segs
    merged: list[str] = []
    for seg in out:
        if merged and count_syllables(seg) < min_syl and \
                count_syllables(merged[-1]) + count_syllables(seg) <= max_syl + 2:
            merged[-1] = merged[-1] + " " + seg
        else:
            merged.append(seg)

    return merged


# ============================================================
# Reference selection
# ============================================================
def best_reference(
    text: str,
    emotion: str,
    selections: dict,
    prefer_long: bool = False,
) -> Optional[dict]:
    """Pick the reference clip whose prosody best matches `text`.

    Scoring (lower distance = better):
      - rate distance to emotion's target rate
      - duration distance to text's expected duration (capped at 8s)
    """
    items = selections.get(emotion, [])
    if not items:
        # fallback: any emotion
        for emo in EMOTION_RATES:
            if selections.get(emo):
                items = selections[emo]
                break
    if not items:
        return None

    n_syl = max(1, count_syllables(text))
    rate_target = EMOTION_RATES.get(emotion, 5.6)
    expected_dur = n_syl / rate_target
    # F5-TTS sweet spot: ref 3-8s
    expected_dur_capped = float(np.clip(expected_dur, 3.0, 8.0))

    best, best_score = None, float("-inf")
    for r in items:
        rate = r.get("speech_rate", rate_target)
        ref_dur = r.get("duration", 5.0)
        # normalize distances
        rate_dist = abs(rate - rate_target) / 3.0           # ~0..1
        dur_dist = abs(ref_dur - expected_dur_capped) / 5.0  # ~0..1
        long_bonus = 0.1 * (ref_dur / 8.0) if prefer_long else 0.0
        score = -(0.55 * rate_dist + 0.45 * dur_dist) + long_bonus
        if score > best_score:
            best_score, best = score, r

    return best


# ============================================================
# Multi-segment generation with crossfade
# ============================================================
def _equal_power_crossfade(a: np.ndarray, b: np.ndarray, n: int) -> np.ndarray:
    """Crossfade last n samples of `a` with first n of `b` (equal-power)."""
    n = min(n, len(a), len(b))
    if n <= 0:
        return np.concatenate([a, b])
    t = np.linspace(0, np.pi / 2, n, dtype=np.float32)
    fade_out = np.cos(t).astype(a.dtype)
    fade_in = np.sin(t).astype(a.dtype)
    mid = a[-n:] * fade_out + b[:n] * fade_in
    return np.concatenate([a[:-n], mid, b[n:]])


def _short_silence(sr: int, ms: int) -> np.ndarray:
    return np.zeros(int(sr * ms / 1000), dtype=np.float32)


def generate_long(
    text: str,
    emotion: str,
    selections: dict,
    voice_model,
    vocoder,
    *,
    speed: float = 1.0,
    cfg_strength: float = 2.0,
    nfe_step: int = 32,
    max_syl_per_seg: int = 15,
    crossfade_ms: int = 120,
    inter_seg_silence_ms: int = 80,
    mel_spec_type: str = "vocos",
):
    """Generate a long-form utterance by splitting `text` into phrases, picking
    a prosody-matched reference per phrase, and concatenating with crossfade.

    Returns: (sr, wav_int16_or_float, segments_info_list)
    """
    from f5_tts_th.utils_infer import infer_process, preprocess_ref_audio_text

    phrases = split_phrases(text, max_syl=max_syl_per_seg)
    if not phrases:
        return None, None, []

    segments_info: list[dict] = []
    audio_acc: Optional[np.ndarray] = None
    sr_out: Optional[int] = None

    for idx, phrase in enumerate(phrases, 1):
        ref = best_reference(phrase, emotion, selections, prefer_long=True)
        if ref is None:
            segments_info.append({"idx": idx, "phrase": phrase, "error": "no reference available"})
            continue

        # Speed adjustment: if phrase is much shorter/longer than ref duration window,
        # nudge speed so F5-TTS doesn't over-stretch. (gentle, +/- 10%)
        n_syl = count_syllables(phrase)
        expected = n_syl / EMOTION_RATES.get(emotion, 5.6)
        if expected > 0 and ref.get("duration", 5.0) > 0:
            ratio = ref["duration"] / expected
            adj_speed = float(np.clip(speed * (1.0 / np.clip(ratio, 0.6, 1.6)) ** 0.3,
                                       speed * 0.9, speed * 1.1))
        else:
            adj_speed = speed

        ref_proc, ref_text_proc = preprocess_ref_audio_text(ref["file"], ref["text"])
        wav, sr, _ = infer_process(
            ref_proc, ref_text_proc, phrase,
            voice_model, vocoder, mel_spec_type=mel_spec_type,
            nfe_step=int(nfe_step),
            cfg_strength=float(cfg_strength),
            speed=float(adj_speed),
        )
        wav = np.asarray(wav, dtype=np.float32)
        sr_out = sr

        segments_info.append({
            "idx": idx,
            "phrase": phrase,
            "syllables": n_syl,
            "ref_file": Path(ref["file"]).name,
            "ref_dur": ref.get("duration"),
            "ref_rate": ref.get("speech_rate"),
            "adj_speed": round(adj_speed, 3),
            "wav_sec": round(len(wav) / sr, 2),
        })

        if audio_acc is None:
            audio_acc = wav
        else:
            # insert a short low-amplitude silence between segments + crossfade
            sil = _short_silence(sr, inter_seg_silence_ms)
            audio_acc = _equal_power_crossfade(audio_acc, sil, int(sr * crossfade_ms / 1000))
            audio_acc = _equal_power_crossfade(audio_acc, wav, int(sr * crossfade_ms / 1000))

    return sr_out, audio_acc, segments_info
