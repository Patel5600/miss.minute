"""Render the four scenario previews, measure them, and build previews/index.html.

    python -m miss_voice.previews                 # Nano model
    python -m miss_voice.previews --model turbo   # larger model, slower, usually steadier
"""
from __future__ import annotations

import argparse
import html
import json
import time
from pathlib import Path

import numpy as np

from . import analysis, paths
from . import audio as au
from .engine import VoiceEngine
from .styles import STYLES


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def calibrate(engine: VoiceEngine, reference: np.ndarray) -> dict:
    """Give the similarity scores a scale: 'ceiling' is the reference against itself,
    'floor' is an unrelated speaker (the model's built-in voice) against the reference."""
    ref_emb = engine.speaker_embedding(reference, paths.SAMPLE_RATE)
    half = len(reference) // 2
    ceiling = cosine(engine.speaker_embedding(reference[:half], paths.SAMPLE_RATE),
                     engine.speaker_embedding(reference[half:], paths.SAMPLE_RATE))
    engine.use_builtin_voice()
    other = engine.synthesize("The weather is clear and the afternoon is quiet today.", "informational", seed=3)
    floor = cosine(ref_emb, engine.speaker_embedding(other, engine.sr))
    engine.set_voice(paths.REFERENCE_WAV, "miss-minutes")
    return {"reference_halves": round(ceiling, 3), "unrelated_voice": round(floor, 3)}


def page(items: list[dict], summary: dict) -> str:
    cards = []
    for it in items:
        m = it["metrics"]
        match = ("" if m["speaker_similarity"] is None
                 else f" &middot; voice match {m['speaker_similarity']:.2f}")
        cards.append(f"""
    <section class="card">
      <h2>{html.escape(it['label'])}</h2>
      <p class="blurb">{html.escape(it['blurb'])}</p>
      <audio controls preload="metadata" src="{html.escape(it['file'])}"></audio>
      <p class="script">&ldquo;{html.escape(it['script'])}&rdquo;</p>
      <p class="stats">{m['duration_s']:.1f}s{match}
        &middot; word error {m['wer'] * 100:.0f}% &middot; {m['f0_median'] or 0:.0f} Hz median pitch
        &middot; generated at {m['realtime_factor']:.2f}&times; real time</p>
    </section>""")
    cal = summary["calibration"]
    scale = ("" if cal is None else
             f"Voice match is cosine similarity of speaker embeddings against the reference prompt. "
             f"Scale on this machine: {cal['unrelated_voice']:.2f} for an unrelated voice, "
             f"{cal['reference_halves']:.2f} for the reference compared with itself. ")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Miss Minutes voice previews</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{{margin:0;background:#120D08;color:#fde68a;font:15px/1.5 ui-monospace,Consolas,monospace;padding:32px}}
  h1{{margin:0 0 4px;color:#fbbf24}} .sub{{color:#d9a441;margin:0 0 24px}}
  .grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:16px;max-width:1100px}}
  .card{{background:#1c130a;border:1px solid #92400e;border-radius:14px;padding:18px}}
  h2{{margin:0;color:#f59e0b;text-transform:uppercase;letter-spacing:.12em;font-size:14px}}
  .blurb{{margin:4px 0 12px;color:#d9a441}} audio{{width:100%}}
  .script{{font-style:italic;color:#fde68a}} .stats{{color:#a16207;font-size:12px}}
  .note{{max-width:1100px;margin-top:24px;color:#a16207;font-size:12px}}
</style></head><body>
<h1>Miss Minutes &mdash; voice previews</h1>
<p class="sub">Local voice &middot; model: Chatterbox {summary['model']} &middot; voice: {summary['voice']} &middot; generated {summary['generated']}</p>
<div class="grid">{''.join(cards)}
</div>
<p class="note">{scale}Word error is a Whisper check of intelligibility.
Private, local audio: do not publish or ship these files. Every clip carries Resemble&rsquo;s inaudible
PerTh watermark that marks it as synthetic.</p>
</body></html>"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", choices=["nano", "turbo"], default="turbo")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", type=Path, default=paths.PREVIEWS)
    args = ap.parse_args(argv)

    args.out.mkdir(parents=True, exist_ok=True)
    cloned = paths.REFERENCE_WAV.is_file()
    reference = au.load_audio(paths.REFERENCE_WAV, paths.SAMPLE_RATE) if cloned else None

    print(f"loading Chatterbox {args.model}...")
    engine = VoiceEngine(args.model)
    if cloned:
        engine.set_voice(paths.REFERENCE_WAV, "miss-minutes")
    else:
        engine.use_builtin_voice()
    print(f"voice: {engine.voice_name}; loaded in {engine.load_seconds:.1f}s; warm-up {engine.warm_up():.1f}s")

    calibration = ref_emb = None
    if cloned:
        calibration = calibrate(engine, reference)
        ref_emb = engine.speaker_embedding(reference, paths.SAMPLE_RATE)
        print("similarity scale:", calibration)

    items: list[dict] = []
    for key, style in STYLES.items():
        started = time.perf_counter()
        wav = engine.synthesize(style.script, style, seed=args.seed)
        elapsed = time.perf_counter() - started
        file = f"{key}.wav"
        au.write_wav(args.out / file, wav, engine.sr)

        spoken, _ = analysis.transcribe(wav, engine.sr)
        pitch = analysis.f0_stats(wav, engine.sr)
        metrics = {
            "duration_s": round(len(wav) / engine.sr, 2),
            "synth_s": round(elapsed, 2),
            "realtime_factor": round((len(wav) / engine.sr) / elapsed, 2),
            "speaker_similarity": (None if ref_emb is None
                                   else round(cosine(ref_emb, engine.speaker_embedding(wav, engine.sr)), 3)),
            "wer": round(analysis.wer(style.script, spoken), 3),
            "f0_median": None if pitch["median"] is None else round(pitch["median"], 1),
            "lufs": analysis.loudness_lufs(wav, engine.sr),
            **analysis.clipping(wav),
            "watermark": analysis.watermark_score(wav, engine.sr),
            "transcript": spoken,
        }
        items.append({"key": key, "label": style.label, "blurb": style.blurb, "script": style.script,
                      "file": file, "metrics": metrics})
        print(f"{style.label:<14} {metrics['duration_s']:5.1f}s  match {metrics['speaker_similarity']}  "
              f"WER {metrics['wer']*100:4.0f}%  f0 {metrics['f0_median']}  "
              f"{metrics['realtime_factor']:.2f}x realtime  watermark {metrics['watermark']}")

    summary = {"model": args.model, "voice": engine.voice_name, "generated": time.strftime("%Y-%m-%d %H:%M"),
               "seed": args.seed, "calibration": calibration, "items": items}
    (args.out / "metrics.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (args.out / "index.html").write_text(page(items, summary), encoding="utf-8")
    print(f"open: {args.out / 'index.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
