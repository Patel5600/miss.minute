# One-time setup for the private Miss Minutes voice engine (Windows, CPU only).
#   .\setup.ps1              Turbo speech model (about 3 GB) and Whisper base.en recognition (150 MB)
#   .\setup.ps1 -IncludeNano  also fetches the small Nano T3 checkpoint (needs a newer package)
param([switch]$IncludeNano)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) {
  $base = (python -c "import site; print(site.getuserbase())").Trim()
  $uv = Get-ChildItem $base -Recurse -Filter uv.exe -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $uv) { throw 'uv was not found. Install it with: python -m pip install --user uv' }

# Some hf_xet builds crash on the Xet backend; plain HTTP downloads are reliable.
$env:HF_HUB_DISABLE_XET = '1'

Write-Output "uv sync (Python 3.12, CPU PyTorch)"
& $uv sync --python 3.12 --no-progress
if ($LASTEXITCODE -ne 0) { throw "uv sync failed (exit $LASTEXITCODE)" }

& (Join-Path $PSScriptRoot 'download_models.ps1') -IncludeNano:$IncludeNano

# The desktop host runs the worker with Hugging Face offline, so prove recognition loads that way.
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
& (Join-Path $PSScriptRoot '.venv\Scripts\python.exe') -X utf8 -m miss_voice.stt --check
if ($LASTEXITCODE -ne 0) { throw "Speech recognition self-check failed (exit $LASTEXITCODE)" }
Write-Output 'SETUP-DONE'
