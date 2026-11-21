"""On-device speech recognition for the desktop app.

WebView2 has no working Web Speech recognition, so the dashboard records the microphone itself
and the host forwards the PCM here. faster-whisper base.en runs int8 on the CPU and loads on the
first request from models/whisper/base.en, which lets the worker run with Hugging Face offline.

    python -m miss_voice.stt --check          # load the model offline and decode a test tone
    python -m miss_voice.stt clip.wav         # transcribe a file and print timings
"""
from __future__ import annotations

import base64
import binascii
import os
import threading
import time
from math import gcd
from pathlib import Path

import numpy as np

from . import paths

MODEL_LABEL = "Whisper base.en (int8, CPU)"
HOTWORDS = "Miss Minutes"
TARGET_RATE = 16000
MIN_SECONDS = 0.1
MAX_SECONDS = 120.0


class TranscribeError(Exception):
    """A problem the owner can act on; the message is shown as is."""


def default_threads() -> int:
    # One thread per physical core: on a 6-core/12-thread laptop 6 threads decoded fastest,
    # 4, 8 and 12 were each about 4% slower.
    return max(2, min(8, (os.cpu_count() or 8) // 2))


class Transcriber:
    def __init__(self, model_dir: Path | None = None, threads: int | None = None):
        self.model_dir = Path(model_dir or paths.WHISPER_DIR)
        self.threads = threads or default_threads()
        self._model = None
        self._lock = threading.Lock()
        self.load_seconds: float | None = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def _ensure(self):
        with self._lock:
            if self._model is None:
                if not (self.model_dir / "model.bin").is_file():
                    raise TranscribeError(
                        "The speech recognition model is not downloaded. Run native/voice/setup.ps1.")
                started = time.perf_counter()
                from faster_whisper import WhisperModel

                self._model = WhisperModel(str(self.model_dir), device="cpu", compute_type="int8",
                                           cpu_threads=self.threads)
                self.load_seconds = time.perf_counter() - started
            return self._model

    def transcribe_array(self, audio: np.ndarray, sample_rate: int) -> dict:
        """`audio` is mono float32 in [-1, 1]. Returns text plus timings for the host."""
        seconds = len(audio) / float(sample_rate)
        if seconds < MIN_SECONDS:
            raise TranscribeError("The recording is too short to transcribe.")
        if seconds > MAX_SECONDS:
            raise TranscribeError(f"Recordings longer than {int(MAX_SECONDS)} seconds are not transcribed.")
        if sample_rate != TARGET_RATE:
            from scipy.signal import resample_poly

            divisor = gcd(TARGET_RATE, sample_rate)
            audio = resample_poly(audio, TARGET_RATE // divisor, sample_rate // divisor).astype(np.float32)

        first_load = not self.loaded
        model = self._ensure()
        started = time.perf_counter()
        # Greedy decoding with the built-in VAD, so silence and coughs are skipped instead of
        # becoming invented words. Measured on a Ryzen 5 7530U: beam 5 costs a third more time,
        # and the hotword fixes her name ("Miss Minitz") at no measurable cost.
        segments, _info = model.transcribe(
            audio, language="en", beam_size=1, vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            condition_on_previous_text=False, without_timestamps=True, hotwords=HOTWORDS,
        )
        text = " ".join(segment.text.strip() for segment in segments).strip()
        result = {
            "text": text,
            "audioSeconds": round(seconds, 3),
            "seconds": round(time.perf_counter() - started, 3),
            "model": MODEL_LABEL,
        }
        if first_load and self.load_seconds is not None:
            result["loadSeconds"] = round(self.load_seconds, 3)
        return result

    def transcribe_pcm16(self, pcm16_base64: str, sample_rate: int) -> dict:
        try:
            raw = base64.b64decode(pcm16_base64, validate=True)
        except (binascii.Error, ValueError) as error:
            raise TranscribeError("The recording was not valid base64 PCM.") from error
        if len(raw) % 2:
            raise TranscribeError("The recording is not 16-bit PCM.")
        audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        return self.transcribe_array(audio, sample_rate)


def _main(argv: list[str] | None = None) -> int:
    import argparse

    from . import audio as au

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("clip", nargs="?", help="audio file to transcribe")
    parser.add_argument("--check", action="store_true", help="load the model and decode a test signal")
    parser.add_argument("--threads", type=int, default=None)
    args = parser.parse_args(argv)

    transcriber = Transcriber(threads=args.threads)
    if args.check or not args.clip:
        tone = (0.05 * np.sin(2 * np.pi * 220 * np.arange(TARGET_RATE) / TARGET_RATE)).astype(np.float32)
        result = transcriber.transcribe_array(tone, TARGET_RATE)
        print(f"STT-OK model loaded in {transcriber.load_seconds:.2f}s, decode {result['seconds']:.2f}s")
        return 0
    audio = au.load_audio(args.clip, TARGET_RATE)
    for attempt in (1, 2):
        result = transcriber.transcribe_array(audio, TARGET_RATE)
        print(f"run {attempt}: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
