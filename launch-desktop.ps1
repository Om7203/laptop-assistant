$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$electron = Join-Path $projectDirectory "node_modules\electron\dist\electron.exe"
$mainScript = Join-Path $projectDirectory "desktop\main.js"
$logDirectory = Join-Path $projectDirectory "logs"
$runId = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss-fff")
$outputLog = Join-Path $logDirectory "desktop-output-$runId.log"
$errorLog = Join-Path $logDirectory "desktop-error-$runId.log"

if (-not (Test-Path -LiteralPath $electron)) {
    throw "The desktop shell is not installed. Run setup-desktop.cmd first."
}

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$env:LOG_DESTINATION = Join-Path $logDirectory "assistant.log"

function Get-AssistantHealth {
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:3199/api/health" -TimeoutSec 1 }
    catch { return $null }
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

function Get-ListenerProcess {
    $listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 3199 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $ownerProcessId = if ($listener) { $listener.OwningProcess } else { $null }
    if (-not $ownerProcessId) {
        $match = netstat -ano | Select-String -Pattern '^\s*TCP\s+127\.0\.0\.1:3199\s+\S+\s+LISTENING\s+(\d+)\s*$' | Select-Object -First 1
        if ($match -and $match.Matches.Count -gt 0) { $ownerProcessId = [int]$match.Matches[0].Groups[1].Value }
    }
    if ($ownerProcessId) { return Get-Process -Id $ownerProcessId -ErrorAction SilentlyContinue }
    return $null
}

$existingHealth = Get-AssistantHealth
if ($existingHealth -and $existingHealth.api_version -ne 6) {
    $listenerProcess = Get-ListenerProcess
    if ($listenerProcess -and $listenerProcess.ProcessName -eq "node") {
        Write-Host "Stopping an older Laptop Assistant server..."
        Stop-Process -Id $listenerProcess.Id -Force
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 100
            if (-not (Get-AssistantHealth)) { break }
        }
    } elseif ($listenerProcess -and $listenerProcess.ProcessName -eq "electron") {
        Write-Host "Stopping the older Laptop Assistant desktop version..."
        Get-Process electron -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -eq $electron } |
            Stop-Process -Force
        for ($attempt = 0; $attempt -lt 50; $attempt++) {
            Start-Sleep -Milliseconds 100
            $projectElectron = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $electron }
            if (-not $projectElectron -and -not (Get-AssistantHealth)) { break }
        }
    }
}

Start-LocalOllamaIfNeeded

$desktopProcess = Start-Process `
    -FilePath $electron `
    -ArgumentList @($mainScript) `
    -WorkingDirectory $projectDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outputLog `
    -RedirectStandardError $errorLog `
    -PassThru

for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    $desktopProcess.Refresh()
    $currentHealth = Get-AssistantHealth
    if ($desktopProcess.HasExited -or ($currentHealth -and $currentHealth.api_version -eq 6)) { break }
}
$fatalOutput = if (Test-Path -LiteralPath $errorLog) { Get-Content -LiteralPath $errorLog -Raw } else { "" }
if ($desktopProcess.HasExited -or $fatalOutput -match 'FATAL:') {
    $detail = if (Test-Path -LiteralPath $errorLog) {
        (Get-Content -LiteralPath $errorLog -Tail 20) -join [Environment]::NewLine
    } else {
        "No diagnostic output was produced."
    }
    throw "The desktop process stopped during startup.`n$detail"
}

$health = Get-AssistantHealth
if (-not $health -or $health.api_version -ne 6) {
    throw "The desktop process started, but its local server did not become ready. See $errorLog"
}

Write-Host "Laptop Assistant is running. You can reopen it from the system tray." -ForegroundColor Green
