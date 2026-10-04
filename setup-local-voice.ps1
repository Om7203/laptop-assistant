$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvDirectory = Join-Path $projectDirectory ".venv-voice"
$python = Join-Path $venvDirectory "Scripts\python.exe"

Write-Host "Laptop Assistant local voice setup" -ForegroundColor Cyan
Write-Host "This installs faster-whisper in a private project environment and downloads the base English speech model."

if (-not (Test-Path -LiteralPath $python)) {
    $available = py -0p 2>$null
    $version = if ($available -match '-V:3\.11') { "3.11" } elseif ($available -match '-V:3\.9') { "3.9" } else { $null }
    if (-not $version) { throw "Python 3.9 or 3.11 is required for local voice." }
    Write-Host "Creating the private Python environment..."
    py "-$version" -m venv $venvDirectory
}

Write-Host "Installing pinned local speech packages..."
& node (Join-Path $projectDirectory "voice\install_dependencies.mjs") $python $projectDirectory
if ($LASTEXITCODE -ne 0) { throw "The local speech packages could not be installed." }
$wheels = Get-ChildItem -LiteralPath (Join-Path $projectDirectory ".voice-wheels") -Filter "*.whl" | Select-Object -ExpandProperty FullName
& $python -m pip install --disable-pip-version-check --progress-bar off --no-index --no-deps $wheels
if ($LASTEXITCODE -ne 0) { throw "The local speech packages could not be installed." }

$env:WHISPER_MODEL = "base.en"
$env:WHISPER_MODEL_DIR = Join-Path $projectDirectory "models\whisper"
$env:WHISPER_DEVICE = "cpu"
$env:WHISPER_COMPUTE_TYPE = "int8"
$env:HF_HOME = Join-Path $projectDirectory "models\huggingface"
$env:HF_HUB_DISABLE_XET = "1"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"

Write-Host "Downloading and checking the speech model..."
@'
import os
from faster_whisper import WhisperModel
WhisperModel(
    os.environ["WHISPER_MODEL"],
    device=os.environ["WHISPER_DEVICE"],
    compute_type=os.environ["WHISPER_COMPUTE_TYPE"],
    download_root=os.environ["WHISPER_MODEL_DIR"],
)
print("Local speech model is ready.")
'@ | & $python -

Write-Host "Setup complete. Restart Laptop Assistant, then use Push to talk." -ForegroundColor Green
