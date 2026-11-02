"""The JSON-lines worker's request handling, driven with a fake engine (no models are loaded)."""
from __future__ import annotations

import base64
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from miss_voice import paths, worker
from miss_voice.engine import Chunk
from miss_voice.prepare_reference import build_rights_record, write_rights_record

SAMPLES = 240  # 10 ms at 24 kHz per fake chunk


class FakeEngine:
    kind = "fake"
    label = "Fake TTS"
    model_name = "fake-1"
    sr = 24000
    voice_name = "miss-minutes"
    voice_id = "miss-minutes-0123456789abcdef"
    load_seconds = 0.01
    warmup_realtime = 4.0
    first_chunk_ms = 12.0

    def __init__(self, chunks: int = 3, hold_after_first: threading.Event | None = None):
        self.chunks = chunks
        self.hold_after_first = hold_after_first  # blocks the stream after its first chunk until set
        self.texts: list[str] = []

    def warm_up(self) -> float:
        return 0.01

    def stream(self, text, style, seed=None, cancel=None):
        self.texts.append(text)
        for index in range(self.chunks):
            if cancel is not None and cancel.is_set():
                return
            if index == 1 and self.hold_after_first is not None:
                self.hold_after_first.wait(5)
            yield Chunk(index=index, last=index == self.chunks - 1, text=text,
                        audio=np.full(SAMPLES, 0.1, dtype=np.float32), speech_seconds=SAMPLES / self.sr,
                        synth_seconds=0.001)


class Recorder:
    def __init__(self):
        self.events: list[dict] = []
        self.changed = threading.Condition()

    def __call__(self, message: dict) -> None:
        json.dumps(message)  # every event must be JSON-serialisable, as on the real stdout
        with self.changed:
            self.events.append(message)
            self.changed.notify_all()

    def wait_for(self, predicate, timeout: float = 5.0) -> dict:
        deadline = time.monotonic() + timeout
        with self.changed:
            while True:
                for event in self.events:
                    if predicate(event):
                        return event
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AssertionError(f"event not seen; got {[e.get('event') for e in self.events]}")
                self.changed.wait(remaining)

    def of(self, kind: str, job_id: str | None = None) -> list[dict]:
        with self.changed:
            return [e for e in self.events if e.get("event") == kind and (job_id is None or e.get("id") == job_id)]


STATUS = {"engine": "fake", "engineLabel": "Fake TTS", "engineChoice": "measured", "voice": "cloned:reference",
          "voiceNote": None, "rightsBasis": "owner-attested", "measured": None}


def make_session(engine: FakeEngine) -> tuple[worker.Session, Recorder]:
    recorder = Recorder()
    args = worker.parse_args(["--no-cache", "--tts", "lazy"])
    session = worker.Session(args, recorder, load_engine=lambda _args: (engine, dict(STATUS)))
    return session, recorder


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.sessions: list[worker.Session] = []

    def tearDown(self):
        for session in self.sessions:
            session.close()

    def session(self, engine: FakeEngine) -> tuple[worker.Session, Recorder]:
        session, recorder = make_session(engine)
        self.sessions.append(session)
        return session, recorder

    def test_speak_emits_chunks_then_done(self):
        session, events = self.session(FakeEngine(chunks=3))
        self.assertTrue(session.handle({"op": "speak", "id": "u1", "text": "Hello there.", "style": "narration"}))
        done = events.wait_for(lambda e: e.get("event") == "done" and e["id"] == "u1")
        chunks = events.of("chunk", "u1")
        self.assertEqual([c["index"] for c in chunks], [0, 1, 2])
        self.assertEqual([c["last"] for c in chunks], [False, False, True])
        self.assertTrue(all(c["sampleRate"] == 24000 for c in chunks))
        self.assertEqual(len(base64.b64decode(chunks[0]["pcm16"])), SAMPLES * 2)
        self.assertEqual(done["chunks"], 3)
        self.assertFalse(done["cached"])
        self.assertLess(events.events.index(chunks[-1]), events.events.index(done))

    def test_stop_cancels_mid_stream(self):
        hold = threading.Event()
        session, events = self.session(FakeEngine(chunks=5, hold_after_first=hold))
        session.handle({"op": "speak", "id": "u1", "text": "A long line that is interrupted."})
        events.wait_for(lambda e: e.get("event") == "chunk" and e["id"] == "u1")
        session.handle({"op": "stop"})
        hold.set()
        events.wait_for(lambda e: e.get("event") == "cancelled" and e["id"] == "u1")
        time.sleep(0.05)
        self.assertEqual(events.of("done", "u1"), [])
        self.assertLess(len(events.of("chunk", "u1")), 5)

    def test_newer_speak_replaces_the_current_one(self):
        hold = threading.Event()
        session, events = self.session(FakeEngine(chunks=3, hold_after_first=hold))
        session.handle({"op": "speak", "id": "u1", "text": "First."})
        events.wait_for(lambda e: e.get("event") == "chunk" and e["id"] == "u1")
        session.handle({"op": "speak", "id": "u2", "text": "Second."})
        hold.set()
        events.wait_for(lambda e: e.get("event") == "cancelled" and e["id"] == "u1")
        events.wait_for(lambda e: e.get("event") == "done" and e["id"] == "u2")
        self.assertEqual(events.of("done", "u1"), [])

    def test_streamed_utterance_is_one_continuous_reply(self):
        engine = FakeEngine(chunks=2)
        session, events = self.session(engine)
        session.handle({"op": "speak", "id": "r1", "text": "First sentence.", "stream": True, "style": "conversational"})
        session.handle({"op": "speak", "id": "r1", "text": "Second sentence.", "stream": True})
        time.sleep(0.05)
        self.assertEqual(events.of("done", "r1"), [], "a streamed reply stays open until speak_end")
        session.handle({"op": "speak", "id": "r1", "text": "Third sentence.", "stream": True})
        session.handle({"op": "speak_end", "id": "r1"})
        done = events.wait_for(lambda e: e.get("event") == "done" and e["id"] == "r1")
        chunks = events.of("chunk", "r1")
        self.assertEqual([c["index"] for c in chunks], list(range(6)))
        self.assertTrue(all(not c["last"] for c in chunks))
        self.assertEqual(engine.texts, ["First sentence.", "Second sentence.", "Third sentence."])
        self.assertEqual(done["segments"], 3)
        self.assertEqual(done["chunks"], 6)
        # The style's pause sits in front of each later sentence, never inside the first.
        pause = int(24000 * 0.22) * 2
        sizes = [len(base64.b64decode(c["pcm16"])) for c in chunks]
        self.assertEqual(sizes, [SAMPLES * 2, SAMPLES * 2, SAMPLES * 2 + pause, SAMPLES * 2,
                                 SAMPLES * 2 + pause, SAMPLES * 2])

    def test_stop_ends_an_open_stream(self):
        session, events = self.session(FakeEngine(chunks=1))
        session.handle({"op": "speak", "id": "r1", "text": "Hello.", "stream": True})
        events.wait_for(lambda e: e.get("event") == "chunk" and e["id"] == "r1")
        session.handle({"op": "stop"})
        events.wait_for(lambda e: e.get("event") == "cancelled" and e["id"] == "r1")
        session.handle({"op": "speak", "id": "r1", "text": "Late text.", "stream": True})  # starts afresh
        session.handle({"op": "speak_end", "id": "r1"})
        events.wait_for(lambda e: e.get("event") == "done" and e["id"] == "r1")

    def test_status_carries_engine_voice_and_rights(self):
        session, events = self.session(FakeEngine())
        session.handle({"op": "load_tts"})
        ready = events.wait_for(lambda e: e.get("event") == "ready")
        session.handle({"op": "status"})
        status = events.wait_for(lambda e: e.get("event") == "status")
        for event in (ready, status):
            self.assertEqual(event["engine"], "fake")
            self.assertEqual(event["engineLabel"], "Fake TTS")
            self.assertEqual(event["voice"], "cloned:reference")
            self.assertEqual(event["sampleRate"], 24000)
            self.assertEqual(event["rightsBasis"], "owner-attested")
            self.assertEqual(event["firstChunkMs"], 12.0)
            self.assertEqual(event["realtimeFactor"], 4.0)
        self.assertEqual(status["tts"], "ready")
        self.assertFalse(status["busy"])

    def test_bad_requests_are_reported_not_fatal(self):
        session, events = self.session(FakeEngine())
        self.assertTrue(session.handle({"op": "speak", "id": "u1", "text": "   "}))
        self.assertTrue(session.handle({"op": "speak", "text": "No id."}))
        self.assertTrue(session.handle({"op": "dance"}))
        self.assertEqual(len(events.of("error")), 3)
        self.assertFalse(session.handle({"op": "shutdown"}))


class VoiceChoiceTest(unittest.TestCase):
    def test_engine_override_then_measured_then_default(self):
        args = worker.parse_args(["--engine", "chatterbox"])
        self.assertEqual(worker.resolve_engine(args, {"engine": "pocket"}), ("chatterbox", "override"))
        args = worker.parse_args([])
        self.assertEqual(worker.resolve_engine(args, {"engine": "pocket"}), ("pocket", "measured"))
        self.assertEqual(worker.resolve_engine(args, {"engine": "mystery"})[1], "default")
        self.assertEqual(worker.resolve_engine(args, None)[1], "default")

    def test_reference_is_cloned_only_with_a_matching_rights_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            reference = Path(tmp) / "reference.wav"
            rights = Path(tmp) / "rights.json"
            source = Path(tmp) / "clip.webm"
            source.write_bytes(b"clip")
            args = worker.parse_args([])
            with mock.patch.object(paths, "REFERENCE_WAV", reference), mock.patch.object(paths, "RIGHTS_FILE", rights):
                self.assertEqual(worker.cloning_reference(args)[:2], (None, None))  # nothing prepared
                reference.write_bytes(b"voice")
                found, basis, note = worker.cloning_reference(args)
                self.assertIsNone(found)  # no rights record
                self.assertIn("rights", note)
                write_rights_record(rights, build_rights_record("owner-attested", "my words", source,
                                                                reference=reference))
                self.assertEqual(worker.cloning_reference(args), (reference, "owner-attested", None))
                reference.write_bytes(b"a different voice")  # the record no longer matches the file
                self.assertIsNone(worker.cloning_reference(args)[0])


if __name__ == "__main__":
    unittest.main()
