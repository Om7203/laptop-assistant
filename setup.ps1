$ErrorActionPreference = "Stop"

$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$environmentFile = Join-Path $projectDirectory ".env"
$credentialFile = Join-Path $projectDirectory "config\openai-key.dpapi"

Write-Host "Laptop Assistant setup" -ForegroundColor Cyan
Write-Host "Your API key will be encrypted for your Windows account. Never paste it into chat or commit it."

if (Test-Path -LiteralPath $credentialFile) {
    $replace = Read-Host "An encrypted API key already exists. Replace it? (y/N)"
    if ($replace -notmatch "^[Yy]$") {
        Write-Host "No changes made."
        exit 0
    }
}

$apiKey = Read-Host "Paste your OpenAI API key (the screen will stay blank)" -AsSecureString
if ($apiKey.Length -lt 20) { throw "That does not look like a valid API key. Nothing was saved." }
$encryptedKey = ConvertFrom-SecureString -SecureString $apiKey
if ([string]::IsNullOrWhiteSpace($encryptedKey)) { throw "No API key was entered. Nothing was saved." }

[System.IO.File]::WriteAllText($credentialFile, $encryptedKey, [System.Text.UTF8Encoding]::new($false))

$settings = @(
    "PORT=3199"
    "OPENAI_REALTIME_MODEL=gpt-realtime-2.1"
    "OPENAI_VOICE=marin"
    "ASSISTANT_ALLOWED_ROOTS="
) -join [Environment]::NewLine

[System.IO.File]::WriteAllText($environmentFile, $settings, [System.Text.UTF8Encoding]::new($false))
Write-Host "Setup complete. The key is encrypted and tied to this Windows account." -ForegroundColor Green
Write-Host "Double-click start-assistant.cmd to launch."
