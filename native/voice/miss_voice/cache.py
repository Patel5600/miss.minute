"""Disk cache of rendered lines.

On a CPU-only laptop Chatterbox renders well below real time, so the local voice is used for
lines that repeat (greetings, click quotes, previews). The first request renders and stores the
audio; later requests for the same text, style and voice stream straight from disk.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path

from . import text as txt

VERSION = 1
MAX_ENTRIES = 256


class SpeechCache:
    def __init__(self, root: Path, max_entries: int = MAX_ENTRIES):
        self.root = Path(root)
        self.max_entries = max_entries

    def key(self, model: str, voice_id: str | None, style, text: str, seed: int | None) -> str:
        identity = [VERSION, model, voice_id or "unknown", style.key, style.temperature, style.top_p,
                    style.repetition_penalty, style.pause_s, txt.clean(text), seed]
        return hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode("utf-8")).hexdigest()[:32]

    def _path(self, key: str) -> Path:
        return self.root / f"{key}.json"

    def load(self, key: str) -> dict | None:
        path = self._path(key)
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if entry.get("version") != VERSION or not entry.get("chunks"):
            return None
        try:
            os.utime(path)  # least recently used entries are evicted first
        except OSError:
            pass
        return entry

    def save(self, key: str, sample_rate: int, chunks: list[dict]) -> None:
        if not chunks:
            return
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._path(key)
        temp = path.with_suffix(".tmp")
        entry = {"version": VERSION, "sampleRate": sample_rate, "savedAt": int(time.time()), "chunks": chunks}
        temp.write_text(json.dumps(entry, separators=(",", ":")), encoding="utf-8")
        os.replace(temp, path)
        self._evict()

    def _evict(self) -> None:
        try:
            entries = sorted(self.root.glob("*.json"), key=lambda item: item.stat().st_mtime)
        except OSError:
            return
        for stale in entries[: max(0, len(entries) - self.max_entries)]:
            try:
                stale.unlink()
            except OSError:
                pass
