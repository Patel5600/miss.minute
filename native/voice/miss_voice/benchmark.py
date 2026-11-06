"""Benchmark the speech engines on the four preview scenarios and choose the live engine.

    python -m miss_voice.benchmark                     # both engines, then work/voice-config.json
    python -m miss_voice.benchmark --engines pocket --no-config

For every engine and scenario it writes previews/<engine>/<scenario>.wav and measures:
  rtf             synthesis wall time / audio duration (below 1 is faster than real time)
  first_chunk_ms  time from the request to the first audio chunk the worker could send
  similarity      cosine of speaker embeddings (Chatterbox's voice encoder) against the
                  reference, raw and normalized as (sim - floor) / (ceiling - floor), where the
                  ceiling is the reference against itself (first half vs second half) and the
                  floor is an unrelated voice (Chatterbox's built-in speaker) against it
  wer             word error rate of a Whisper round trip against the script

Live engine (PLAN.md, Voice V4): among engines with rtf <= 0.5, first chunk <= 600 ms, normalized
similarity >= 0.5 and WER <= 0.15, the most similar; if none passes, the fastest with WER <= 0.15,
with the shortfall recorded. Timed work runs under the shared benchmark lock
(.work/locks/benchmark.lock), so other workflows hold off heavy CPU work while it is measured.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import os
import platform
import time
from pathlib import Path
from typing import Iterator

import numpy as np

from . import analysis, paths
from . import audio as au
from .engine import ENGINE_LABELS, ENGINES, create_engine
from .styles import STYLES

MAX_RTF = 0.5
MAX_FIRST_CHUNK_MS = 600.0
MIN_SIMILARITY_NORM = 0.5
MAX_WER = 0.15
LOCK = Path(os.environ.get("MISS_VOICE_BENCH_LOCK", paths.REPO / ".work" / "locks" / "benchmark.lock"))
CONFIG_SCHEMA = 1


@contextlib.contextmanager
def measurement_lock(purpose: str) -> Iterator[None]:
    """Holds the machine-wide benchmark lock while timing, and always removes it afterwards."""
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    LOCK.write_text(json.dumps({"pid": os.getpid(), "purpose": purpose,
                                "since": dt.datetime.now().astimezone().isoformat(timespec="seconds")}),
                    encoding="utf-8")
    try:
        yield
    finally:
        try:
            LOCK.unlink()
        except FileNotFoundError:
            pass


def passes(summary: dict) -> dict[str, bool]:
    return {
        "rtf": summary["rtf"] <= MAX_RTF,
        "first_chunk": summary["first_chunk_ms_max"] <= MAX_FIRST_CHUNK_MS,
        "similarity": summary["similarity_norm"] is not None and summary["similarity_norm"] >= MIN_SIMILARITY_NORM,
        "wer": summary["wer"] <= MAX_WER,
    }


def shortfall(summary: dict) -> list[str]:
    checks = passes(summary)
    out = []
    if not checks["rtf"]:
        out.append(f"RTF {summary['rtf']:.2f} > {MAX_RTF}")
    if not checks["first_chunk"]:
        out.append(f"first chunk {summary['first_chunk_ms_max']:.0f} ms > {MAX_FIRST_CHUNK_MS:.0f} ms")
    if not checks["similarity"]:
        value = summary["similarity_norm"]
        out.append("normalized similarity " + ("unknown" if value is None else f"{value:.2f}")
                   + f" < {MIN_SIMILARITY_NORM}")
    if not checks["wer"]:
        out.append(f"WER {summary['wer']:.2f} > {MAX_WER}")
    return out


def choose(summaries: dict[str, dict]) -> dict:
    """The live-engine rule. `summaries` maps an engine to its aggregate numbers."""
    passing = [kind for kind, summary in summaries.items() if all(passes(summary).values())]
    if passing:
        best = max(passing, key=lambda kind: summaries[kind]["similarity_norm"])
        return {"engine": best, "rule": "passes every threshold; most similar", "shortfall": []}
    intelligible = [kind for kind, summary in summaries.items() if summary["wer"] <= MAX_WER]
    if intelligible:
        best = min(intelligible, key=lambda kind: summaries[kind]["rtf"])
        return {"engine": best, "rule": "no engine passes every threshold; fastest with WER <= 0.15",
                "shortfall": shortfall(summaries[best])}
    return {"engine": None, "rule": "no engine is intelligible (WER > 0.15 everywhere)", "shortfall": []}


def summarize(rows: list[dict]) -> dict:
    audio = sum(row["audio_s"] for row in rows)
    wall = sum(row["wall_s"] for row in rows)
    norms = [row["similarity_norm"] for row in rows if row["similarity_norm"] is not None]
    return {
        "rtf": round(wall / audio, 3) if audio else float("inf"),
        "first_chunk_ms_max": round(max(row["first_chunk_ms"] for row in rows), 1),
        "first_chunk_ms_median": round(float(np.median([row["first_chunk_ms"] for row in rows])), 1),
        "similarity": round(float(np.mean([row["similarity"] for row in rows])), 3),
        "similarity_norm": round(float(np.mean(norms)), 3) if norms else None,
        "wer": round(float(np.mean([row["wer"] for row in rows])), 3),
        "audio_s": round(audio, 2),
        "wall_s": round(wall, 2),
    }


def _timed_render(engine, text: str, style, seed: int) -> tuple[np.ndarray, float, float]:
    """(audio, wall seconds, first chunk ms) through the same streaming path the worker uses."""
    started = time.perf_counter()
    first = None
    parts: list[np.ndarray] = []
    for chunk in engine.stream(text, style, seed):
        if first is None and chunk.audio.size:
            first = (time.perf_counter() - started) * 1000.0
        parts.append(chunk.audio)
    wall = time.perf_counter() - started
    audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
    return audio, wall, (first if first is not None else wall * 1000.0)


def run(engines: list[str], threads: int, seed: int, out: Path, write_config: bool) -> dict:
    from . import previews
    from .prepare_reference import read_rights_record, sha256_file

    if not paths.REFERENCE_WAV.is_file():
        raise SystemExit("No prepared reference. Run miss_voice.prepare_reference first.")
    reference = au.load_audio(paths.REFERENCE_WAV, paths.SAMPLE_RATE)
    rights = read_rights_record(paths.RIGHTS_FILE)
    encoder = previews.load_encoder()
    ref_emb = previews.embedding(encoder, reference, paths.SAMPLE_RATE)
    calibration = {"ceiling": previews.ceiling(encoder, reference, paths.SAMPLE_RATE)}
    unrelated: dict[str, float] = {}

    results: dict[str, dict] = {}
    for kind in engines:
        print(f"\n== {ENGINE_LABELS[kind]}: loading", flush=True)
        engine = create_engine(kind, threads=threads)
        rows: list[dict] = []
        rendered: list[tuple[str, np.ndarray, float, float]] = []
        # The engine's own default voice, for the similarity floor, then the clone. Not timed.
        engine.use_builtin_voice()
        other = engine.synthesize("The weather is clear and the afternoon is quiet today.", "informational", seed=3)
        unrelated[kind] = round(previews.cosine(ref_emb, previews.embedding(encoder, other, engine.sr)), 3)
        engine.set_voice(paths.REFERENCE_WAV, "miss-minutes")
        warm = engine.warm_up()
        print(f"loaded in {engine.load_seconds:.1f}s, warm-up {warm:.1f}s", flush=True)
        with measurement_lock(f"voice benchmark: {kind}"):
            for key, style in STYLES.items():
                audio, wall, first_ms = _timed_render(engine, style.script, style, seed)
                rendered.append((key, audio, wall, first_ms))
                print(f"{style.label:<14} {len(audio) / engine.sr:5.1f}s audio in {wall:6.1f}s, "
                      f"first chunk {first_ms:7.0f} ms", flush=True)
        # Scoring is not timed, so it runs outside the lock.
        for key, audio, wall, first_ms in rendered:
            style = STYLES[key]
            file = out / kind / f"{key}.wav"
            au.write_wav(file, audio, engine.sr)
            seconds = len(audio) / engine.sr
            spoken, _ = analysis.transcribe(audio, engine.sr)
            pitch = analysis.f0_stats(audio, engine.sr)
            rows.append({
                "scenario": key, "label": style.label, "file": str(file),
                "audio_s": round(seconds, 2), "wall_s": round(wall, 2),
                "rtf": round(wall / seconds, 3) if seconds else None,
                "first_chunk_ms": round(first_ms, 1),
                "similarity": round(previews.cosine(ref_emb, previews.embedding(encoder, audio, engine.sr)), 3),
                "similarity_norm": None,  # filled in once the floor is known
                "wer": round(analysis.wer(style.script, spoken), 3),
                "transcript": spoken,
                "f0_median": None if pitch["median"] is None else round(pitch["median"], 1),
                "lufs": analysis.loudness_lufs(audio, engine.sr),
                "peak_dbfs": round(au.peak_dbfs(audio), 1),
            })
        results[kind] = {
            "label": engine.label, "model": engine.model_name, "threads": threads,
            "load_s": round(engine.load_seconds, 1), "warmup_s": round(warm, 1),
            "warmup_first_chunk_ms": None if engine.first_chunk_ms is None else round(engine.first_chunk_ms, 1),
            "rows": rows,
        }
        del engine

    # The floor is Chatterbox's built-in speaker, as in the earlier previews; Pocket's catalog
    # voice is reported next to it as a second, independent unrelated voice.
    calibration["floor"] = unrelated.get("chatterbox", unrelated.get("pocket"))
    calibration["floor_source"] = "chatterbox built-in voice" if "chatterbox" in unrelated else "pocket catalog voice (alba)"
    calibration["unrelated"] = unrelated
    span = calibration["ceiling"] - calibration["floor"]
    for result in results.values():
        for row in result["rows"]:
            row["similarity_norm"] = round((row["similarity"] - calibration["floor"]) / span, 3) if span > 0 else None
        result["summary"] = summarize(result["rows"])
        result["passes"] = passes(result["summary"])
        result["shortfall"] = shortfall(result["summary"])

    choice = choose({kind: result["summary"] for kind, result in results.items()})
    report = {
        "generated": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "machine": {"processor": platform.processor(), "cpu_count": os.cpu_count(), "threads": threads},
        "seed": seed,
        "reference": {"path": str(paths.REFERENCE_WAV), "sha256": sha256_file(paths.REFERENCE_WAV),
                      "seconds": round(len(reference) / paths.SAMPLE_RATE, 2)},
        "rights_basis": None if rights is None else rights["basis"],
        "thresholds": {"rtf": MAX_RTF, "first_chunk_ms": MAX_FIRST_CHUNK_MS,
                       "similarity_norm": MIN_SIMILARITY_NORM, "wer": MAX_WER},
        "calibration": calibration,
        "engines": results,
        "choice": choice,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "benchmark.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    (out / "benchmark.md").write_text(previews.markdown(report), encoding="utf-8")
    (out / "index.html").write_text(previews.page(report), encoding="utf-8")

    if write_config and choice["engine"] is not None:
        live = results[choice["engine"]]
        config = {
            "schema": CONFIG_SCHEMA,
            "engine": choice["engine"],
            "label": live["label"],
            "model": live["model"],
            "threads": threads,
            "reference": str(paths.REFERENCE_WAV),
            "reference_sha256": report["reference"]["sha256"],
            "rule": choice["rule"],
            "shortfall": choice["shortfall"],
            "summary": live["summary"],
            "chosen_at": report["generated"],
            "benchmark": str(out / "benchmark.json"),
        }
        paths.VOICE_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        temp = paths.VOICE_CONFIG.with_name(paths.VOICE_CONFIG.name + ".tmp")
        temp.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(temp, paths.VOICE_CONFIG)
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engines", default=",".join(ENGINES), help="comma-separated: chatterbox,pocket")
    ap.add_argument("--threads", type=int, default=4, help="PyTorch threads for every engine")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", type=Path, default=paths.PREVIEWS)
    ap.add_argument("--no-config", action="store_true", help="measure only; leave work/voice-config.json alone")
    args = ap.parse_args(argv)
    engines = [name.strip() for name in args.engines.split(",") if name.strip()]
    unknown = [name for name in engines if name not in ENGINES]
    if unknown or not engines:
        ap.error(f"unknown engine(s): {', '.join(unknown) or '(none)'}; choose from {', '.join(ENGINES)}")
    report = run(engines, args.threads, args.seed, args.out, write_config=not args.no_config)
    for kind, result in report["engines"].items():
        s = result["summary"]
        print(f"{result['label']:<17} RTF {s['rtf']:.3f}  first chunk max {s['first_chunk_ms_max']:.0f} ms  "
              f"similarity {s['similarity']:.3f} (normalized {s['similarity_norm']})  WER {s['wer']:.3f}")
    choice = report["choice"]
    print(f"live engine: {choice['engine']} ({choice['rule']})"
          + (f"; shortfall: {'; '.join(choice['shortfall'])}" if choice["shortfall"] else ""))
    print("BENCHMARK-DONE", args.out / "benchmark.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
