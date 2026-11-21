"""Scenario previews: speaker-similarity helpers, the benchmark table and the listening page.

    python -m miss_voice.previews          # same as python -m miss_voice.benchmark

Rendering and measuring live in miss_voice.benchmark, which writes previews/<engine>/<scenario>.wav,
previews/benchmark.json, previews/benchmark.md and previews/index.html (open it in a browser to
listen to both engines side by side).
"""
from __future__ import annotations

import html

import numpy as np

from . import audio as au


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def load_encoder():
    """Chatterbox's speaker encoder: the one yardstick used for every engine."""
    from .prepare_reference import load_voice_encoder

    return load_voice_encoder()


def embedding(encoder, wav: np.ndarray, sr: int) -> np.ndarray:
    from .prepare_reference import embed

    return embed(encoder, au.resample(wav, sr, 16000).astype(np.float32))


def ceiling(encoder, reference: np.ndarray, sr: int) -> float:
    """The reference against itself: its first half compared with its second half."""
    half = len(reference) // 2
    return round(cosine(embedding(encoder, reference[:half], sr), embedding(encoder, reference[half:], sr)), 3)


def _fmt(value, spec: str = ".2f") -> str:
    return "n/a" if value is None else format(value, spec)


def markdown(report: dict) -> str:
    cal = report["calibration"]
    th = report["thresholds"]
    lines = [
        "# Miss Minutes voice benchmark",
        "",
        f"Generated {report['generated']} on {report['machine']['processor'] or 'this PC'} "
        f"({report['machine']['cpu_count']} logical CPUs, {report['machine']['threads']} PyTorch threads), "
        f"seed {report['seed']}.",
        f"Reference: `{report['reference']['path']}` ({report['reference']['seconds']} s, SHA-256 "
        f"`{report['reference']['sha256'][:16]}...`), rights basis: {report['rights_basis']}.",
        "",
        "RTF is synthesis wall time divided by audio duration (below 1 is faster than real time). First chunk "
        "is the time from the request to the first audio the worker can send. Similarity is the cosine of "
        "Chatterbox voice-encoder embeddings against the reference; normalized = (sim - floor) / "
        f"(ceiling - floor), with ceiling {cal['ceiling']:.3f} (reference first half against second half) and "
        f"floor {cal['floor']:.3f} ({cal['floor_source']}). WER is a Whisper base.en round trip against the script.",
        "",
        "Unrelated voices against the reference: "
        + ", ".join(f"{kind} built-in {value:.3f}" for kind, value in cal["unrelated"].items()) + ".",
        "",
        "Chatterbox conditions its speech on this same voice encoder, so its similarity can read higher than "
        "a listener would judge; Pocket TTS does not use it.",
        "",
        "| Engine | Scenario | Audio s | Wall s | RTF | First chunk ms | Similarity | Normalized | WER | File |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for result in report["engines"].values():
        for row in result["rows"]:
            lines.append(
                f"| {result['label']} | {row['label']} | {row['audio_s']:.2f} | {row['wall_s']:.2f} | "
                f"{_fmt(row['rtf'], '.3f')} | {row['first_chunk_ms']:.0f} | {row['similarity']:.3f} | "
                f"{_fmt(row['similarity_norm'], '.3f')} | {row['wer']:.3f} | `{row['file']}` |")
    lines += [
        "",
        "| Engine | RTF | First chunk max ms | First chunk median ms | Similarity | Normalized | WER | Thresholds |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for result in report["engines"].values():
        s = result["summary"]
        verdict = "all pass" if not result["shortfall"] else "; ".join(result["shortfall"])
        lines.append(
            f"| {result['label']} | {s['rtf']:.3f} | {s['first_chunk_ms_max']:.0f} | {s['first_chunk_ms_median']:.0f} | "
            f"{s['similarity']:.3f} | {_fmt(s['similarity_norm'], '.3f')} | {s['wer']:.3f} | {verdict} |")
    choice = report["choice"]
    lines += [
        "",
        f"Thresholds: RTF <= {th['rtf']}, first chunk <= {th['first_chunk_ms']:.0f} ms, normalized similarity >= "
        f"{th['similarity_norm']}, WER <= {th['wer']}.",
        "",
        f"**Live engine: {choice['engine']}** ({choice['rule']})"
        + (f". Shortfall: {'; '.join(choice['shortfall'])}." if choice["shortfall"] else "."),
        "",
        "Private, local audio: do not publish or ship these files.",
        "",
    ]
    return "\n".join(lines)


def page(report: dict) -> str:
    """A local listening page with both engines side by side for every scenario."""
    engines = report["engines"]
    first = next(iter(engines.values()), None)
    scenarios = [row["scenario"] for row in first["rows"]] if first else []
    sections = []
    for key in scenarios:
        cells = []
        label = key
        for kind, result in engines.items():
            row = next((r for r in result["rows"] if r["scenario"] == key), None)
            if row is None:
                continue
            label = row["label"]
            cells.append(f"""
        <div class="cell"><h3>{html.escape(result['label'])}</h3>
          <audio controls preload="metadata" src="{html.escape(kind)}/{html.escape(key)}.wav"></audio>
          <p class="stats">{row['audio_s']:.1f} s &middot; RTF {_fmt(row['rtf'], '.2f')} &middot; first audio
          {row['first_chunk_ms']:.0f} ms &middot; voice match {row['similarity']:.2f}
          (normalized {_fmt(row['similarity_norm'])}) &middot; word error {row['wer'] * 100:.0f}%</p></div>""")
        sections.append(f"""
    <section class="card"><h2>{html.escape(label)}</h2><div class="pair">{''.join(cells)}</div></section>""")
    choice = report["choice"]
    cal = report["calibration"]
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Miss Minutes voice previews</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{{margin:0;background:#120D08;color:#fde68a;font:15px/1.5 ui-monospace,Consolas,monospace;padding:32px}}
  h1{{margin:0 0 4px;color:#fbbf24}} .sub{{color:#d9a441;margin:0 0 24px}}
  .card{{background:#1c130a;border:1px solid #92400e;border-radius:14px;padding:18px;margin:0 0 16px;max-width:1100px}}
  h2{{margin:0 0 10px;color:#f59e0b;text-transform:uppercase;letter-spacing:.12em;font-size:14px}}
  h3{{margin:0 0 6px;color:#fbbf24;font-size:13px}}
  .pair{{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}}
  audio{{width:100%}} .stats{{color:#a16207;font-size:12px;margin:6px 0 0}}
  .note{{max-width:1100px;margin-top:24px;color:#a16207;font-size:12px}}
</style></head><body>
<h1>Miss Minutes &mdash; voice previews</h1>
<p class="sub">Cloned from the prepared reference &middot; live engine: {html.escape(str(choice['engine']))}
({html.escape(choice['rule'])}) &middot; generated {html.escape(report['generated'])}</p>
{''.join(sections)}
<p class="note">Voice match is the cosine of speaker embeddings against the reference; on this machine an
unrelated voice scores {cal['floor']:.2f} and the reference against itself {cal['ceiling']:.2f}. Word error is a
Whisper check of intelligibility. RTF below 1 is faster than real time. Private, local audio: do not publish
or ship these files.</p>
</body></html>"""


def main(argv: list[str] | None = None) -> int:
    from .benchmark import main as benchmark_main

    return benchmark_main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
