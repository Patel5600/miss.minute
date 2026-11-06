"""Build a clean zero-shot cloning prompt from the source clip.

A zero-shot cloner reproduces whatever is in its sample, including background music, room
noise and any other speaker. So this step:

  1. decodes the clip and measures how much non-voice sound is present,
  2. separates the voice (Demucs) when background is audible,
  3. finds utterances with Whisper word timings,
  4. keeps only the dominant speaker (pitch and voice-encoder agreement),
  5. concatenates the best segments into a ~14 s prompt (the model uses the first 10 to 15 s).

Everything is measured and written to work/reference/report.json because the result cannot
be judged by ear from here. The reason the voice may be cloned is recorded next to it in
work/reference/rights.json: the basis, the owner's statement word for word, when it was
recorded, and SHA-256 digests of the source and of the prepared reference.

    python -m miss_voice.prepare_reference --rights own-voice
    python -m miss_voice.prepare_reference --rights owner-attested --statement "<the owner's words>"
    python -m miss_voice.prepare_reference --rights licensed --segments 1.2-4.8,9.0-13.1
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path

import numpy as np

from . import analysis, paths
from . import audio as au

SR = 24000

# Why a voice may be cloned. "owner-attested" is the owner's own statement that they hold
# permission; it is weaker than a licence or written permission, so it is recorded as exactly
# that and always carries the statement itself.
RIGHTS = ("own-voice", "licensed", "written-permission", "owner-attested")
NEEDS_STATEMENT = ("owner-attested",)
RIGHTS_SCHEMA = 1
MAX_STATEMENT = 2000


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def build_rights_record(basis: str, statement: str | None, source: Path, *, statement_date: str | None = None,
                        reference: Path | None = None, now: dt.datetime | None = None) -> dict:
    """The rights record kept next to the prepared reference. The statement is stored verbatim."""
    if basis not in RIGHTS:
        raise ValueError(f"unknown rights basis: {basis!r}")
    if basis in NEEDS_STATEMENT and not (statement or "").strip():
        raise ValueError(f"--rights {basis} needs the owner's statement (--statement).")
    source = Path(source)
    record = {
        "schema": RIGHTS_SCHEMA,
        "basis": basis,
        "statement": statement,
        "statement_date": statement_date,
        "recorded_at": (now or dt.datetime.now().astimezone()).isoformat(timespec="seconds"),
        "source": str(source),
        "source_sha256": sha256_file(source),
        "reference": None if reference is None else str(reference),
        "reference_sha256": None if reference is None else sha256_file(reference),
        "tool": "miss_voice.prepare_reference",
    }
    return record


def write_rights_record(path: Path, record: dict) -> None:
    """Atomic: a reader sees the old record or the new one, never half of one."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temp, path)


def read_rights_record(path: Path) -> dict | None:
    try:
        record = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) and record.get("basis") in RIGHTS else None


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", type=Path, default=paths.SOURCE_CLIP)
    ap.add_argument("--rights", required=True, choices=list(RIGHTS),
                    help="Why you may clone this voice. Required: only clone a voice you own, hold a "
                         "licence for, or have the speaker's written permission to use. 'owner-attested' "
                         "records the owner's own statement that they hold permission, and needs --statement.")
    ap.add_argument("--statement", default=None,
                    help="The owner's words, recorded verbatim in rights.json (required for owner-attested).")
    ap.add_argument("--statement-date", default=None, help="When the owner made the statement (YYYY-MM-DD).")
    ap.add_argument("--separate", choices=["auto", "always", "never"], default="auto")
    ap.add_argument("--target-seconds", type=float, default=14.0)
    ap.add_argument("--segments", default=None, help="manual override, seconds in the source: 1.2-4.8,9-13")
    ap.add_argument("--whisper", default="base.en")
    args = ap.parse_args(argv)
    if args.statement is not None and len(args.statement) > MAX_STATEMENT:
        ap.error(f"--statement is limited to {MAX_STATEMENT} characters.")
    if args.rights in NEEDS_STATEMENT and not (args.statement or "").strip():
        ap.error(f"--rights {args.rights} needs --statement with the owner's words, recorded verbatim.")
    if args.statement_date is not None:
        try:
            dt.date.fromisoformat(args.statement_date)
        except ValueError:
            ap.error("--statement-date must be YYYY-MM-DD.")
    return args


def separate_vocals(stereo44: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (vocals, everything_else) as mono float32 at 44.1 kHz using Demucs htdemucs."""
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    model = get_model("htdemucs")
    model.eval()
    wav = torch.from_numpy(stereo44)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.inference_mode():
        sources = apply_model(model, ((wav - mean) / std)[None], device="cpu", split=True,
                              overlap=0.25, progress=False)[0]
    sources = sources * std + mean
    vocals = sources[model.sources.index("vocals")]
    rest = sources.sum(0) - vocals
    return vocals.mean(0).numpy().astype(np.float32), rest.mean(0).numpy().astype(np.float32)


def background_ratio_db(vocals: np.ndarray, rest: np.ndarray, sr: int) -> float:
    """Level of non-voice sound relative to the voice, measured only while the voice is active."""
    hop = int(sr * 0.02)
    n = min(len(vocals), len(rest)) // hop * hop
    v = np.sqrt(np.mean(vocals[:n].reshape(-1, hop) ** 2, axis=1))
    r = np.sqrt(np.mean(rest[:n].reshape(-1, hop) ** 2, axis=1))
    active = v > (v.max() * 0.1)
    if not active.any():
        return -120.0
    return float(20 * np.log10((np.mean(r[active] ** 2) ** 0.5 + 1e-9) / (np.mean(v[active] ** 2) ** 0.5 + 1e-9)))


def utterances(segments, max_gap: float = 0.35) -> list[dict]:
    words = [w for s in segments for w in (s.words or [])]
    out: list[dict] = []
    for w in words:
        if out and w.start - out[-1]["end"] <= max_gap:
            out[-1]["end"] = float(w.end)
            out[-1]["text"] += w.word
        else:
            out.append({"start": float(w.start), "end": float(w.end), "text": w.word})
    for u in out:
        u["text"] = u["text"].strip()
    return out


def load_voice_encoder():
    from chatterbox.models.voice_encoder import VoiceEncoder
    from safetensors.torch import load_file

    ve = VoiceEncoder()
    ve.load_state_dict(load_file(paths.MODELS / "ve.safetensors"))
    return ve.eval()


def embed(ve, wav16: np.ndarray) -> np.ndarray:
    e = np.asarray(ve.embeds_from_wavs([wav16], sample_rate=16000)).reshape(-1, 256).mean(axis=0)
    return e / (np.linalg.norm(e) + 1e-9)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.source.is_file():
        raise SystemExit(f"Source clip not found: {args.source}")

    out_dir = paths.REFERENCE_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    report: dict = {"source": str(args.source), "rights_basis": args.rights}

    # 1. decode ---------------------------------------------------------------------------
    stereo44 = au.load_audio(args.source, 44100, mono=False)
    mono44 = stereo44.mean(axis=0)
    report["duration_s"] = round(len(mono44) / 44100, 2)
    report["channels_identical"] = bool(np.allclose(stereo44[0], stereo44[1], atol=1e-3))
    report["source_rms_dbfs"] = round(au.rms_dbfs(mono44), 1)
    report["source_peak_dbfs"] = round(au.peak_dbfs(mono44), 1)
    print(f"source: {report['duration_s']}s  rms {report['source_rms_dbfs']} dBFS  "
          f"peak {report['source_peak_dbfs']} dBFS  identical channels: {report['channels_identical']}")

    # 2. separate -------------------------------------------------------------------------
    working44 = mono44
    report["separation"] = "none"
    if args.separate != "never":
        print("separating voice from background (Demucs htdemucs)...")
        vocals44, rest44 = separate_vocals(stereo44)
        ratio = background_ratio_db(vocals44, rest44, 44100)
        report["background_vs_voice_db"] = round(ratio, 1)
        print(f"background level relative to voice: {ratio:.1f} dB (lower is cleaner)")
        # Separation can leave artifacts, so only use it when background is audible.
        if args.separate == "always" or ratio > -24.0:
            working44, report["separation"] = vocals44, "demucs-vocals"
            au.write_wav(out_dir / "vocals.wav", vocals44, 44100)
    print(f"using: {report['separation']}")

    wav24 = au.resample(working44, 44100, SR)
    wav16 = au.resample(working44, 44100, 16000)
    au.write_wav(out_dir / "working_24k.wav", wav24, SR)

    # 3. utterances -----------------------------------------------------------------------
    print(f"transcribing ({args.whisper})...")
    transcript, segments = analysis.transcribe(wav16, 16000, words=True, size=args.whisper)
    report["transcript"] = transcript
    print("transcript:", transcript)

    if args.segments:
        spans = []
        for part in args.segments.split(","):
            a, b = part.split("-")
            spans.append({"start": float(a), "end": float(b), "text": "(manual)"})
    else:
        spans = utterances(segments)

    # 4. per-utterance measurements -------------------------------------------------------
    ve = load_voice_encoder()
    rows: list[dict] = []
    for u in spans:
        a, b = max(0.0, u["start"] - 0.05), min(len(wav16) / 16000, u["end"] + 0.08)
        seg16 = wav16[int(a * 16000): int(b * 16000)]
        seg24 = wav24[int(a * SR): int(b * SR)]
        if len(seg16) < 16000 * 0.6:
            continue
        pitch = analysis.f0_stats(seg24, SR)
        rows.append({
            "start": round(a, 2), "end": round(b, 2), "dur": round(b - a, 2), "text": u["text"],
            "rms_dbfs": round(au.rms_dbfs(seg24), 1),
            "f0_median": pitch["median"], "voiced": round(pitch["voiced_fraction"], 2),
            "emb": embed(ve, seg16),
        })
    if not rows:
        raise SystemExit("No usable speech found in the source clip.")

    # 5. dominant speaker -----------------------------------------------------------------
    weights = np.array([r["dur"] for r in rows])
    embs = np.stack([r["emb"] for r in rows])
    centroid = (embs * weights[:, None]).sum(0)
    centroid /= np.linalg.norm(centroid)
    for _ in range(3):  # re-centre on the agreeing majority
        sims = embs @ centroid
        keep = sims >= max(0.0, np.median(sims) - 0.08)
        centroid = (embs[keep] * weights[keep][:, None]).sum(0)
        centroid /= np.linalg.norm(centroid)
    sims = embs @ centroid
    f0s = np.array([r["f0_median"] or np.nan for r in rows])
    pitch_ref = np.nanmedian(f0s[sims >= np.median(sims) - 0.08]) if np.isfinite(f0s).any() else None

    for r, s in zip(rows, sims):
        r["sim"] = round(float(s), 3)
        same_pitch = pitch_ref is None or r["f0_median"] is None or abs(r["f0_median"] / pitch_ref - 1) < 0.30
        r["eligible"] = bool(s >= np.median(sims) - 0.08 and same_pitch and r["voiced"] >= 0.30
                             and r["dur"] >= 0.9 and r["rms_dbfs"] > -45)
        r["score"] = round(float(s) + 0.04 * min(r["dur"], 6.0) + 0.2 * r["voiced"], 3)

    # 6. choose and assemble --------------------------------------------------------------
    pool = [r for r in rows if r["eligible"]] if not args.segments else rows
    pool.sort(key=lambda r: r["score"], reverse=True)
    chosen: list[dict] = []
    total = 0.0
    for r in pool:
        if total >= args.target_seconds:
            break
        chosen.append(r)
        total += r["dur"]
    if total < 6.0:
        print(f"WARNING: only {total:.1f}s of clean single-speaker speech found; "
              "cloning quality will be limited (the model needs more than 5 s).")

    gap = np.zeros(int(SR * 0.15), dtype=np.float32)
    pieces = []
    for r in chosen:  # best segment first: the decoder only conditions on the first 10 s
        piece = wav24[int(r["start"] * SR): int(r["end"] * SR)]
        pieces.append(au.fade(piece, SR, 10))
        pieces.append(gap)
    prompt = au.normalize_rms(np.concatenate(pieces[:-1]), target_dbfs=-20.0)
    au.write_wav(paths.REFERENCE_WAV, prompt, SR)

    pf = analysis.f0_stats(prompt, SR)
    report.update({
        "reference_wav": str(paths.REFERENCE_WAV),
        "reference_seconds": round(len(prompt) / SR, 2),
        "reference_f0": {k: (round(v, 1) if v else v) for k, v in pf.items()},
        "reference_lufs": analysis.loudness_lufs(prompt, SR),
        "reference_clipping": analysis.clipping(prompt),
        "dominant_f0_hz": None if pitch_ref is None else round(float(pitch_ref), 1),
        "utterances": [{k: v for k, v in r.items() if k != "emb"} for r in rows],
        "chosen": [[r["start"], r["end"]] for r in chosen],
    })
    (out_dir / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    rights = build_rights_record(args.rights, args.statement, args.source, statement_date=args.statement_date,
                                 reference=paths.REFERENCE_WAV)
    write_rights_record(paths.RIGHTS_FILE, rights)
    print(f"rights: {rights['basis']} recorded at {rights['recorded_at']} -> {paths.RIGHTS_FILE}")

    print(f"\n{'start':>6} {'end':>6} {'dur':>5} {'sim':>6} {'f0':>6} {'voiced':>6}  keep  text")
    for r in rows:
        mark = "YES " if r in chosen else "no  "
        print(f"{r['start']:6.2f} {r['end']:6.2f} {r['dur']:5.2f} {r['sim']:6.3f} "
              f"{(r['f0_median'] or 0):6.0f} {r['voiced']:6.2f}  {mark}  {r['text'][:60]}")
    print(f"\nreference prompt: {report['reference_seconds']}s -> {paths.REFERENCE_WAV}")
    print(f"prompt pitch median: {report['reference_f0']['median']} Hz   LUFS: {report['reference_lufs']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
