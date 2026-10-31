"""Small audio helpers shared by reference preparation, synthesis and verification."""
from __future__ import annotations

from pathlib import Path

import numpy as np


def load_audio(path: str | Path, sr: int, mono: bool = True) -> np.ndarray:
    """Decode any container PyAV understands (webm/opus, mp4, wav...).

    Returns float32 with shape (n,) for mono or (channels, n) for stereo.
    """
    import av

    resampler = av.AudioResampler(format="fltp", layout="mono" if mono else "stereo", rate=sr)
    parts: list[np.ndarray] = []
    with av.open(str(path)) as container:
        stream = next(s for s in container.streams if s.type == "audio")
        for frame in container.decode(stream):
            frame.pts = None
            for out in resampler.resample(frame):
                parts.append(out.to_ndarray())
        for out in resampler.resample(None):
            parts.append(out.to_ndarray())
    audio = np.concatenate(parts, axis=1).astype(np.float32)
    return audio[0] if mono else audio


def write_wav(path: str | Path, audio: np.ndarray, sr: int) -> None:
    import soundfile as sf

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.clip(audio, -1.0, 1.0), sr, subtype="PCM_16")


def to_pcm16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def resample(audio: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst:
        return audio
    import librosa

    return librosa.resample(audio, orig_sr=src, target_sr=dst)


def rms_dbfs(audio: np.ndarray) -> float:
    if audio.size == 0:
        return -120.0
    return float(20 * np.log10(max(float(np.sqrt(np.mean(np.square(audio)))), 1e-9)))


def peak_dbfs(audio: np.ndarray) -> float:
    if audio.size == 0:
        return -120.0
    return float(20 * np.log10(max(float(np.max(np.abs(audio))), 1e-9)))


def normalize_rms(audio: np.ndarray, target_dbfs: float = -20.0, peak: float = 0.97) -> np.ndarray:
    """Match speech level, then soft-limit so the peak never clips."""
    if audio.size == 0:
        return audio
    gain = 10 ** ((target_dbfs - rms_dbfs(audio)) / 20)
    out = audio * gain
    top = float(np.max(np.abs(out)))
    if top > peak:
        out = np.tanh(out / top * 1.2) / np.tanh(1.2) * peak
    return out.astype(np.float32)


def trim_silence(audio: np.ndarray, sr: int, threshold_db: float = -42.0, keep_ms: int = 70) -> np.ndarray:
    """Cut leading/trailing silence the model pads around each utterance."""
    if audio.size == 0:
        return audio
    hop = max(1, int(sr * 0.01))
    frames = audio[: len(audio) // hop * hop].reshape(-1, hop)
    level = 20 * np.log10(np.maximum(np.sqrt(np.mean(frames**2, axis=1)), 1e-9))
    active = np.where(level > level.max() + threshold_db)[0]
    if active.size == 0:
        return audio
    pad = int(sr * keep_ms / 1000)
    start = max(0, active[0] * hop - pad)
    end = min(len(audio), (active[-1] + 1) * hop + pad)
    return audio[start:end]


def fade(audio: np.ndarray, sr: int, ms: int = 8) -> np.ndarray:
    n = min(len(audio) // 2, int(sr * ms / 1000))
    if n <= 0:
        return audio
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    out = audio.copy()
    out[:n] *= ramp
    out[-n:] *= ramp[::-1]
    return out


def highpass(audio: np.ndarray, sr: int, cutoff_hz: float = 70.0) -> np.ndarray:
    from scipy.signal import butter, sosfiltfilt

    sos = butter(2, cutoff_hz / (sr / 2), btype="highpass", output="sos")
    return sosfiltfilt(sos, audio).astype(np.float32)
