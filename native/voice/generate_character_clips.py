"""Synthesizes high-fidelity authentic cloned Miss Minutes voice clips for Android app interactions.
Uses Kyutai Pocket TTS (CPU voice cloning) with the authentic TVA Miss Minutes reference.
Run:
    .\\native\\voice\\.venv\\Scripts\\python.exe -X utf8 native\\voice\\generate_character_clips.py
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import torch
from miss_voice import paths
from miss_voice.pocket_engine import PocketEngine
from miss_voice import audio as au

CLIPS = {
    "mm_jump.wav": ("Wheee! Look at me leap, sugar!", "conversational"),
    "mm_land.wav": ("Yeehaw! Stuck the landing right on this app!", "conversational"),
    "mm_sit.wav": ("Just restin' my little clock legs, sugar. Mighty comfy up here!", "conversational"),
    "mm_hang.wav": ("Look at me hangin' on for dear life! Don't drop your phone now, darlin'!", "conversational"),
    "mm_tap1.wav": ("Hey! Watch the glass, sugar! You're gonna leave smudges on my side of the screen!", "conversational"),
    "mm_tap2.wav": ("Are you pokin' my pixels? I feel that through the whole operating system, darlin'!", "conversational"),
    "mm_tap3.wav": ("Hey y'all! Don't tickle the clock!", "conversational"),
    "mm_calibrate.wav": ("Spatial anchor locked in, darlin'! That icon is all mine now!", "conversational"),
    "mm_app_switch.wav": ("Ooh, switchin' apps! I'll perch right up here on the screen border outta your way, sugar!", "conversational"),
}

DEST_DIR = ROOT.parent / "mobile" / "android" / "app" / "src" / "main" / "assets" / "audio"
DEST_DIR.mkdir(parents=True, exist_ok=True)

print("Initializing PocketEngine...")
engine = PocketEngine(threads=4)
engine.set_voice(paths.REFERENCE_WAV)
engine.warm_up()
print(f"PocketEngine ready. Generating {len(CLIPS)} character audio clips...")

for filename, (text, style) in CLIPS.items():
    dest_path = DEST_DIR / filename
    print(f"Generating {filename}: \"{text}\"")
    pcm = engine.synthesize(text, style, seed=42)
    au.write_wav(dest_path, pcm, engine.sr)
    duration_s = len(pcm) / engine.sr
    print(f"Saved {dest_path} ({duration_s:.2f}s)")

print("ALL_CLIPS_GENERATED_SUCCESSFULLY")
