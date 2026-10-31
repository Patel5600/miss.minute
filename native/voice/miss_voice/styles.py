"""Delivery styles and the four preview scenarios.

Chatterbox Turbo ignores the exaggeration and CFG knobs, so style is expressed through the
controls it does honour: sampling temperature, nucleus size, repetition penalty, and the
pause left between sentences. The definitions live in scenarios.json, which the dashboard
imports too, so the app and the command-line previews can never drift apart.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

from . import paths


@dataclass(frozen=True)
class Style:
    key: str
    label: str
    temperature: float
    top_p: float
    repetition_penalty: float
    pause_s: float  # silence between sentences
    blurb: str
    script: str  # preview text, written in Miss Minutes' voice


def _load() -> dict[str, Style]:
    raw = json.loads((paths.ROOT / "scenarios.json").read_text(encoding="utf-8"))
    return {
        key: Style(
            key=key, label=item["label"], blurb=item["blurb"], script=item["script"],
            temperature=float(item["temperature"]), top_p=float(item["top_p"]),
            repetition_penalty=float(item["repetition_penalty"]), pause_s=float(item["pause_s"]),
        )
        for key, item in raw.items()
    }


STYLES: dict[str, Style] = _load()
DEFAULT_STYLE = "conversational"


def get_style(key: str | None) -> Style:
    return STYLES.get((key or DEFAULT_STYLE).lower(), STYLES[DEFAULT_STYLE])
