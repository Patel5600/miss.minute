"""JSON-lines voice worker. The desktop host spawns this and talks to it over stdio.

There is no network listener. Requests arrive on stdin and results leave on stdout:

  host -> worker   {"op":"load_tts"}
                   {"op":"speak","id":"u1","text":"Hello","style":"conversational"}
                   {"op":"transcribe","id":"t1","sampleRate":16000,"pcm16":"<base64>"}
                   {"op":"stop"}   {"op":"status"}   {"op":"shutdown"}
  worker -> host   {"event":"started","tts":"lazy","pid":1234}
                   {"event":"ready","model":"turbo","voice":"builtin","sampleRate":24000,...}
                   {"event":"chunk","id":"u1","index":0,"last":false,"text":"...","pcm16":"<base64>",...}
                   {"event":"done","id":"u1",...}   {"event":"cancelled","id":"u1"}
                   {"event":"error","id":"u1","message":"..."}
                   {"event":"transcript","id":"t1","text":"...","seconds":0.4,"audioSeconds":3.1}
                   {"event":"transcript","id":"t1","error":"..."}

Speech synthesis needs several gigabytes of models, so it loads only when asked ("load_tts", or
the first "speak"). A worker started just to transcribe is answering within a few seconds.
A newer "speak" replaces the one in progress (latest wins), which is what a live assistant
wants when the user interrupts. Transcription runs on its own thread and never waits for
synthesis.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import queue
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Callable

MAX_TEXT = 6000
MAX_ID = 64

Emit = Callable[[dict], None]


@dataclass
class Job:
    id: str
    text: str
    style: str
    seed: int | None
    cancel: threading.Event = field(default_factory=threading.Event)


class _Load:
    """Queue marker: load the synthesis models."""


LOAD = _Load()


class Synthesizer:
    """Owns the Chatterbox engine on one thread so loading and synthesis never block stdin."""

    def __init__(self, args: argparse.Namespace, emit: Emit):
        from . import paths
        from .cache import SpeechCache

        self.args = args
        self.emit = emit
        self.engine = None
        self.status: dict = {}
        self.loading = False
        self.cache = None if args.no_cache else SpeechCache(paths.SPEECH_CACHE)
        self.queue: "queue.Queue[Job | _Load | None]" = queue.Queue()
        self.current: Job | None = None
        self.thread = threading.Thread(target=self._loop, name="voice-synth", daemon=True)
        self.thread.start()

    @property
    def state(self) -> str:
        return "ready" if self.engine is not None else ("loading" if self.loading else "off")

    def request_load(self) -> None:
        self.queue.put(LOAD)

    def speak(self, job: Job) -> None:
        self.cancel()
        self.queue.put(job)

    def cancel(self) -> None:
        job = self.current
        if job is not None:
            job.cancel.set()
        kept: list[_Load] = []
        try:
            while True:
                item = self.queue.get_nowait()
                if isinstance(item, _Load):
                    kept.append(item)  # stopping speech must not undo a pending model load
        except queue.Empty:
            pass
        for item in kept:
            self.queue.put(item)

    def close(self) -> None:
        self.cancel()
        self.queue.put(None)

    def _ensure_engine(self) -> bool:
        if self.engine is not None:
            return True
        self.loading = True
        try:
            from . import paths
            from .engine import VoiceEngine
            from .styles import STYLES

            # A prepared reference voice is used when present; otherwise the model's own voice.
            reference = self.args.reference or str(paths.REFERENCE_WAV)
            engine = VoiceEngine(self.args.model, threads=self.args.threads)
            if os.path.isfile(reference):
                engine.set_voice(reference, self.args.name)
            else:
                if self.args.reference:
                    raise FileNotFoundError(f"Reference voice not found: {reference}")
                engine.use_builtin_voice()
            warm = engine.warm_up()
        except Exception as error:  # reported, and a later request may retry the load
            self.emit({"event": "error", "fatal": True, "message": f"{type(error).__name__}: {error}"})
            return False
        finally:
            self.loading = False
        self.engine = engine
        self.status = {
            "model": self.args.model,
            "voice": engine.voice_name,
            "sampleRate": engine.sr,
            "loadSeconds": round(engine.load_seconds, 2),
            "warmupSeconds": round(warm, 2),
            "realtimeFactor": None if engine.warmup_realtime is None else round(engine.warmup_realtime, 3),
            "styles": list(STYLES),
        }
        self.emit({"event": "ready", **self.status})
        return True

    def _loop(self) -> None:
        while True:
            item = self.queue.get()
            if item is None:
                return
            if isinstance(item, _Load):
                self._ensure_engine()
                continue
            if not self._ensure_engine():
                self.emit({"event": "error", "id": item.id, "message": "The local voice could not be loaded."})
                continue
            self.current = item
            try:
                self._run(item)
            except Exception as error:
                self.emit({"event": "error", "id": item.id, "message": f"{type(error).__name__}: {error}"})
            finally:
                self.current = None

    def _run(self, job: Job) -> None:
        from . import audio as au
        from .styles import get_style

        engine = self.engine
        style = get_style(job.style)
        key = None
        if self.cache is not None:
            key = self.cache.key(engine.model_name, engine.voice_id, style, job.text, job.seed)
            cached = self.cache.load(key)
            if cached is not None:
                self._replay(job, cached)
                return

        started = time.perf_counter()
        audio_seconds = 0.0
        rendered: list[dict] = []
        for chunk in engine.stream(job.text, style, job.seed, job.cancel):
            if job.cancel.is_set():
                break
            audio_seconds += len(chunk.audio) / engine.sr
            payload = {
                "index": chunk.index, "last": chunk.last, "text": chunk.text,
                "speechSeconds": round(chunk.speech_seconds, 3),
                "pcm16": base64.b64encode(au.to_pcm16(chunk.audio)).decode("ascii"),
            }
            rendered.append(payload)
            self.emit({"event": "chunk", "id": job.id, "sampleRate": engine.sr,
                       "synthSeconds": round(chunk.synth_seconds, 3), **payload})
        if job.cancel.is_set():
            self.emit({"event": "cancelled", "id": job.id})
            return
        synth_seconds = time.perf_counter() - started
        self.emit({"event": "done", "id": job.id, "chunks": len(rendered), "cached": False,
                   "audioSeconds": round(audio_seconds, 3), "synthSeconds": round(synth_seconds, 3)})
        if key is not None and rendered:
            try:
                self.cache.save(key, engine.sr, rendered)
            except OSError as error:  # a full disk must not break speech
                print(f"speech cache write failed: {error}", file=sys.stderr)

    def _replay(self, job: Job, entry: dict) -> None:
        started = time.perf_counter()
        audio_seconds = 0.0
        sample_rate = int(entry["sampleRate"])
        for payload in entry["chunks"]:
            if job.cancel.is_set():
                self.emit({"event": "cancelled", "id": job.id})
                return
            audio_seconds += len(payload["pcm16"]) * 3 / 4 / 2 / sample_rate
            self.emit({"event": "chunk", "id": job.id, "sampleRate": sample_rate, "synthSeconds": 0.0,
                       "cached": True, **payload})
        self.emit({"event": "done", "id": job.id, "chunks": len(entry["chunks"]), "cached": True,
                   "audioSeconds": round(audio_seconds, 3),
                   "synthSeconds": round(time.perf_counter() - started, 3)})


class Recognizer:
    """Speech-to-text requests, one at a time, on their own thread."""

    def __init__(self, threads: int | None, emit: Emit):
        from .stt import Transcriber

        self.transcriber = Transcriber(threads=threads)
        self.emit = emit
        self.queue: "queue.Queue[dict | None]" = queue.Queue()
        threading.Thread(target=self._loop, name="voice-stt", daemon=True).start()

    @property
    def state(self) -> str:
        return "ready" if self.transcriber.loaded else "off"

    def submit(self, request: dict) -> None:
        self.queue.put(request)

    def close(self) -> None:
        self.queue.put(None)

    def _loop(self) -> None:
        from .stt import TranscribeError

        while True:
            request = self.queue.get()
            if request is None:
                return
            try:
                result = self.transcriber.transcribe_pcm16(request["pcm16"], request["sampleRate"])
                self.emit({"event": "transcript", "id": request["id"], **result})
            except TranscribeError as error:
                self.emit({"event": "transcript", "id": request["id"], "error": str(error)})
            except Exception as error:
                self.emit({"event": "transcript", "id": request["id"],
                           "error": f"Speech recognition failed: {type(error).__name__}: {error}"})


def main(argv: list[str] | None = None) -> int:
    # The protocol owns the real stdout. Anything a library prints goes to stderr instead,
    # so a stray warning can never corrupt the JSON stream.
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    write_lock = threading.Lock()

    def emit(message: dict) -> None:
        with write_lock:
            proto.write(json.dumps(message, separators=(",", ":")) + "\n")
            proto.flush()

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", choices=["nano", "turbo"], default="turbo")
    parser.add_argument("--reference", default=None, help="reference WAV to clone (owner-prepared only)")
    parser.add_argument("--name", default="miss-minutes")
    parser.add_argument("--threads", type=int, default=None, help="PyTorch threads for synthesis")
    parser.add_argument("--stt-threads", type=int, default=None, help="CTranslate2 threads for recognition")
    parser.add_argument("--tts", choices=["eager", "lazy"], default="eager",
                        help="load the synthesis models at start (eager) or on first use (lazy)")
    parser.add_argument("--no-cache", action="store_true", help="do not reuse previously rendered lines")
    args = parser.parse_args(argv)

    synth = Synthesizer(args, emit)
    recognizer = Recognizer(args.stt_threads, emit)
    emit({"event": "started", "tts": args.tts, "pid": os.getpid()})
    if args.tts == "eager":
        synth.request_load()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            op = message.get("op")
        except (ValueError, AttributeError):
            emit({"event": "error", "message": "Malformed request line."})
            continue

        if op == "speak":
            job_id = str(message.get("id", ""))[:MAX_ID]
            text = message.get("text")
            if not job_id or not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
                emit({"event": "error", "id": job_id or None,
                      "message": f"speak needs an id and 1 to {MAX_TEXT} characters of text."})
                continue
            seed = message.get("seed")
            synth.speak(Job(job_id, text, str(message.get("style") or "conversational"),
                            seed if isinstance(seed, int) else None))
        elif op == "transcribe":
            request_id = str(message.get("id", ""))[:MAX_ID]
            rate = message.get("sampleRate")
            pcm16 = message.get("pcm16")
            if not request_id:
                emit({"event": "error", "message": "transcribe needs an id."})
            elif not isinstance(rate, int) or not 8000 <= rate <= 48000 or not isinstance(pcm16, str) or not pcm16:
                emit({"event": "transcript", "id": request_id,
                      "error": "transcribe needs base64 PCM16 audio and a sample rate from 8000 to 48000 Hz."})
            else:
                recognizer.submit({"id": request_id, "sampleRate": rate, "pcm16": pcm16})
        elif op == "load_tts":
            synth.request_load()
        elif op == "stop":
            synth.cancel()
        elif op == "status":
            emit({"event": "status", **synth.status, "tts": synth.state, "stt": recognizer.state,
                  "busy": synth.current is not None})
        elif op == "shutdown":
            break
        else:
            emit({"event": "error", "message": f"Unknown op: {op!r}"})

    synth.close()
    recognizer.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
