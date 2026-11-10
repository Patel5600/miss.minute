# Downloads the model files the voice engine needs:
#   models\chatterbox      Chatterbox speech synthesis (Turbo by default)
#   models\pocket          Kyutai Pocket TTS (CPU voice cloning, the live voice on this laptop)
#   models\whisper\base.en faster-whisper speech recognition (the desktop app's voice input)
# The released chatterbox-tts package (0.1.7) runs the Turbo model, so Turbo is the default.
# Nano shares every other file; add it with -IncludeNano once a released package supports it.
# Skips the unused 1 GB legacy s3gen.safetensors that snapshot_download would also fetch.
# Resumable: rerun after an interruption and curl continues partial files.
# Every file is pinned to a commit and verified against its SHA-256 where one is published.
#
# Pocket TTS: Kyutai gates its voice-cloning weights (kyutai/pocket-tts) behind a Hugging Face
# login and an acceptable-use click-through: no cloning without the speaker's explicit, lawful
# consent, no impersonation, fraud or misinformation. Those terms apply to this copy too. The
# weights are CC-BY-4.0, and latent-variable/pocket-tts-cloning-en redistributes the 2026-04
# English checkpoint unchanged; the hash below is the one Kyutai publishes for
# kyutai/pocket-tts languages/english_2026-04/model.safetensors, so a modified file is refused.
# The tokenizer and the catalog voice come from Kyutai's ungated repository.
param([switch]$IncludeNano, [switch]$SkipPocket)
$ErrorActionPreference = 'Stop'

$turbo   = @{ repo = 'ResembleAI/chatterbox-turbo';      rev = '749d1c1a46eb10492095d68fbcf55691ccf137cd'; dir = 'chatterbox' }
$nano    = @{ repo = 'ResembleAI/chatterbox-nano';       rev = '71ccd1d0081b430592cea481f4307e764e07bc64'; dir = 'chatterbox' }
$whisper = @{ repo = 'Systran/faster-whisper-base.en';  rev = '3d3d5dee26484f91867d81cb899cfcf72b96be6c'; dir = 'whisper\base.en' }
$pocketClone = @{ repo = 'latent-variable/pocket-tts-cloning-en';      rev = 'ead4edebb72d7dd41468bbf8456f2822b3aa3fb1'; dir = 'pocket\english_2026-04' }
$pocketOpen  = @{ repo = 'kyutai/pocket-tts-without-voice-cloning';    rev = 'a7056f505a4a8ca72d8b5fb1440071d6f1a35739'; dir = 'pocket\english_2026-04' }

# Shared by Turbo and Nano (identical hashes in both repositories). `remote` is the path inside the
# repository when it differs from the local file name.
$items = @(
  @{ src = $turbo; name = 've.safetensors';             sha = 'f0921cab452fa278bc25cd23ffd59d36f816d7dc5181dd1bef9751a7fb61f63c' },
  @{ src = $turbo; name = 'conds.pt';                   sha = 'b1852099306fd6a7814eb9d0bd10186caba7249596cc23868f78a0eefbfa5033' },
  @{ src = $turbo; name = 'added_tokens.json';          sha = $null },
  @{ src = $turbo; name = 'merges.txt';                 sha = $null },
  @{ src = $turbo; name = 'special_tokens_map.json';    sha = $null },
  @{ src = $turbo; name = 'tokenizer_config.json';      sha = $null },
  @{ src = $turbo; name = 'vocab.json';                 sha = $null },
  @{ src = $turbo; name = 's3gen_meanflow.safetensors'; sha = 'd65cb687a2ed581ee6cc297e919ffefa63386944f42364ae13b78a594945514f' },
  @{ src = $turbo; name = 't3_turbo_v1.safetensors';    sha = 'fcf1f8c1d651bb7e3acd69ee5be269b4ac10c02980b7708213d598bc9f7cdf87' },
  # Speech recognition: CTranslate2 conversion of Whisper base.en (MIT), about 150 MB.
  @{ src = $whisper; name = 'config.json';    sha = 'f3bc3821e9fc76a27bae538e11ae5b677dcdd352b4600429ce7951d398569aeb' },
  @{ src = $whisper; name = 'model.bin';      sha = '2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef' },
  @{ src = $whisper; name = 'tokenizer.json'; sha = '929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df' },
  @{ src = $whisper; name = 'vocabulary.txt'; sha = 'ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf' }
)
if ($IncludeNano) {
  $items += @{ src = $nano; name = 't3_nano_v1.safetensors'; sha = '72b110185087d945dbdf54dee4e333848e1811bdd5fd6cb16ceb8da50006f0c9' }
}
if (-not $SkipPocket) {
  # About 225 MB: the 100M-parameter model with its Mimi encoder (needed to clone), the tokenizer,
  # and one catalog voice used when no prepared reference exists.
  $items += @(
    @{ src = $pocketClone; name = 'model.safetensors'; remote = 'languages/english/model.safetensors';
       sha = '473f47d99560bd50eb8b4509d3cacfe7f316ab20bdca86505403a2e6a936a6e9' },
    # Not an LFS file, so no SHA-256 is published; this one was checked against the repository's
    # git blob id (fe3e7fe6185e4a3bc218fa8f5ed993ecb098201c) at the pinned revision.
    @{ src = $pocketOpen; name = 'tokenizer.json'; remote = 'languages/english_2026-04/tokenizer.json';
       sha = 'f498428e1eafee50492f7be13dc9bfafcfc12e508cd0eb1b01c92ecd5d8c6687' },
    @{ src = $pocketOpen; name = 'alba.safetensors'; remote = 'languages/english_2026-04/embeddings/alba.safetensors';
       sha = '1b704240aa9da36ab32ac05c46a8a9172031c82bc07dbab9df834f0063b24985' }
  )
}

foreach ($item in $items) {
  $name = $item.name
  $dest = Join-Path $PSScriptRoot (Join-Path 'models' $item.src.dir)
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $target = Join-Path $dest $name
  $label = Join-Path $item.src.dir $name
  $expected = $item.sha
  $remote = if ($item.remote) { $item.remote } else { $name }

  if ($expected -and (Test-Path $target)) {
    $actual = (Get-FileHash -Algorithm SHA256 $target).Hash.ToLowerInvariant()
    if ($actual -eq $expected) { Write-Output "ok (cached)  $label"; continue }
  }

  Write-Output "downloading  $label"
  $url = "https://huggingface.co/$($item.src.repo)/resolve/$($item.src.rev)/$remote"
  & curl.exe -sS -L --fail --retry 8 --retry-delay 5 --retry-all-errors -C - -o $target $url
  # 33 = server answered 416 because the file was already complete; the hash check decides.
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 33) { throw "curl failed for $label (exit $LASTEXITCODE)" }

  if ($expected) {
    $actual = (Get-FileHash -Algorithm SHA256 $target).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "SHA-256 mismatch for $label. Delete it and rerun." }
    Write-Output "verified     $label"
  }
}
Write-Output 'MODELS-DONE'
