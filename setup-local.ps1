$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$environmentFile = Join-Path $projectDirectory ".env"

function Read-Settings {
    $settings = [ordered]@{}
    if (Test-Path -LiteralPath $environmentFile) {
        foreach ($line in [IO.File]::ReadAllLines($environmentFile)) {
            if ($line -match '^\s*([^#][^=]*)=(.*)$') {
                $settings[$matches[1].Trim()] = $matches[2].Trim()
            }
        }
    }
    return $settings
}

function Get-NormalizedUrl([string]$Value) {
    $uri = $null
    if (-not [Uri]::TryCreate($Value.Trim(), [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @("http", "https")) {
        throw "Enter a complete http or https address, for example http://192.168.1.50:11434"
    }
    return $uri.AbsoluteUri.TrimEnd('/')
}

$settings = Read-Settings
$defaultUrl = if ($settings.OLLAMA_BASE_URL) { $settings.OLLAMA_BASE_URL } else { "http://127.0.0.1:11434" }
$defaultModel = if ($settings.OLLAMA_MODEL) { $settings.OLLAMA_MODEL } else { "qwen3:4b-instruct-2507-q4_K_M" }

$form = New-Object Windows.Forms.Form
$form.Text = "Configure local AI"
$form.StartPosition = "CenterScreen"
$form.ClientSize = New-Object Drawing.Size(610, 265)
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false

$intro = New-Object Windows.Forms.Label
$intro.Text = "Connect Goffy to Ollama on this PC or your Linux machine. No paid API key is needed."
$intro.Location = New-Object Drawing.Point(22, 20)
$intro.Size = New-Object Drawing.Size(565, 42)
$form.Controls.Add($intro)

$urlLabel = New-Object Windows.Forms.Label
$urlLabel.Text = "Ollama address"
$urlLabel.Location = New-Object Drawing.Point(22, 72)
$urlLabel.AutoSize = $true
$form.Controls.Add($urlLabel)

$urlBox = New-Object Windows.Forms.TextBox
$urlBox.Text = $defaultUrl
$urlBox.Location = New-Object Drawing.Point(150, 68)
$urlBox.Size = New-Object Drawing.Size(430, 26)
$form.Controls.Add($urlBox)

$modelLabel = New-Object Windows.Forms.Label
$modelLabel.Text = "Model"
$modelLabel.Location = New-Object Drawing.Point(22, 112)
$modelLabel.AutoSize = $true
$form.Controls.Add($modelLabel)

$modelBox = New-Object Windows.Forms.TextBox
$modelBox.Text = $defaultModel
$modelBox.Location = New-Object Drawing.Point(150, 108)
$modelBox.Size = New-Object Drawing.Size(430, 26)
$form.Controls.Add($modelBox)

$hint = New-Object Windows.Forms.Label
$hint.Text = "Recommended fast model: qwen3:4b-instruct-2507-q4_K_M"
$hint.Location = New-Object Drawing.Point(150, 140)
$hint.Size = New-Object Drawing.Size(430, 30)
$form.Controls.Add($hint)

$testButton = New-Object Windows.Forms.Button
$testButton.Text = "Test connection"
$testButton.Location = New-Object Drawing.Point(224, 195)
$testButton.Size = New-Object Drawing.Size(118, 36)
$form.Controls.Add($testButton)

$saveButton = New-Object Windows.Forms.Button
$saveButton.Text = "Save"
$saveButton.Location = New-Object Drawing.Point(352, 195)
$saveButton.Size = New-Object Drawing.Size(108, 36)
$form.Controls.Add($saveButton)

$cancelButton = New-Object Windows.Forms.Button
$cancelButton.Text = "Cancel"
$cancelButton.Location = New-Object Drawing.Point(470, 195)
$cancelButton.Size = New-Object Drawing.Size(108, 36)
$cancelButton.DialogResult = [Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancelButton)
$form.CancelButton = $cancelButton

$testButton.Add_Click({
    try {
        $baseUrl = Get-NormalizedUrl $urlBox.Text
        $result = Invoke-RestMethod -Uri "$baseUrl/api/tags" -TimeoutSec 6
        $models = @($result.models | ForEach-Object { if ($_.name) { $_.name } else { $_.model } })
        $wanted = $modelBox.Text.Trim()
        if ($models -contains $wanted -or $models -contains "$wanted`:latest") {
            [Windows.Forms.MessageBox]::Show("Connected. $wanted is installed.", "Local AI", "OK", "Information") | Out-Null
        }
        else {
            [Windows.Forms.MessageBox]::Show("Connected, but $wanted is not installed. Run 'ollama pull $wanted' on the Ollama machine.", "Local AI", "OK", "Warning") | Out-Null
        }
    }
    catch {
        [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Could not connect", "OK", "Error") | Out-Null
    }
})

$saveButton.Add_Click({
    try {
        $baseUrl = Get-NormalizedUrl $urlBox.Text
        $model = $modelBox.Text.Trim()
        if ([string]::IsNullOrWhiteSpace($model) -or $model.Length -gt 100) { throw "Enter an Ollama model name." }

        $settings["PORT"] = if ($settings.PORT) { $settings.PORT } else { "3199" }
        $settings["ASSISTANT_BACKEND"] = "ollama"
        $settings["OLLAMA_BASE_URL"] = $baseUrl
        $settings["OLLAMA_MODEL"] = $model
        $settings["ENABLE_OPENAI_REALTIME"] = "false"
        $settings["ASSISTANT_ALLOWED_ROOTS"] = if ($settings.ASSISTANT_ALLOWED_ROOTS) { $settings.ASSISTANT_ALLOWED_ROOTS } else { "" }

        $lines = $settings.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }
        [IO.File]::WriteAllLines($environmentFile, $lines, [Text.UTF8Encoding]::new($false))
        [Windows.Forms.MessageBox]::Show("Saved. Close and restart Goffy.", "Local AI", "OK", "Information") | Out-Null
        $form.DialogResult = [Windows.Forms.DialogResult]::OK
        $form.Close()
    }
    catch {
        [Windows.Forms.MessageBox]::Show($_.Exception.Message, "Invalid settings", "OK", "Error") | Out-Null
    }
})

[void]$form.ShowDialog()
