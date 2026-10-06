$ErrorActionPreference = "Stop"

$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $projectDirectory "src\server.js"
$assistantUrl = "http://127.0.0.1:3199"
if (-not $env:LOG_DESTINATION) { $env:LOG_DESTINATION = Join-Path $projectDirectory "logs\assistant.log" }

function Get-AssistantHealth {
    try {
        return Invoke-RestMethod -Uri "$assistantUrl/api/health" -TimeoutSec 1
    }
    catch {
        return $null
    }
}

function Start-LocalOllamaIfNeeded {
    $environmentFile = Join-Path $projectDirectory ".env"
    $configuredUrl = "http://127.0.0.1:11434"
    if (Test-Path -LiteralPath $environmentFile) {
        $match = Select-String -LiteralPath $environmentFile -Pattern '^OLLAMA_BASE_URL=(.+)$' | Select-Object -First 1
        if ($match) { $configuredUrl = $match.Matches[0].Groups[1].Value.Trim().TrimEnd('/') }
    }
    $uri = $null
    if (-not [Uri]::TryCreate($configuredUrl, [UriKind]::Absolute, [ref]$uri)) { return }
    if ($uri.Host -notin @("127.0.0.1", "localhost", "::1")) { return }
    try {
        Invoke-RestMethod -Uri "$configuredUrl/api/tags" -TimeoutSec 2 | Out-Null
        return
    } catch { }
    $ollamaApp = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"
    if (-not (Test-Path -LiteralPath $ollamaApp)) { return }
    Write-Host "Starting Windows Ollama..."
    Start-Process -FilePath $ollamaApp -WindowStyle Hidden
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            Invoke-RestMethod -Uri "$configuredUrl/api/tags" -TimeoutSec 1 | Out-Null
            return
        } catch { }
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

$existingHealth = Get-AssistantHealth
Start-LocalOllamaIfNeeded
if ($existingHealth -and $existingHealth.api_version -eq 7) {
    Open-AssistantWindow
    exit 0
}

if ($existingHealth) {
    $existingProcess = Get-AssistantListenerProcess
    if ($existingProcess -and $existingProcess.ProcessName -eq "node") {
        Write-Host "Restarting the assistant to load the latest local features..."
        Stop-Process -Id $existingProcess.Id -Force
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 100
            if (-not (Get-AssistantHealth)) { break }
        }
    }
}

$serverProcess = Start-Process -FilePath "node.exe" -ArgumentList @($serverScript) -WorkingDirectory $projectDirectory -WindowStyle Hidden -PassThru

$health = $null
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    Start-Sleep -Milliseconds 250
    $health = Get-AssistantHealth
    if ($health) { break }
    if ($serverProcess.HasExited) { break }
}

if (-not $health) {
    throw "The local assistant server did not start."
}
Open-AssistantWindow
