$ErrorActionPreference = "Stop"

$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$credentialFile = Join-Path $projectDirectory "config\openai-key.dpapi"
$setupScript = Join-Path $projectDirectory "setup.ps1"
$serverScript = Join-Path $projectDirectory "src\server.js"
$assistantUrl = "http://127.0.0.1:3199"

function Read-EncryptedApiKey {
    param([Parameter(Mandatory = $true)][string]$Path)

    $encrypted = [System.IO.File]::ReadAllText($Path)
    $secure = ConvertTo-SecureString $encrypted
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Get-AssistantHealth {
    try {
        return Invoke-RestMethod -Uri "$assistantUrl/api/health" -TimeoutSec 1
    }
    catch {
        return $null
    }
}

function Get-AssistantListenerProcess {
    $listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 3199 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    $ownerProcessId = if ($listener) { $listener.OwningProcess } else { $null }

    if (-not $ownerProcessId) {
        $match = netstat -ano |
            Select-String -Pattern '^\s*TCP\s+127\.0\.0\.1:3199\s+\S+\s+LISTENING\s+(\d+)\s*$' |
            Select-Object -First 1
        if ($match -and $match.Matches.Count -gt 0) {
            $ownerProcessId = [int]$match.Matches[0].Groups[1].Value
        }
    }

    if (-not $ownerProcessId) { return $null }
    return Get-Process -Id $ownerProcessId -ErrorAction SilentlyContinue
}

function Open-AssistantWindow {
    $chromeCandidates = @(
        @(
            (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
            (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
            (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
        ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    )

    if ($chromeCandidates.Count -gt 0) {
        Start-Process -FilePath $chromeCandidates[0] -ArgumentList @("--app=$assistantUrl", "--start-maximized")
        return
    }

    Start-Process $assistantUrl
}

if (-not $env:OPENAI_API_KEY -and -not (Test-Path -LiteralPath $credentialFile)) {
    Write-Host "First-time setup is required." -ForegroundColor Cyan
    & $setupScript
}

if (-not $env:OPENAI_API_KEY) {
    $env:OPENAI_API_KEY = Read-EncryptedApiKey -Path $credentialFile
}

if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) {
    throw "The encrypted API key could not be loaded. Run setup.ps1 again."
}

$existingHealth = Get-AssistantHealth
if ($existingHealth -and $existingHealth.realtime_configured) {
    Open-AssistantWindow
    exit 0
}

if ($existingHealth) {
    $existingProcess = Get-AssistantListenerProcess
    if ($existingProcess -and $existingProcess.ProcessName -eq "node") {
        Write-Host "Restarting the assistant to load the saved key..."
        Stop-Process -Id $existingProcess.Id -Force
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 100
            if (-not (Get-AssistantHealth)) { break }
        }
    }
}

$serverProcess = Start-Process -FilePath "node.exe" -ArgumentList @($serverScript) -WorkingDirectory $projectDirectory -WindowStyle Hidden -PassThru
$env:OPENAI_API_KEY = $null

$health = $null
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    $health = Get-AssistantHealth
    if ($health) { break }
    if ($serverProcess.HasExited) { break }
}

if (-not $health) {
    throw "The local assistant server did not start."
}
if (-not $health.realtime_configured) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    throw "The server started but did not receive the API key. Run setup.ps1 again."
}

Open-AssistantWindow
