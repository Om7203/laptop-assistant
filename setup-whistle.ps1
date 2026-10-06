$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $projectDirectory ".venv-voice\Scripts\python.exe"
$needle = Join-Path $projectDirectory ".venv-voice\Scripts\needle.exe"
$modelDirectory = Join-Path $projectDirectory "models\whistle"
$engineDirectory = Join-Path $projectDirectory "models\needle-engine"
$environmentFile = Join-Path $projectDirectory ".env"

Write-Host "Goffy Whistle setup" -ForegroundColor Cyan
Write-Host "This adds the experimental Cactus Whistle speech backend. It remains fully local after setup."

if (-not (Test-Path -LiteralPath $python)) {
    throw "Run setup-local-voice.cmd first so the shared private voice environment is available."
}

Write-Host "Installing the pinned Cactus runtime..."
$previousNoIndex = $env:PIP_NO_INDEX
$env:PIP_NO_INDEX = "0"
try {
    & $python -m pip install --disable-pip-version-check --progress-bar off --index-url "https://pypi.org/simple" "cactus-needle==3.1.1"
} finally {
    $env:PIP_NO_INDEX = $previousNoIndex
}
if ($LASTEXITCODE -ne 0) { throw "Cactus Whistle could not be installed." }

New-Item -ItemType Directory -Force -Path $modelDirectory | Out-Null
$env:HF_HOME = Join-Path $projectDirectory "models\huggingface"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
$env:NEEDLE_TELEMETRY = "0"
$env:DO_NOT_TRACK = "1"
Write-Host "Downloading the local Cactus engine and 16.9 MB Whistle model..."
& $needle fetch --generation 3 --out $engineDirectory
if ($LASTEXITCODE -ne 0) { throw "The local Cactus engine could not be downloaded." }
& $needle download whistle --out $modelDirectory
if ($LASTEXITCODE -ne 0) { throw "The Whistle model could not be downloaded." }

$weights = Get-ChildItem -LiteralPath $modelDirectory -Recurse -Filter "whistle.cact" | Select-Object -First 1 -ExpandProperty FullName
if (-not $weights) { throw "The Whistle model download completed but whistle.cact was not found." }
$engine = Get-ChildItem -LiteralPath $engineDirectory -Recurse -Filter "libneedle.dll" | Select-Object -First 1 -ExpandProperty FullName
if (-not $engine) { throw "The Cactus engine download completed but libneedle.dll was not found." }
$env:NEEDLE_WHISTLE_WEIGHTS = $weights
$env:NEEDLE3_LIB_PATH = $engine
@'
import needle
needle.Whistle()
print("Whistle is ready.")
'@ | & $python -
if ($LASTEXITCODE -ne 0) { throw "Whistle could not load on this computer." }

$existing = if (Test-Path -LiteralPath $environmentFile) { Get-Content -LiteralPath $environmentFile -Raw } else { "" }
if ($existing -match '(?m)^STT_BACKEND=') {
    $updated = $existing -replace '(?m)^STT_BACKEND=.*$', 'STT_BACKEND=whistle'
} else {
    $separator = if ($existing -and -not $existing.EndsWith("`n")) { "`r`n" } else { "" }
    $updated = "$existing${separator}STT_BACKEND=whistle`r`n"
}
[System.IO.File]::WriteAllText($environmentFile, $updated, [System.Text.UTF8Encoding]::new($false))

Write-Host "Setup complete. Restart Goffy, enable voice, then say Hey Goffy." -ForegroundColor Green
Write-Host "If Whistle has a problem, the assistant will automatically retry with faster-whisper."
