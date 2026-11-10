"""Kyutai Pocket TTS engine: CPU voice cloning that streams audio while it generates.

Pocket TTS (100M parameters, CC-BY-4.0 weights, MIT code) clones a voice from a short clip and
decodes 80 ms audio frames as soon as the language model produces them, so the first audio of a
reply exists a few hundred milliseconds after the request. The weights, the tokenizer and the
catalog voice are read from models/pocket (see download_models.ps1); nothing is fetched at run
time.
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
from math import gcd
from pathlib import Path
from typing import Iterator

import numpy as np

from . import paths
from . import text as txt
from .engine import Chunk, reference_digest
from .styles import DEFAULT_STYLE, Style, get_style

log = logging.getLogger("miss_voice")

CHECKPOINT = "english_2026-04"
MODEL_DIR = paths.POCKET_MODELS / CHECKPOINT
WEIGHTS = MODEL_DIR / "model.safetensors"
TOKENIZER = MODEL_DIR / "tokenizer.json"
BUILTIN_VOICE = MODEL_DIR / "alba.safetensors"  # Kyutai catalog voice, used when no reference exists
REQUIRED = (WEIGHTS, TOKENIZER)

# Kyutai's recommended sampling temperature for its shipped models (their listening tests preferred
# it), so on this engine a delivery style changes only the pause between sentences.
TEMPERATURE = 0.3
# The first chunk leaves as soon as this much speech exists, so she starts talking quickly. Later
# chunks are larger, which keeps the number of host events low; generation runs well ahead of
# playback, so the player never runs dry.
FIRST_CHUNK_S = 0.2
NEXT_CHUNK_S = 0.6
TARGET_DBFS = -20.0
ONSET_DBFS = -45.0  # a 10 ms window louder than this is speech
LEAD_PAD_S = 0.04  # kept before the detected onset
MAX_LEAD_TRIM_S = 1.0
_TAG = re.compile(r"\[[^\]]*\]")  # Chatterbox's paralinguistic tags mean nothing to Pocket TTS
_SPEAKABLE = re.compile(r"[A-Za-z0-9]")


def default_threads() -> int:
    # Measured on a Ryzen 5 7530U by work/probe_pocket.py; see PROGRESS.md (Voice).
    return int(os.environ.get("MISS_VOICE_POCKET_THREADS", "4"))


def missing_files() -> list[str]:
    return [path.name for path in REQUIRED if not path.is_file()]


def speakable_pieces(text: str) -> list[str]:
    """Sentence chunks with tags removed; pieces with nothing to say are dropped."""
    pieces = (_TAG.sub(" ", piece) for piece in txt.chunk(text))
    return [re.sub(r"\s+", " ", piece).strip() for piece in pieces if _SPEAKABLE.search(piece)]


def _config_file() -> Path:
    """The packaged config for the checkpoint, pointed at the local files so loading needs no network."""
    import yaml
    from pocket_tts.utils.config import CONFIGS_DIR

    raw = yaml.safe_load((CONFIGS_DIR / f"{CHECKPOINT}.yaml").read_text(encoding="utf-8"))
    raw["weights_path"] = str(WEIGHTS)
    # Without this key a missing file fails loudly instead of loading weights that cannot clone.
    raw.pop("weights_path_without_voice_cloning", None)
    raw["flow_lm"]["lookup_table"]["tokenizer_path"] = str(TOKENIZER)
    target = paths.WORK / "pocket" / f"{CHECKPOINT}.local.yaml"
    target.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.safe_dump(raw, sort_keys=False, allow_unicode=True)
    if not target.is_file() or target.read_text(encoding="utf-8") != text:
        temp = target.with_name(target.name + ".tmp")
        temp.write_text(text, encoding="utf-8")
        os.replace(temp, target)
    return target


def _soft_limit(audio: np.ndarray, knee: float = 0.8, ceiling: float = 0.97) -> np.ndarray:
    magnitude = np.abs(audio)
    over = magnitude > knee
    if not over.any():
        return audio
    out = audio.copy()
    span = ceiling - knee
    out[over] = np.sign(audio[over]) * (knee + span * np.tanh((magnitude[over] - knee) / span))
    return out


def _window_db(audio: np.ndarray, sr: int) -> np.ndarray:
    hop = max(1, int(sr * 0.01))
    frames = audio[: len(audio) // hop * hop].reshape(-1, hop)
    return 20 * np.log10(np.maximum(np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1)), 1e-9))


def _active_rms_dbfs(audio: np.ndarray, sr: int) -> float | None:
    """Level of the speech itself: the mean power of windows within 30 dB of the loudest."""
    levels = _window_db(audio, sr)
    if levels.size == 0:
        return None
    active = levels[levels > levels.max() - 30.0]
    return float(10 * np.log10(np.mean(10 ** (active / 10)))) if active.size else None


class PocketEngine:
    kind = "pocket"
    label = "Pocket TTS"

    def __init__(self, threads: int | None = None):
        missing = missing_files()
        if missing:
            raise FileNotFoundError("Pocket TTS files are missing from models/pocket (" + ", ".join(missing)
                                    + "). Run native/voice/download_models.ps1.")
        import torch
        from pocket_tts import TTSModel  # its import sets torch to one thread; ours is set after

        started = time.perf_counter()
        self.model = TTSModel.load_model(config=_config_file(), temp=TEMPERATURE)
        torch.set_num_threads(threads or default_threads())
        self.threads = torch.get_num_threads()
        self.model_name = f"pocket-{CHECKPOINT}"
        self.model_sr = int(self.model.sample_rate)
        self.sr = paths.SAMPLE_RATE
        self.state = None
        self.voice_name: str | None = None
        self.voice_id: str | None = None
        self.gain = 1.0  # set by warm_up so speech sits near TARGET_DBFS
        self.warmup_realtime: float | None = None
        self.first_chunk_ms: float | None = None
        self.load_seconds = time.perf_counter() - started
        log.info("Loaded Pocket TTS %s in %.1fs (%d threads)", CHECKPOINT, self.load_seconds, self.threads)

    # -- voice -----------------------------------------------------------------------
    def set_voice(self, reference: Path, name: str = "miss-minutes") -> None:
        """Clone the reference. Encoding a prompt is slow, so the resulting state is cached on disk."""
        from pocket_tts import export_model_state

        reference = Path(reference)
        digest = reference_digest(reference)
        cache = paths.VOICE_CACHE / f"pocket-{CHECKPOINT}-{name}-{digest}.safetensors"
        if cache.is_file():
            state = self.model.get_state_for_audio_prompt(cache)
        else:
            state = self.model.get_state_for_audio_prompt(reference)
            cache.parent.mkdir(parents=True, exist_ok=True)
            temp = cache.with_name(cache.name + ".tmp")
            export_model_state(state, temp)
            os.replace(temp, cache)
        self.state = state
        self.voice_name = name
        self.voice_id = f"{name}-{digest}"

    def use_builtin_voice(self) -> None:
        if not BUILTIN_VOICE.is_file():
            raise FileNotFoundError("The Pocket TTS catalog voice is missing. Run native/voice/download_models.ps1.")
        self.state = self.model.get_state_for_audio_prompt(BUILTIN_VOICE)
        self.voice_name = "builtin"
        self.voice_id = "builtin-alba"

    # -- synthesis -------------------------------------------------------------------
    def _frames(self, piece: str, stop: threading.Event) -> Iterator[np.ndarray]:
        for frame in self.model.generate_audio_stream(self.state, piece, copy_state=True, stop=stop):
            audio = frame.detach().cpu().numpy().astype(np.float32)
            if self.model_sr != self.sr:
                from scipy.signal import resample_poly

                divisor = gcd(self.sr, self.model_sr)
                audio = resample_poly(audio, self.sr // divisor, self.model_sr // divisor).astype(np.float32)
            yield _soft_limit(audio * self.gain)

    def stream(
        self,
        text: str,
        style: Style | str = DEFAULT_STYLE,
        seed: int | None = None,
        cancel: threading.Event | None = None,
    ) -> Iterator[Chunk]:
        if self.state is None:
            raise RuntimeError("No voice is loaded.")
        import torch

        style = get_style(style) if isinstance(style, str) else style
        pieces = speakable_pieces(text)
        stop = cancel if cancel is not None else threading.Event()
        pad = int(self.sr * LEAD_PAD_S)
        buffer: list[np.ndarray] = []
        buffered = 0
        speech = 0  # samples of speech in the buffer (pauses excluded)
        index = 0
        mark = time.perf_counter()

        def emit(text_now: str, last: bool) -> Chunk:
            nonlocal buffer, buffered, speech, index, mark
            audio = np.concatenate(buffer) if buffer else np.zeros(0, dtype=np.float32)
            now = time.perf_counter()
            chunk = Chunk(index=index, last=last, text=text_now, audio=audio,
                          speech_seconds=speech / self.sr, synth_seconds=now - mark)
            buffer, buffered, speech, index, mark = [], 0, 0, index + 1, now
            return chunk

        for number, piece in enumerate(pieces):
            if stop.is_set():
                return
            if seed is not None:
                torch.manual_seed(seed + number)
            # Leading silence is cut so every sentence starts on the voice; the pause between
            # sentences is then exactly the style's.
            preroll = np.zeros(0, dtype=np.float32)
            trimmed = 0
            onset_found = False
            for audio in self._frames(piece, stop):
                if stop.is_set():
                    return
                if not onset_found:
                    levels = _window_db(audio, self.sr)
                    loud = np.nonzero(levels > ONSET_DBFS)[0]
                    if loud.size == 0 and trimmed < MAX_LEAD_TRIM_S * self.sr:
                        trimmed += len(audio)
                        preroll = np.concatenate([preroll, audio])[-pad:]
                        continue
                    onset = int(loud[0]) * max(1, int(self.sr * 0.01)) if loud.size else 0
                    joined = np.concatenate([preroll, audio])
                    audio = joined[max(0, len(preroll) + onset - pad):]
                    onset_found = True
                buffer.append(audio)
                buffered += len(audio)
                speech += len(audio)
                threshold = FIRST_CHUNK_S if index == 0 else NEXT_CHUNK_S
                if buffered >= threshold * self.sr:
                    yield emit(piece, False)
            if stop.is_set():
                return
            if number < len(pieces) - 1:
                gap = np.zeros(int(self.sr * style.pause_s), dtype=np.float32)
                buffer.append(gap)
                buffered += len(gap)
        # The final chunk carries whatever is left (possibly nothing), so `last` is always sent.
        yield emit(pieces[-1] if pieces else "", True)

    def synthesize(self, text: str, style: Style | str = DEFAULT_STYLE, seed: int | None = None) -> np.ndarray:
        parts = [chunk.audio for chunk in self.stream(text, style, seed)]
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)

    def warm_up(self) -> float:
        """One sentence through the real streaming path: sets the level, the speed and the latency."""
        self.gain = 1.0
        started = time.perf_counter()
        first: float | None = None
        parts: list[np.ndarray] = []
        for chunk in self.stream("Hello there. It is good to see you again.", DEFAULT_STYLE, seed=0):
            if first is None and chunk.audio.size:
                first = time.perf_counter() - started
            parts.append(chunk.audio)
        elapsed = time.perf_counter() - started
        wav = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        level = _active_rms_dbfs(wav, self.sr)
        if level is not None:
            self.gain = float(np.clip(10 ** ((TARGET_DBFS - level) / 20), 0.5, 8.0))
        self.warmup_realtime = (len(wav) / self.sr) / elapsed if elapsed > 0 and wav.size else None
        self.first_chunk_ms = None if first is None else first * 1000.0
        return elapsed
