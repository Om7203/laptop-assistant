$ErrorActionPreference = "Stop"

function Read-ApiKeyFromDialog {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "Laptop Assistant setup"
    $form.StartPosition = "CenterScreen"
    $form.ClientSize = New-Object System.Drawing.Size(520, 170)
    $form.FormBorderStyle = "FixedDialog"
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.TopMost = $true

    $label = New-Object System.Windows.Forms.Label
    $label.Text = "Paste your OpenAI API key below. It will be encrypted for this Windows account."
    $label.AutoSize = $true
    $label.Location = New-Object System.Drawing.Point(22, 22)
    $form.Controls.Add($label)

    $textBox = New-Object System.Windows.Forms.TextBox
    $textBox.Location = New-Object System.Drawing.Point(25, 58)
    $textBox.Size = New-Object System.Drawing.Size(470, 28)
    $textBox.UseSystemPasswordChar = $true
    $textBox.ShortcutsEnabled = $true
    $form.Controls.Add($textBox)

    $saveButton = New-Object System.Windows.Forms.Button
    $saveButton.Text = "Save securely"
    $saveButton.Location = New-Object System.Drawing.Point(286, 108)
    $saveButton.Size = New-Object System.Drawing.Size(112, 34)
    $saveButton.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Controls.Add($saveButton)

    $cancelButton = New-Object System.Windows.Forms.Button
    $cancelButton.Text = "Cancel"
    $cancelButton.Location = New-Object System.Drawing.Point(408, 108)
    $cancelButton.Size = New-Object System.Drawing.Size(86, 34)
    $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.Controls.Add($cancelButton)

    $form.AcceptButton = $saveButton
    $form.CancelButton = $cancelButton
    $form.Add_Shown({ $textBox.Focus() })

    $result = $form.ShowDialog()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
        throw "Setup was cancelled. Nothing was saved."
    }

    return $textBox.Text.Trim()
}

function Test-OpenAiApiKey {
    param([Parameter(Mandatory = $true)][string]$ApiKey)

    Write-Host "Checking the key with OpenAI..."
    try {
        $headers = @{ Authorization = "Bearer $ApiKey" }
        Invoke-RestMethod -Method Get -Uri "https://api.openai.com/v1/models" -Headers $headers -TimeoutSec 20 | Out-Null
    }
    catch {
        $statusCode = $null
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        if ($statusCode -eq 401) {
            throw "OpenAI rejected this key. Create a standard key in the selected API project, copy the complete secret when it is first shown, and try again."
        }
        if ($statusCode -eq 403) {
            throw "The key exists but does not have permission to use the API. Review its project and permissions, then try again."
        }
        throw "The key could not be checked. Confirm that this laptop is online and try again."
    }
}

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

$apiKeyText = Read-ApiKeyFromDialog
if ([string]::IsNullOrWhiteSpace($apiKeyText) -or $apiKeyText.Length -lt 20) {
    throw "No complete API key was entered. Nothing was saved."
}

Test-OpenAiApiKey -ApiKey $apiKeyText
$apiKey = ConvertTo-SecureString -String $apiKeyText -AsPlainText -Force
$apiKeyText = $null
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
