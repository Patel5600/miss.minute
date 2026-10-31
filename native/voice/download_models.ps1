# Downloads the model files the voice engine needs:
#   models\chatterbox      Chatterbox speech synthesis (Turbo by default)
#   models\whisper\base.en faster-whisper speech recognition (the desktop app's voice input)
# The released chatterbox-tts package (0.1.7) runs the Turbo model, so Turbo is the default.
# Nano shares every other file; add it with -IncludeNano once a released package supports it.
# Skips the unused 1 GB legacy s3gen.safetensors that snapshot_download would also fetch.
# Resumable: rerun after an interruption and curl continues partial files.
# Every file is pinned to a commit and verified against its SHA-256 where one is published.
param([switch]$IncludeNano)
$ErrorActionPreference = 'Stop'

$turbo   = @{ repo = 'ResembleAI/chatterbox-turbo';      rev = '749d1c1a46eb10492095d68fbcf55691ccf137cd'; dir = 'chatterbox' }
$nano    = @{ repo = 'ResembleAI/chatterbox-nano';       rev = '71ccd1d0081b430592cea481f4307e764e07bc64'; dir = 'chatterbox' }
$whisper = @{ repo = 'Systran/faster-whisper-base.en';  rev = '3d3d5dee26484f91867d81cb899cfcf72b96be6c'; dir = 'whisper\base.en' }

# Shared by Turbo and Nano (identical hashes in both repositories).
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

foreach ($item in $items) {
  $name = $item.name
  $dest = Join-Path $PSScriptRoot (Join-Path 'models' $item.src.dir)
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $target = Join-Path $dest $name
  $label = Join-Path $item.src.dir $name
  $expected = $item.sha

  if ($expected -and (Test-Path $target)) {
    $actual = (Get-FileHash -Algorithm SHA256 $target).Hash.ToLowerInvariant()
    if ($actual -eq $expected) { Write-Output "ok (cached)  $label"; continue }
  }

  Write-Output "downloading  $label"
  $url = "https://huggingface.co/$($item.src.repo)/resolve/$($item.src.rev)/$name"
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
