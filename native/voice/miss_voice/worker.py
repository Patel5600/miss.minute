"""JSON-lines voice worker. The desktop host spawns this and talks to it over stdio.

There is no network listener. Requests arrive on stdin and results leave on stdout:

  host -> worker   {"op":"load_tts"}
                   {"op":"speak","id":"u1","text":"Hello","style":"conversational"}
                   {"op":"speak","id":"u2","text":"First sentence.","stream":true}
                   {"op":"speak","id":"u2","text":"Second sentence.","stream":true}
                   {"op":"speak_end","id":"u2"}
                   {"op":"transcribe","id":"t1","sampleRate":16000,"pcm16":"<base64>"}
                   {"op":"stop"}   {"op":"status"}   {"op":"shutdown"}
  worker -> host   {"event":"started","tts":"lazy","pid":1234}
                   {"event":"ready","engine":"pocket","voice":"cloned:reference","sampleRate":24000,...}
                   {"event":"chunk","id":"u1","index":0,"last":false,"text":"...","pcm16":"<base64>",...}
                   {"event":"done","id":"u1",...}   {"event":"cancelled","id":"u1"}
                   {"event":"error","id":"u1","message":"..."}
                   {"event":"transcript","id":"t1","text":"...","seconds":0.4,"audioSeconds":3.1}
                   {"event":"transcript","id":"t1","error":"..."}

Which engine speaks comes from work/voice-config.json, written by miss_voice.benchmark from measured
speed and similarity; --engine overrides it. The prepared reference is cloned only when
work/reference/rights.json records why it may be, for exactly that file (its SHA-256); otherwise
the engine's own voice is used and the status says why.

Speech synthesis loads only when asked ("load_tts", or the first "speak"), so a worker started just
to transcribe answers within a few seconds. A newer "speak" replaces the one in progress (latest
wins), which is what a live assistant wants when the user interrupts. A streamed utterance
("stream": true) is the exception: more text for the same id is appended to it, so a reply can be
spoken sentence by sentence while the model is still writing, as one continuous stream of chunks
with a single "done" after "speak_end". Transcription runs on its own thread and never waits for
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
from pathlib import Path
from typing import Callable, Iterator

MAX_TEXT = 6000
MAX_ID = 64
# A streamed utterance that receives neither more text nor "speak_end" for this long is closed,
# so an abandoned stream can never hold the synthesizer.
STREAM_IDLE_S = 120.0

Emit = Callable[[dict], None]


@dataclass
class Job:
    id: str
    text: str
    style: str
    seed: int | None
    stream: bool = False
    cancel: threading.Event = field(default_factory=threading.Event)
    # Streamed utterances only: text segments in order; None closes the utterance.
    segments: "queue.Queue[str | None]" = field(default_factory=queue.Queue)
    generation: int = 0  # the synthesizer's generation when queued; a stop makes it stale


class _Load:
    """Queue marker: load the synthesis models."""


LOAD = _Load()


def load_voice_config() -> dict | None:
    from . import paths

    try:
        config = json.loads(paths.VOICE_CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return config if isinstance(config, dict) else None


def resolve_engine(args: argparse.Namespace, config: dict | None) -> tuple[str, str]:
    """(engine, how it was chosen): "override" (--engine), "measured" (benchmark) or "default"."""
    from .engine import ENGINES
    from .pocket_engine import missing_files

    if args.engine:
        return args.engine, "override"
    if config and config.get("engine") in ENGINES:
        return config["engine"], "measured"
    return ("pocket" if not missing_files() else "chatterbox"), "default"


def cloning_reference(args: argparse.Namespace) -> tuple[Path | None, str | None, str | None]:
    """(reference to clone, rights basis, note shown when the engine's own voice is used instead)."""
    from . import paths
    from .prepare_reference import read_rights_record, sha256_file

    reference = Path(args.reference) if args.reference else paths.REFERENCE_WAV
    if not reference.is_file():
        if args.reference:
            raise FileNotFoundError(f"Reference voice not found: {reference}")
        return None, None, "No prepared reference yet. Run miss_voice.prepare_reference."
    record = read_rights_record(paths.RIGHTS_FILE)
    if record is None or record.get("reference_sha256") != sha256_file(reference):
        return None, None, ("The reference has no matching rights record (work/reference/rights.json). "
                            "Run miss_voice.prepare_reference.")
    return reference, record["basis"], None


def default_loader(args: argparse.Namespace):
    """Loads the configured engine and its voice. Returns (engine, status fields)."""
    from .engine import create_engine

    config = load_voice_config()
    kind, choice = resolve_engine(args, config)
    reference, basis, note = cloning_reference(args)
    measured = config if config and config.get("engine") == kind else None
    threads = args.threads or (measured or {}).get("threads")
    engine = create_engine(kind, model=args.model, threads=threads)
    if reference is not None:
        engine.set_voice(reference, args.name)
    else:
        engine.use_builtin_voice()
    summary = (measured or {}).get("summary") or {}
    return engine, {
        "engine": kind,
        "engineLabel": engine.label,
        "engineChoice": choice,
        "voice": "cloned:reference" if reference is not None else "builtin",
        "voiceNote": note,
        "rightsBasis": basis,
        "measured": None if not summary else {
            "rtf": summary.get("rtf"),
            "firstChunkMs": summary.get("first_chunk_ms_max"),
            "similarity": summary.get("similarity"),
            "similarityNorm": summary.get("similarity_norm"),
            "wer": summary.get("wer"),
            "at": measured.get("chosen_at"),
        },
    }


class Synthesizer:
    """Owns the speech engine on one thread so loading and synthesis never block stdin."""

    def __init__(self, args: argparse.Namespace, emit: Emit, load_engine=None):
        from . import paths
        from .cache import SpeechCache

        self.args = args
        self.emit = emit
        self.load_engine = load_engine or default_loader
        self.engine = None
        self.status: dict = {}
        self.loading = False
        self.cache = None if args.no_cache else SpeechCache(paths.SPEECH_CACHE)
        self.queue: "queue.Queue[Job | _Load | None]" = queue.Queue()
        self.lock = threading.Lock()
        self.current: Job | None = None
        self.open_stream: Job | None = None  # the streamed utterance that accepts more text
        # Bumped by every cancel. A job queued before it never starts, even if the synthesis
        # thread had already taken it off the queue when the cancel arrived.
        self.generation = 0
        self.thread = threading.Thread(target=self._loop, name="voice-synth", daemon=True)
        self.thread.start()

    @property
    def state(self) -> str:
        return "ready" if self.engine is not None else ("loading" if self.loading else "off")

    def request_load(self) -> None:
        self.queue.put(LOAD)

    def speak(self, job: Job) -> None:
        with self.lock:
            if job.stream:
                target = self.open_stream
                if target is not None and target.id == job.id and not target.cancel.is_set():
                    target.segments.put(job.text)  # more of the same reply
                    return
            self._cancel_locked()
            job.generation = self.generation
            if job.stream:
                job.segments.put(job.text)
                self.open_stream = job
            self.queue.put(job)

    def end_stream(self, job_id: str) -> None:
        with self.lock:
            target = self.open_stream
            if target is not None and target.id == job_id:
                target.segments.put(None)
                self.open_stream = None

    def cancel(self) -> None:
        with self.lock:
            self._cancel_locked()

    def _cancel_locked(self) -> None:
        self.generation += 1
        for job in {id(j): j for j in (self.current, self.open_stream) if j is not None}.values():
            job.cancel.set()
            job.segments.put(None)  # wakes a stream that is waiting for text
        self.open_stream = None
        kept: list[_Load] = []
        dropped: list[Job] = []
        try:
            while True:
                item = self.queue.get_nowait()
                if isinstance(item, _Load):
                    kept.append(item)  # stopping speech must not undo a pending model load
                elif isinstance(item, Job):
                    dropped.append(item)
        except queue.Empty:
            pass
        for item in kept:
            self.queue.put(item)
        for job in dropped:
            self.emit({"event": "cancelled", "id": job.id})

    def close(self) -> None:
        self.cancel()
        self.queue.put(None)

    def _ensure_engine(self) -> bool:
        if self.engine is not None:
            return True
        self.loading = True
        try:
            from .styles import STYLES

            engine, info = self.load_engine(self.args)
            warm = engine.warm_up()
        except Exception as error:  # reported, and a later request may retry the load
            self.emit({"event": "error", "fatal": True, "message": f"{type(error).__name__}: {error}"})
            return False
        finally:
            self.loading = False
        self.engine = engine
        self.status = {
            **info,
            "model": engine.model_name,
            "voiceName": engine.voice_name,
            "sampleRate": engine.sr,
            "loadSeconds": round(engine.load_seconds, 2),
            "warmupSeconds": round(warm, 2),
            # Seconds of speech per second of compute at warm-up (above 1 keeps up with playback).
            "realtimeFactor": None if engine.warmup_realtime is None else round(engine.warmup_realtime, 3),
            "firstChunkMs": None if engine.first_chunk_ms is None else round(engine.first_chunk_ms, 1),
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
            with self.lock:
                stale = item.cancel.is_set() or item.generation != self.generation
                if not stale:
                    self.current = item
            if stale:
                self.emit({"event": "cancelled", "id": item.id})
                continue
            try:
                self._run(item)
            except Exception as error:
                self.emit({"event": "error", "id": item.id, "message": f"{type(error).__name__}: {error}"})
            finally:
                with self.lock:
                    self.current = None
                    if self.open_stream is item:
                        self.open_stream = None

    def _texts(self, job: Job) -> Iterator[str]:
        if not job.stream:
            yield job.text
            return
        while not job.cancel.is_set():
            try:
                text = job.segments.get(timeout=STREAM_IDLE_S)
            except queue.Empty:
                return  # abandoned: nobody sent more text or speak_end
            if text is None:
                return
            yield text

    def _render(self, job: Job, engine, style, text: str) -> Iterator[tuple[dict, float, bool]]:
        """(payload, synthesis seconds, from cache) for each chunk of one piece of text."""
        from . import audio as au

        key = None
        if self.cache is not None:
            key = self.cache.key(engine.model_name, engine.voice_id, style, text, job.seed)
            entry = self.cache.load(key)
            if entry is not None and int(entry.get("sampleRate", 0)) == engine.sr:
                for payload in entry["chunks"]:
                    yield {k: v for k, v in payload.items() if k != "index"}, 0.0, True
                return
        rendered: list[dict] = []
        for chunk in engine.stream(text, style, job.seed, job.cancel):
            if job.cancel.is_set():
                return
            payload = {
                "last": chunk.last, "text": chunk.text,
                "speechSeconds": round(chunk.speech_seconds, 3),
                "pcm16": base64.b64encode(au.to_pcm16(chunk.audio)).decode("ascii"),
            }
            rendered.append(payload)
            yield payload, chunk.synth_seconds, False
        if job.cancel.is_set() or key is None or not rendered:
            return
        try:
            self.cache.save(key, engine.sr, rendered)
        except OSError as error:  # a full disk must not break speech
            print(f"speech cache write failed: {error}", file=sys.stderr)

    def _run(self, job: Job) -> None:
        from .styles import get_style

        engine = self.engine
        style = get_style(job.style)
        started = time.perf_counter()
        index = 0
        segments = 0
        audio_seconds = 0.0
        synth_seconds = 0.0
        cached_only = True
        for text in self._texts(job):
            if job.cancel.is_set():
                break
            first = True
            for payload, seconds, cached in self._render(job, engine, style, text):
                if job.cancel.is_set():
                    break
                pcm16 = payload["pcm16"]
                if first and segments > 0 and style.pause_s > 0:
                    # The pause between streamed sentences, ahead of the next sentence's audio.
                    silence = b"\x00\x00" * int(engine.sr * style.pause_s)
                    pcm16 = base64.b64encode(silence + base64.b64decode(pcm16)).decode("ascii")
                first = False
                audio_seconds += len(pcm16) * 3 / 4 / 2 / engine.sr
                synth_seconds += seconds
                cached_only = cached_only and cached
                self.emit({"event": "chunk", "id": job.id, "sampleRate": engine.sr, "synthSeconds": round(seconds, 3),
                           **({"cached": True} if cached else {}), **payload,
                           "last": payload["last"] and not job.stream, "index": index, "pcm16": pcm16})
                index += 1
            segments += 1
        if job.cancel.is_set():
            self.emit({"event": "cancelled", "id": job.id})
            return
        cached = cached_only and index > 0
        self.emit({"event": "done", "id": job.id, "chunks": index, "cached": cached, "segments": segments,
                   "audioSeconds": round(audio_seconds, 3),
                   "synthSeconds": round(time.perf_counter() - started if cached else synth_seconds, 3)})


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


class Session:
    """One worker's request handling, separate from stdio so it can be tested."""

    def __init__(self, args: argparse.Namespace, emit: Emit, load_engine=None):
        self.emit = emit
        self.synth = Synthesizer(args, emit, load_engine)
        self.recognizer = Recognizer(args.stt_threads, emit)

    def handle(self, message: dict) -> bool:
        """Handles one request. Returns False when the worker should exit."""
        op = message.get("op")
        if op == "speak":
            job_id = str(message.get("id", ""))[:MAX_ID]
            text = message.get("text")
            if not job_id or not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
                self.emit({"event": "error", "id": job_id or None,
                           "message": f"speak needs an id and 1 to {MAX_TEXT} characters of text."})
                return True
            seed = message.get("seed")
            self.synth.speak(Job(job_id, text, str(message.get("style") or "conversational"),
                                 seed if isinstance(seed, int) else None, stream=message.get("stream") is True))
        elif op == "speak_end":
            job_id = str(message.get("id", ""))[:MAX_ID]
            if job_id:
                self.synth.end_stream(job_id)
        elif op == "transcribe":
            request_id = str(message.get("id", ""))[:MAX_ID]
            rate = message.get("sampleRate")
            pcm16 = message.get("pcm16")
            if not request_id:
                self.emit({"event": "error", "message": "transcribe needs an id."})
            elif not isinstance(rate, int) or not 8000 <= rate <= 48000 or not isinstance(pcm16, str) or not pcm16:
                self.emit({"event": "transcript", "id": request_id,
                           "error": "transcribe needs base64 PCM16 audio and a sample rate from 8000 to 48000 Hz."})
            else:
                self.recognizer.submit({"id": request_id, "sampleRate": rate, "pcm16": pcm16})
        elif op == "load_tts":
            self.synth.request_load()
        elif op == "stop":
            self.synth.cancel()
        elif op == "status":
            self.emit({"event": "status", **self.synth.status, "tts": self.synth.state,
                       "stt": self.recognizer.state, "busy": self.synth.current is not None})
        elif op == "shutdown":
            return False
        else:
            self.emit({"event": "error", "message": f"Unknown op: {op!r}"})
        return True

    def close(self) -> None:
        self.synth.close()
        self.recognizer.close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    from .engine import ENGINES

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engine", choices=list(ENGINES), default=None,
                        help="speech engine; overrides the measured choice in work/voice-config.json")
    parser.add_argument("--model", choices=["nano", "turbo"], default="turbo", help="Chatterbox variant")
    parser.add_argument("--reference", default=None, help="reference WAV to clone (needs a matching rights record)")
    parser.add_argument("--name", default="miss-minutes")
    parser.add_argument("--threads", type=int, default=None, help="PyTorch threads for synthesis")
    parser.add_argument("--stt-threads", type=int, default=None, help="CTranslate2 threads for recognition")
    parser.add_argument("--tts", choices=["eager", "lazy"], default="eager",
                        help="load the synthesis models at start (eager) or on first use (lazy)")
    parser.add_argument("--no-cache", action="store_true", help="do not reuse previously rendered lines")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    # The protocol owns the real stdout. Anything a library prints goes to stderr instead,
    # so a stray warning can never corrupt the JSON stream.
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    # Requests are read from a private copy of stdin, and the standard input becomes the null
    # device. On Windows, importing scipy.linalg on the synthesis thread otherwise waits until the
    # host writes another line, because the main thread is blocked reading that pipe; the engine
    # would never finish loading while the host waits for "ready".
    requests = os.fdopen(os.dup(0), "r", encoding="utf-8")
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.close(null)
    write_lock = threading.Lock()

    def emit(message: dict) -> None:
        with write_lock:
            proto.write(json.dumps(message, separators=(",", ":")) + "\n")
            proto.flush()

    args = parse_args(argv)
    session = Session(args, emit)
    emit({"event": "started", "tts": args.tts, "pid": os.getpid()})
    if args.tts == "eager":
        session.synth.request_load()

    for line in requests:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("not an object")
        except ValueError:
            emit({"event": "error", "message": "Malformed request line."})
            continue
        if not session.handle(message):
            break

    session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
