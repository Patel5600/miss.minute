"""Filesystem layout for the private voice engine. Everything listed here stays out of git."""
from __future__ import annotations

import os
from pathlib import Path

# Some hf_xet builds crash on the Xet backend; plain HTTP downloads are reliable.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

ROOT = Path(__file__).resolve().parent.parent  # native/voice
REPO = ROOT.parent.parent

# Model caches live inside native/voice/models (gitignored), never in the user profile. Set
# before anything imports huggingface_hub or torch.hub, which read these once at import.
os.environ.setdefault("HF_HOME", str(ROOT / "models" / "hf"))
os.environ.setdefault("TORCH_HOME", str(ROOT / "models" / "torch"))  # Demucs weights

MODELS = Path(os.environ.get("MISS_VOICE_MODELS", ROOT / "models" / "chatterbox"))
# Kyutai Pocket TTS weights (voice-cloning checkpoint and tokenizer), fetched by download_models.ps1.
POCKET_MODELS = Path(os.environ.get("MISS_VOICE_POCKET", ROOT / "models" / "pocket"))
# faster-whisper (CTranslate2) speech recognition model, downloaded by download_models.ps1 so the
# worker never needs the network at run time.
WHISPER_DIR = Path(os.environ.get("MISS_VOICE_WHISPER", ROOT / "models" / "whisper" / "base.en"))
WORK = Path(os.environ.get("MISS_VOICE_WORK", ROOT / "work"))
REFERENCE_DIR = WORK / "reference"
VOICE_CACHE = WORK / "voices"
# Rendered lines, so a line the local engine has spoken once replays instantly.
SPEECH_CACHE = WORK / "speech-cache"
# Which engine speaks live, chosen by miss_voice.benchmark from measured numbers.
VOICE_CONFIG = WORK / "voice-config.json"
PREVIEWS = Path(os.environ.get("MISS_VOICE_PREVIEWS", ROOT / "previews"))
SOURCE_CLIP = Path(os.environ.get("MISS_VOICE_SOURCE", REPO / "assets" / "videoplayback.webm"))
REFERENCE_WAV = Path(os.environ.get("MISS_VOICE_REFERENCE", REFERENCE_DIR / "reference.wav"))
RIGHTS_FILE = REFERENCE_DIR / "rights.json"
TOKEN_FILE = WORK / "server-token.txt"

SAMPLE_RATE = 24000  # output rate of every engine (Chatterbox and Pocket TTS both decode at 24 kHz)
