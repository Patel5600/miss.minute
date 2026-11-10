"""Objective measurements used to judge the reference and the generated speech."""
from __future__ import annotations

import re
from functools import lru_cache

import numpy as np

from . import audio as au


def f0_stats(wav: np.ndarray, sr: int) -> dict:
    """Pitch statistics over voiced frames (Hz)."""
    import librosa

    y = au.resample(wav, sr, 16000) if sr != 16000 else wav
    f0, voiced, _ = librosa.pyin(y, fmin=70, fmax=700, sr=16000, frame_length=1024, hop_length=256)
    values = f0[voiced & np.isfinite(f0)] if f0 is not None else np.array([])
    if values.size < 5:
        return {"median": None, "p10": None, "p90": None, "voiced_fraction": 0.0}
    return {
        "median": float(np.median(values)),
        "p10": float(np.percentile(values, 10)),
        "p90": float(np.percentile(values, 90)),
        "voiced_fraction": float(np.mean(voiced)),
    }


def loudness_lufs(wav: np.ndarray, sr: int) -> float | None:
    import pyloudnorm as pyln

    if len(wav) < sr * 0.4:  # BS.1770 needs a 400 ms block
        return None
    value = pyln.Meter(sr).integrated_loudness(wav.astype(np.float64))
    return float(value) if np.isfinite(value) else None


def clipping(wav: np.ndarray) -> dict:
    return {"peak_dbfs": au.peak_dbfs(wav), "clipped_fraction": float(np.mean(np.abs(wav) >= 0.999))}


def spectral_flatness(wav: np.ndarray, sr: int) -> float:
    import librosa

    return float(np.mean(librosa.feature.spectral_flatness(y=wav, n_fft=1024, hop_length=256)))


def watermark_score(wav: np.ndarray, sr: int) -> float | None:
    """1.0 when Resemble's PerTh watermark is detected, 0.0 when absent."""
    try:
        import perth

        return float(perth.PerthImplicitWatermarker().get_watermark(wav, sample_rate=sr))
    except Exception:  # detector unavailable; report unknown rather than guessing
        return None


# --- intelligibility ------------------------------------------------------------------


@lru_cache(maxsize=1)
def _whisper(size: str = "base.en"):
    from faster_whisper import WhisperModel

    from . import paths

    # Prefer the copy setup downloaded for the worker so verification also works offline.
    local = paths.WHISPER_DIR if size == "base.en" and (paths.WHISPER_DIR / "model.bin").is_file() else None
    return WhisperModel(str(local) if local else size, device="cpu", compute_type="int8", cpu_threads=4)


def transcribe(wav: np.ndarray, sr: int, words: bool = False, size: str = "base.en"):
    """Returns (text, segments). Segments carry word timings when words=True."""
    y = au.resample(wav, sr, 16000).astype(np.float32)
    segments, _info = _whisper(size).transcribe(
        y, language="en", beam_size=5, word_timestamps=words, vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 250}, condition_on_previous_text=False,
    )
    segments = list(segments)
    return " ".join(s.text.strip() for s in segments).strip(), segments


def _words(text: str) -> list[str]:
    from .text import clean

    text = clean(text).lower().replace("-", " ")
    text = re.sub(r"\[[^\]]*\]", " ", text)  # paralinguistic tags are not spoken words
    return re.sub(r"[^a-z0-9' ]+", " ", text).split()


def wer(reference: str, hypothesis: str) -> float:
    """Word error rate via edit distance. 0.0 is a perfect read."""
    ref, hyp = _words(reference), _words(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i]
        for j, h in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h)))
        prev = cur
    return prev[-1] / len(ref)
