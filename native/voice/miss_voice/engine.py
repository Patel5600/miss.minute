"""Chatterbox-backed voice engine: load once, clone from a reference clip, stream sentences."""
from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np

from . import audio as au
from . import paths
from . import text as txt
from .styles import DEFAULT_STYLE, Style, get_style

log = logging.getLogger("miss_voice")


@dataclass
class Chunk:
    index: int
    last: bool
    text: str
    audio: np.ndarray  # float32 mono at engine.sr; includes the trailing sentence pause
    speech_seconds: float  # duration of speech without the pause
    synth_seconds: float  # wall-clock time spent generating it


class VoiceEngine:
    def __init__(self, model: str = "turbo", device: str = "cpu", threads: int | None = None):
        if model not in ("nano", "turbo"):
            raise ValueError("model must be 'nano' or 'turbo'")
        import inspect

        import torch

        torch.set_num_threads(threads or max(2, (os.cpu_count() or 8) // 2))
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        t3_file = paths.MODELS / ("t3_nano_v1.safetensors" if model == "nano" else "t3_turbo_v1.safetensors")
        if not t3_file.is_file():
            raise FileNotFoundError(f"{t3_file.name} is missing. Run native/voice/download_models.ps1"
                                    + (" -IncludeTurbo" if model == "turbo" else ""))
        # The released chatterbox-tts (0.1.7) is Turbo-only. Nano exists only on unreleased
        # upstream code, so ask the installed package instead of assuming.
        supports_nano = "nano" in inspect.signature(ChatterboxTurboTTS.from_local).parameters
        if model == "nano" and not supports_nano:
            raise RuntimeError("The installed chatterbox-tts has no Nano support (released 0.1.7 is "
                               "Turbo-only). Use model='turbo', or install a newer upstream release.")
        started = time.perf_counter()
        kwargs = {"nano": True} if model == "nano" else {}
        self.tts = ChatterboxTurboTTS.from_local(paths.MODELS, device, **kwargs)
        self.model_name = model
        self.device = device
        self.sr: int = self.tts.sr
        self.voice_name: str | None = None
        # Name plus reference digest: the speech cache must never replay another voice's audio.
        self.voice_id: str | None = None
        self.warmup_realtime: float | None = None
        self.load_seconds = time.perf_counter() - started
        log.info("Loaded Chatterbox %s on %s in %.1fs", model, device, self.load_seconds)

    # -- voice -----------------------------------------------------------------------
    def set_voice(self, reference: Path, name: str = "miss-minutes") -> None:
        """Condition on a reference clip. The expensive embedding step is cached on disk."""
        from chatterbox.tts_turbo import Conditionals

        reference = Path(reference)
        digest = hashlib.sha256(reference.read_bytes()).hexdigest()[:16]
        cache = paths.VOICE_CACHE / f"{name}-{digest}.pt"
        if cache.is_file():
            self.tts.conds = Conditionals.load(cache, map_location="cpu").to(self.tts.device)
        else:
            self.tts.prepare_conditionals(str(reference), exaggeration=0.0, norm_loudness=True)
            cache.parent.mkdir(parents=True, exist_ok=True)
            self.tts.conds.save(cache)
        self.voice_name = name
        self.voice_id = f"{name}-{digest}"

    def use_builtin_voice(self) -> None:
        """The model's own default speaker, used whenever no owner-prepared reference exists."""
        from chatterbox.tts_turbo import Conditionals

        self.tts.conds = Conditionals.load(paths.MODELS / "conds.pt", map_location="cpu").to(self.tts.device)
        self.voice_name = "builtin"
        self.voice_id = "builtin"

    # -- synthesis -------------------------------------------------------------------
    def _generate(self, piece: str, style: Style, seed: int | None) -> np.ndarray:
        import torch

        if seed is not None:
            torch.manual_seed(seed)
        with torch.inference_mode():
            wav = self.tts.generate(
                piece,
                temperature=style.temperature,
                top_p=style.top_p,
                repetition_penalty=style.repetition_penalty,
            )
        return wav.squeeze(0).detach().cpu().numpy().astype(np.float32)

    def stream(
        self,
        text: str,
        style: Style | str = DEFAULT_STYLE,
        seed: int | None = None,
        cancel: threading.Event | None = None,
    ) -> Iterator[Chunk]:
        style = get_style(style) if isinstance(style, str) else style
        pieces = txt.chunk(text)
        for index, piece in enumerate(pieces):
            if cancel is not None and cancel.is_set():
                return
            started = time.perf_counter()
            wav = self._generate(piece, style, None if seed is None else seed + index)
            wav = au.trim_silence(wav, self.sr)
            wav = au.highpass(wav, self.sr)
            wav = au.fade(au.normalize_rms(wav, target_dbfs=-20.0), self.sr)
            elapsed = time.perf_counter() - started
            last = index == len(pieces) - 1
            pause = np.zeros(0 if last else int(self.sr * style.pause_s), dtype=np.float32)
            yield Chunk(
                index=index, last=last, text=piece,
                audio=np.concatenate([wav, pause]),
                speech_seconds=len(wav) / self.sr, synth_seconds=elapsed,
            )

    def synthesize(self, text: str, style: Style | str = DEFAULT_STYLE, seed: int | None = None) -> np.ndarray:
        parts = [chunk.audio for chunk in self.stream(text, style, seed)]
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)

    def warm_up(self) -> float:
        started = time.perf_counter()
        wav = self._generate("Hello there.", get_style(DEFAULT_STYLE), 0)
        elapsed = time.perf_counter() - started
        # Seconds of speech per second of compute. Below 1.0 the engine cannot keep up with a
        # live reply, which the dashboard uses to decide what this engine may voice.
        self.warmup_realtime = (len(wav) / self.sr) / elapsed if elapsed > 0 else None
        return elapsed

    # -- analysis helpers (verification only) ----------------------------------------
    def speaker_embedding(self, wav: np.ndarray, sr: int) -> np.ndarray:
        """Unit-norm 256-d speaker embedding from Chatterbox's own voice encoder."""
        wav16 = au.resample(wav, sr, 16000)
        emb = np.asarray(self.tts.ve.embeds_from_wavs([wav16], sample_rate=16000)).reshape(-1, 256).mean(axis=0)
        return emb / (np.linalg.norm(emb) + 1e-9)
