$ErrorActionPreference = "Stop"

$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$environmentFile = Join-Path $projectDirectory ".env"

Write-Host "Laptop Assistant setup" -ForegroundColor Cyan
Write-Host "Your API key stays in a local file that Git ignores. Never paste it into chat or commit it."

if (Test-Path -LiteralPath $environmentFile) {
    $replace = Read-Host "A local .env file already exists. Replace its API key? (y/N)"
    if ($replace -notmatch "^[Yy]$") {
        Write-Host "No changes made."
        exit 0
    }
}

$apiKey = Read-Host "Paste your OpenAI API key"
if ([string]::IsNullOrWhiteSpace($apiKey) -or $apiKey.Length -lt 20) {
    throw "That does not look like a valid API key. Nothing was saved."
}

$settings = @(
    "OPENAI_API_KEY=$apiKey"
    "PORT=3199"
    "OPENAI_REALTIME_MODEL=gpt-realtime-2.1"
    "OPENAI_VOICE=marin"
    "ASSISTANT_ALLOWED_ROOTS="
) -join [Environment]::NewLine

[System.IO.File]::WriteAllText($environmentFile, $settings, [System.Text.UTF8Encoding]::new($false))
Write-Host "Setup complete. Double-click start-assistant.cmd to launch." -ForegroundColor Green
