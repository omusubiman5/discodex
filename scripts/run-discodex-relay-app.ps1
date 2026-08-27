[CmdletBinding()]
param(
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $repoRoot 'scripts\start-discord-production-control-current.ps1'
$stopScript = Join-Path $repoRoot 'scripts\stop-discord-production-control-current.ps1'
$statusScript = Join-Path $repoRoot 'scripts\get-discodex-relay-status.ps1'
$gainScript = Join-Path $repoRoot 'scripts\manage-discord-output-gain.mjs'
$screenShareScript = Join-Path $repoRoot 'scripts\manage-discord-screen-share.mjs'
$prepareCodexScript = Join-Path $repoRoot 'scripts\prepare-codex-desktop-for-discodex.ps1'
$taskFile = Join-Path $repoRoot 'runtime\discodex-relay.thread-id'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

foreach ($required in @($startScript, $stopScript, $statusScript, $gainScript, $screenShareScript, $prepareCodexScript, $windowsPowerShell)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "A fixed Discodex Relay prerequisite is missing." }
}

if ($Probe) {
  $configured = Test-Path -LiteralPath $taskFile -PathType Leaf
  [pscustomobject]@{ ready = $configured; configurationRequired = -not $configured; mutation = $false; secretOutput = $false; identifierOutput = $false } | ConvertTo-Json -Compress
  return
}

if (-not (Test-Path -LiteralPath $taskFile -PathType Leaf)) { throw 'The fixed Codex task configuration is missing.' }
$threadId = (Get-Content -Raw -LiteralPath $taskFile).Trim()
if ($threadId -notmatch '^[0-9a-f-]{20,}$') { throw 'The fixed Codex task configuration is invalid.' }

$createdNew = $false
$mutex = [Threading.Mutex]::new($true, 'Local\DiscodexRelayApplication', [ref]$createdNew)
if (-not $createdNew) {
  $mutex.Dispose()
  throw 'Discodex Relay is already running.'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$outputDirectory = Join-Path $repoRoot 'outputs'
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$auditPath = Join-Path $outputDirectory ('discodex-relay-' + (Get-Date -Format 'yyyyMMddTHHmmssfff') + '.jsonl')

function Write-RelayAudit {
  param([string]$State, [string]$Message)
  $entry = [ordered]@{ state = $State }
  if ($Message) { $entry.message = $Message }
  $entry.secretOutput = $false
  $entry.identifierOutput = $false
  Add-Content -LiteralPath $auditPath -Value ($entry | ConvertTo-Json -Compress) -Encoding UTF8
}

function Quote-RelayArgument {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Start-RelayChild {
  param(
    [string]$FileName,
    [string]$Arguments,
    [int]$TimeoutMilliseconds,
    [bool]$CaptureOutput
  )
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FileName
  $startInfo.Arguments = $Arguments
  $startInfo.WorkingDirectory = $repoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.RedirectStandardOutput = $CaptureOutput
  $startInfo.RedirectStandardError = $CaptureOutput
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'The fixed Relay child process could not start.' }
  $stdoutTask = if ($CaptureOutput) { $process.StandardOutput.ReadToEndAsync() } else { $null }
  $stderrTask = if ($CaptureOutput) { $process.StandardError.ReadToEndAsync() } else { $null }
  return [pscustomobject]@{
    Process = $process
    StdoutTask = $stdoutTask
    StderrTask = $stderrTask
    CaptureOutput = $CaptureOutput
    Deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  }
}

function Complete-RelayChild {
  param([pscustomobject]$Operation, [bool]$TimedOut)
  $process = $Operation.Process
  if ($TimedOut -and -not $process.HasExited) { try { $process.Kill() } catch {} }
  if (-not $process.HasExited) { return $null }
  $exitCode = $process.ExitCode
  $stdout = ''
  $stderr = ''
  if ($Operation.CaptureOutput) {
    [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($Operation.StdoutTask, $Operation.StderrTask), 1000) | Out-Null
    if ($Operation.StdoutTask.IsCompleted) { $stdout = $Operation.StdoutTask.Result }
    if ($Operation.StderrTask.IsCompleted) { $stderr = $Operation.StderrTask.Result }
  }
  $process.Dispose()
  return [pscustomobject]@{ ExitCode = $exitCode; TimedOut = $TimedOut; StandardOutput = $stdout; StandardError = $stderr }
}

function Invoke-RelayChild {
  param([string]$FileName, [string]$Arguments, [int]$TimeoutMilliseconds)
  $operation = Start-RelayChild $FileName $Arguments $TimeoutMilliseconds $true
  if (-not $operation.Process.WaitForExit($TimeoutMilliseconds)) {
    return Complete-RelayChild $operation $true
  }
  return Complete-RelayChild $operation $false
}

function Get-RelaySnapshot {
  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-RelayArgument $statusScript)
  $result = Invoke-RelayChild $windowsPowerShell $arguments 7000
  if ($result.TimedOut -or $result.ExitCode -ne 0) { throw 'Relay ownership readback failed.' }
  return $result.StandardOutput.Trim() | ConvertFrom-Json
}

function Get-RelayGain {
  $result = Invoke-RelayChild 'node.exe' ((Quote-RelayArgument $gainScript) + ' get') 7000
  if ($result.TimedOut -or $result.ExitCode -ne 0) { throw 'GPT Live output gain readback failed.' }
  return $result.StandardOutput.Trim() | ConvertFrom-Json
}

function Set-RelayGain {
  param([int]$Percent)
  if ($Percent -lt 25 -or $Percent -gt 100) { throw 'Output gain is outside the approved range.' }
  $linear = ($Percent / 100.0).ToString('0.00', [Globalization.CultureInfo]::InvariantCulture)
  $result = Invoke-RelayChild 'node.exe' ((Quote-RelayArgument $gainScript) + ' set ' + $linear) 7000
  if ($result.TimedOut -or $result.ExitCode -ne 0) { throw 'GPT Live output gain save failed.' }
  Write-RelayAudit 'gpt-live-output-gain-updated' ('percent=' + $Percent)
}

function New-RelayFont {
  param([single]$Size, [Drawing.FontStyle]$Style = [Drawing.FontStyle]::Regular)
  return [Drawing.Font]::new('Meiryo', $Size, $Style, [Drawing.GraphicsUnit]::Point)
}

$ghibliBrown = [Drawing.Color]::FromArgb(0x22, 0x18, 0x15)
$ghibliBlue = [Drawing.Color]::FromArgb(0x10, 0x9c, 0xeb)
$buttonBorderBlue = [Drawing.Color]::FromArgb(0x00, 0x8c, 0xc1)
$orangeAccent = [Drawing.Color]::FromArgb(0xf7, 0x9b, 0x30)
$textPrimary = [Drawing.Color]::FromArgb(0x37, 0x3a, 0x3c)
$textLight = [Drawing.Color]::FromArgb(0xfa, 0xfa, 0xfa)
$textMuted = [Drawing.Color]::FromArgb(0x88, 0x88, 0x88)
$labelGray = [Drawing.Color]::FromArgb(0x77, 0x77, 0x77)
$borderColor = [Drawing.Color]::FromArgb(0xcc, 0xcc, 0xcc)
$footerBackground = [Drawing.Color]::FromArgb(0xf4, 0xf4, 0xf4)

function Set-RoundedRegion {
  param([Windows.Forms.Control]$Control, [int]$Radius)
  if ($Control.Width -le 0 -or $Control.Height -le 0) { return }
  $diameter = $Radius * 2
  $path = [Drawing.Drawing2D.GraphicsPath]::new()
  try {
    $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
    $path.AddArc($Control.Width - $diameter - 1, 0, $diameter, $diameter, 270, 90)
    $path.AddArc($Control.Width - $diameter - 1, $Control.Height - $diameter - 1, $diameter, $diameter, 0, 90)
    $path.AddArc(0, $Control.Height - $diameter - 1, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    $previous = $Control.Region
    $Control.Region = [Drawing.Region]::new($path)
    if ($null -ne $previous) { $previous.Dispose() }
  }
  finally { $path.Dispose() }
}

function Set-PrimaryButtonStyle {
  param([Windows.Forms.Button]$Button)
  $Button.BackColor = $ghibliBrown
  $Button.ForeColor = $textLight
  $Button.FlatStyle = [Windows.Forms.FlatStyle]::Flat
  $Button.FlatAppearance.BorderColor = $buttonBorderBlue
  $Button.FlatAppearance.BorderSize = 1
  $Button.Font = New-RelayFont 10.5
  $Button.UseVisualStyleBackColor = $false
  Set-RoundedRegion $Button 7
}

function Set-SecondaryButtonStyle {
  param([Windows.Forms.Button]$Button)
  $Button.BackColor = [Drawing.Color]::White
  $Button.ForeColor = [Drawing.Color]::FromArgb(0x33, 0x33, 0x33)
  $Button.FlatStyle = [Windows.Forms.FlatStyle]::Flat
  $Button.FlatAppearance.BorderColor = $borderColor
  $Button.FlatAppearance.BorderSize = 1
  $Button.Font = New-RelayFont 10.5
  $Button.UseVisualStyleBackColor = $false
  Set-RoundedRegion $Button 4
}

function New-RelayLabel {
  param([int]$Left, [int]$Top, [int]$Width, [int]$Height, [string]$Text)
  $label = [Windows.Forms.Label]::new()
  $label.SetBounds($Left, $Top, $Width, $Height)
  $label.Text = $Text
  return $label
}

$form = [Windows.Forms.Form]::new()
$form.Text = 'Discodex Relay'
$form.ClientSize = [Drawing.Size]::new(720, 708)
$form.FormBorderStyle = [Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
$form.BackColor = [Drawing.Color]::White
$form.ForeColor = $textPrimary
$form.Font = New-RelayFont 10.5
$form.AutoScaleMode = [Windows.Forms.AutoScaleMode]::Dpi

$header = [Windows.Forms.Panel]::new(); $header.SetBounds(0, 0, 720, 105); $header.BackColor = $ghibliBrown
$title = New-RelayLabel 24 12 650 45 'Discodex Voice Bridge'; $title.ForeColor = $textLight; $title.BackColor = $ghibliBrown; $title.Font = New-RelayFont 27
$subtitle = New-RelayLabel 27 64 620 24 'GPT Live and Discord voice relay'; $subtitle.ForeColor = $textLight; $subtitle.BackColor = $ghibliBrown; $subtitle.Font = New-RelayFont 10.5
$header.Controls.AddRange(@($title, $subtitle))
$blueAccent = [Windows.Forms.Panel]::new(); $blueAccent.SetBounds(0, 105, 720, 6); $blueAccent.BackColor = $ghibliBlue

$statusPanel = [Windows.Forms.Panel]::new(); $statusPanel.SetBounds(24, 132, 672, 160); $statusPanel.BackColor = [Drawing.Color]::White; $statusPanel.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
$statusHeading = New-RelayLabel 20 16 260 32 'Bridge status'; $statusHeading.Font = New-RelayFont 18
$statusLabel = New-RelayLabel 360 20 285 24 'Checking current ownership…'; $statusLabel.TextAlign = [Drawing.ContentAlignment]::MiddleRight; $statusLabel.ForeColor = $textMuted; $statusLabel.Font = New-RelayFont 9
$relayBadge = New-RelayLabel 20 55 180 30 'RELAY CHECKING'; $relayBadge.TextAlign = [Drawing.ContentAlignment]::MiddleCenter; $relayBadge.ForeColor = [Drawing.Color]::White; $relayBadge.BackColor = $labelGray; $relayBadge.Font = New-RelayFont 9
$routeBadge = New-RelayLabel 210 55 220 30 'CODEX ROUTE CHECKING'; $routeBadge.TextAlign = [Drawing.ContentAlignment]::MiddleCenter; $routeBadge.ForeColor = [Drawing.Color]::White; $routeBadge.BackColor = $labelGray; $routeBadge.Font = New-RelayFont 9
$voiceBadge = New-RelayLabel 440 55 200 30 'VOICE CHECKING'; $voiceBadge.TextAlign = [Drawing.ContentAlignment]::MiddleCenter; $voiceBadge.ForeColor = [Drawing.Color]::White; $voiceBadge.BackColor = $labelGray; $voiceBadge.Font = New-RelayFont 9
$startButton = [Windows.Forms.Button]::new(); $startButton.SetBounds(20, 108, 150, 38); $startButton.Text = 'Start Relay'; Set-PrimaryButtonStyle $startButton
$stopButton = [Windows.Forms.Button]::new(); $stopButton.SetBounds(182, 108, 150, 38); $stopButton.Text = 'Stop Relay'; Set-SecondaryButtonStyle $stopButton
$refreshButton = [Windows.Forms.Button]::new(); $refreshButton.SetBounds(344, 108, 125, 38); $refreshButton.Text = 'Refresh'; Set-SecondaryButtonStyle $refreshButton
$statusPanel.Controls.AddRange(@($statusHeading, $statusLabel, $relayBadge, $routeBadge, $voiceBadge, $startButton, $stopButton, $refreshButton))

$sharePanel = [Windows.Forms.Panel]::new(); $sharePanel.SetBounds(24, 312, 672, 128); $sharePanel.BackColor = [Drawing.Color]::White; $sharePanel.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
$shareHeading = New-RelayLabel 20 14 570 32 'Discord 画面共有'; $shareHeading.Font = New-RelayFont 18
$shareHelp = New-RelayLabel 20 48 625 24 '公式Discord UIでCodex作業画面を共有します。音声接続は維持されます。'; $shareHelp.ForeColor = $textMuted; $shareHelp.Font = New-RelayFont 9
$shareStartButton = [Windows.Forms.Button]::new(); $shareStartButton.SetBounds(20, 78, 180, 38); $shareStartButton.Text = '画面共有を開始'; Set-PrimaryButtonStyle $shareStartButton
$shareStopButton = [Windows.Forms.Button]::new(); $shareStopButton.SetBounds(212, 78, 180, 38); $shareStopButton.Text = '画面共有を停止'; Set-SecondaryButtonStyle $shareStopButton
$sharePanel.Controls.AddRange(@($shareHeading, $shareHelp, $shareStartButton, $shareStopButton))

$gainPanel = [Windows.Forms.Panel]::new(); $gainPanel.SetBounds(24, 460, 672, 188); $gainPanel.BackColor = [Drawing.Color]::White; $gainPanel.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
$gainHeading = New-RelayLabel 20 16 570 32 'GPT Live → Discord output volume'; $gainHeading.Font = New-RelayFont 18
$gainLabel = New-RelayLabel 20 55 470 24 'GPT Live → Discord output volume: 50%'
$gainSlider = [Windows.Forms.TrackBar]::new(); $gainSlider.SetBounds(20, 82, 480, 50); $gainSlider.Minimum = 25; $gainSlider.Maximum = 100; $gainSlider.TickFrequency = 5; $gainSlider.Value = 50; $gainSlider.BackColor = [Drawing.Color]::White
$applyButton = [Windows.Forms.Button]::new(); $applyButton.SetBounds(525, 85, 120, 38); $applyButton.Text = 'Apply'; Set-PrimaryButtonStyle $applyButton
$limiterLabel = New-RelayLabel 20 142 625 28 'Safe range: 25–100%  ·  Default: 50%  ·  True-peak limiter: −1 dBTP'; $limiterLabel.ForeColor = $textMuted; $limiterLabel.Font = New-RelayFont 9
$gainPanel.Controls.AddRange(@($gainHeading, $gainLabel, $gainSlider, $applyButton, $limiterLabel))

$footer = [Windows.Forms.Panel]::new(); $footer.SetBounds(0, 668, 720, 40); $footer.BackColor = $footerBackground
$footerText = New-RelayLabel 24 10 650 20 'Single control · Single runner · Global audio defaults unchanged'; $footerText.ForeColor = $textMuted; $footerText.BackColor = $footerBackground; $footerText.Font = New-RelayFont 9
$footer.Controls.Add($footerText)
$form.Controls.AddRange(@($header, $blueAccent, $statusPanel, $sharePanel, $gainPanel, $footer))

$script:lastSnapshot = $null
$script:busy = $false
$script:ownsControl = $false
$script:activeOperation = $null
$script:controlRecoveryUsed = $false
$script:controlHealthySince = [DateTime]::MinValue

function Set-RelayButtonState {
  $refreshButton.Enabled = -not $script:busy
  $applyButton.Enabled = -not $script:busy
  $shareStopButton.Enabled = -not $script:busy
  if ($script:busy -or $null -eq $script:lastSnapshot) {
    $startButton.Enabled = $false
    $stopButton.Enabled = $false
    $shareStartButton.Enabled = $false
    $shareStopButton.Enabled = $false
    return
  }
  $startButton.Text = if ($script:lastSnapshot.routePrepared) { 'Start Relay' } else { 'Prepare Codex' }
  $startButton.Enabled = $script:lastSnapshot.controlCount -le 1 -and $script:lastSnapshot.runnerCount -eq 0 -and -not $script:lastSnapshot.lockPresent -and ((-not $script:lastSnapshot.routePrepared) -or $script:lastSnapshot.controlCount -eq 0)
  $stopButton.Enabled = $script:lastSnapshot.controlCount -eq 1 -and $script:lastSnapshot.runnerCount -eq 0 -and -not $script:lastSnapshot.lockPresent
  $shareStartButton.Enabled = $script:lastSnapshot.runnerCount -eq 1 -and $script:lastSnapshot.lockPresent
}

function Set-RelayBusy {
  param([bool]$Value)
  $script:busy = $Value
  $form.UseWaitCursor = $Value
  Set-RelayButtonState
}

function Update-RelayStatus {
  $snapshot = Get-RelaySnapshot
  $script:lastSnapshot = $snapshot
  $relay = if ($snapshot.controlCount -eq 1) { 'ready' } elseif ($snapshot.controlCount -eq 0) { 'stopped' } else { 'invalid' }
  $voice = if ($snapshot.runnerCount -eq 1 -and $snapshot.lockPresent) { 'connected' } elseif ($snapshot.runnerCount -eq 0 -and -not $snapshot.lockPresent) { 'disconnected' } else { 'degraded' }
  $statusLabel.Text = $relay.ToUpperInvariant() + '  /  ' + $voice.ToUpperInvariant()
  $relayBadge.Text = 'RELAY ' + $relay.ToUpperInvariant()
  $relayBadge.BackColor = if ($relay -eq 'ready') { $ghibliBlue } elseif ($relay -eq 'stopped') { $labelGray } else { $orangeAccent }
  $voiceBadge.Text = 'VOICE ' + $voice.ToUpperInvariant()
  $voiceBadge.BackColor = if ($voice -eq 'connected') { $ghibliBlue } elseif ($voice -eq 'disconnected') { $labelGray } else { $orangeAccent }
  $routeBadge.Text = if ($snapshot.routePrepared) { 'CODEX ROUTE READY' } else { 'CODEX ROUTE SETUP NEEDED' }
  $routeBadge.BackColor = if ($snapshot.routePrepared) { $ghibliBlue } else { $orangeAccent }
  Set-RelayButtonState
}

function Show-RelayError {
  param([string]$Message)
  [Windows.Forms.MessageBox]::Show($Message, 'Discodex Relay', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error) | Out-Null
}

function Start-RelayControlOperation {
  if ($null -ne $script:activeOperation) { return }
  Set-RelayBusy $true
  try {
    $snapshot = Get-RelaySnapshot
    if (-not $snapshot.routePrepared) {
      $codexRunning = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -match 'OpenAI\.Codex_' -and $_.CommandLine -notmatch '--type=' }).Count -eq 1
      if ($codexRunning) {
        $choice = [Windows.Forms.MessageBox]::Show(
          'Codex Desktop needs one Relay-managed restart to enable its local audio route. This closes any active Codex voice call. Continue?',
          'Discodex Relay',
          [Windows.Forms.MessageBoxButtons]::YesNo,
          [Windows.Forms.MessageBoxIcon]::Warning
        )
        if ($choice -ne [Windows.Forms.DialogResult]::Yes) { Set-RelayBusy $false; return }
      }
      $statusLabel.Text = 'PREPARING CODEX  /  DISCONNECTED'
      $routeBadge.Text = 'CODEX ROUTE PREPARING'
      $routeBadge.BackColor = $orangeAccent
      Write-RelayAudit 'codex-route-preparing' ''
      $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-RelayArgument $prepareCodexScript) + ' -ThreadId ' + (Quote-RelayArgument $threadId)
      if ($codexRunning) { $arguments += ' -RestartExisting' }
      $script:activeOperation = Start-RelayChild $windowsPowerShell $arguments 60000 $false
      $script:activeOperation | Add-Member -NotePropertyName Kind -NotePropertyValue 'Prepare Codex'
      return
    }
    $statusLabel.Text = 'STARTING  /  DISCONNECTED'
    $relayBadge.Text = 'RELAY STARTING'
    $relayBadge.BackColor = $orangeAccent
    Write-RelayAudit 'relay-control-starting' ''
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-RelayArgument $startScript) + ' -ThreadId ' + (Quote-RelayArgument $threadId)
    $script:activeOperation = Start-RelayChild $windowsPowerShell $arguments 30000 $false
    $script:activeOperation | Add-Member -NotePropertyName Kind -NotePropertyValue 'Start Relay'
  }
  catch {
    Set-RelayBusy $false
    Show-RelayError $_.Exception.Message
  }
}

function Start-ScreenShareOperation {
  param([ValidateSet('start', 'stop')][string]$Action)
  if ($null -ne $script:activeOperation) { return }
  Set-RelayBusy $true
  try {
    $snapshot = Get-RelaySnapshot
    if ($Action -eq 'start' -and ($snapshot.runnerCount -ne 1 -or -not $snapshot.lockPresent)) {
      throw 'Connect Discodex voice before starting screen share.'
    }
    $shareHelp.Text = if ($Action -eq 'start') { '公式Discord UIで画面共有を開始しています…' } else { '公式Discord UIで画面共有を停止しています…' }
    Write-RelayAudit ('discord-screen-share-' + $Action + '-requested') ''
    $script:activeOperation = Start-RelayChild 'node.exe' ((Quote-RelayArgument $screenShareScript) + ' ' + $Action) 100000 $true
    $kind = if ($Action -eq 'start') { 'Screen Share Start' } else { 'Screen Share Stop' }
    $script:activeOperation | Add-Member -NotePropertyName Kind -NotePropertyValue $kind
  }
  catch {
    Set-RelayBusy $false
    Show-RelayError $_.Exception.Message
  }
}

$operationTimer = [Windows.Forms.Timer]::new()
$operationTimer.Interval = 200
$operationTimer.Add_Tick({
  if ($null -eq $script:activeOperation) { return }
  $timedOut = [DateTime]::UtcNow -gt $script:activeOperation.Deadline
  if (-not $timedOut -and -not $script:activeOperation.Process.HasExited) { return }
  $operation = $script:activeOperation
  $script:activeOperation = $null
  $result = Complete-RelayChild $operation $timedOut
  try {
    if ($result.TimedOut -or $result.ExitCode -ne 0) { throw ($operation.Kind + ' exceeded its bounded readiness boundary.') }
    Update-RelayStatus
    if ($operation.Kind -eq 'Start Relay') {
      if ($script:lastSnapshot.controlCount -ne 1 -or $script:lastSnapshot.runnerCount -ne 0 -or $script:lastSnapshot.lockPresent) { throw 'Relay control did not reach a safe Ready state.' }
      $script:ownsControl = $true
      Write-RelayAudit 'relay-control-ready' ''
    }
    elseif ($operation.Kind -eq 'Prepare Codex') {
      if (-not $script:lastSnapshot.routePrepared -or $script:lastSnapshot.controlCount -ne 1 -or $script:lastSnapshot.runnerCount -ne 0 -or $script:lastSnapshot.lockPresent) { throw 'Codex audio route preparation did not reach a safe Ready state.' }
      $script:ownsControl = $true
      Write-RelayAudit 'codex-route-ready' ''
    }
    elseif ($operation.Kind -eq 'Screen Share Start' -or $operation.Kind -eq 'Screen Share Stop') {
      $screenResult = $result.StandardOutput.Trim() | ConvertFrom-Json
      if (-not $screenResult.ok -or $screenResult.status -ne 'confirmed') { throw 'Discord screen-share state was not confirmed.' }
      $action = if ($operation.Kind -eq 'Screen Share Start') { 'started' } else { 'stopped' }
      $shareHelp.Text = 'Discord画面共有を' + $(if ($action -eq 'started') { '開始しました。' } else { '停止しました。音声接続は維持しています。' })
      Write-RelayAudit ('discord-screen-share-' + $action) ''
    }
    else {
      if ($script:lastSnapshot.controlCount -ne 0) { throw 'Relay control did not stop cleanly.' }
      $script:ownsControl = $false
      Write-RelayAudit 'relay-control-stopped' ''
    }
  }
  catch { Show-RelayError $_.Exception.Message }
  finally { Set-RelayBusy $false }
})
$operationTimer.Start()

# The Relay window is the lightweight supervisor. It never retries the voice
# runner. It may recover its single command-control child once after an
# unexpected exit, then stays visibly stopped instead of entering a loop.
$healthTimer = [Windows.Forms.Timer]::new()
$healthTimer.Interval = 2000
$healthTimer.Add_Tick({
  if ($script:busy -or $null -ne $script:activeOperation) { return }
  try {
    Update-RelayStatus
    if ($script:lastSnapshot.controlCount -eq 1) {
      if ($script:controlHealthySince -eq [DateTime]::MinValue) { $script:controlHealthySince = [DateTime]::UtcNow }
      if (([DateTime]::UtcNow - $script:controlHealthySince).TotalSeconds -ge 60) { $script:controlRecoveryUsed = $false }
      return
    }
    $script:controlHealthySince = [DateTime]::MinValue
    if ($script:ownsControl -and -not $script:controlRecoveryUsed -and
        $script:lastSnapshot.controlCount -eq 0 -and $script:lastSnapshot.runnerCount -eq 0 -and -not $script:lastSnapshot.lockPresent) {
      $script:controlRecoveryUsed = $true
      Write-RelayAudit 'relay-control-unexpected-exit' 'single-recovery'
      Start-RelayControlOperation
    }
  }
  catch {
    $statusLabel.Text = 'CONTROL ERROR  /  DISCONNECTED'
    Write-RelayAudit 'relay-control-health-failed' ''
  }
})
$healthTimer.Start()

$gainSlider.Add_Scroll({ $gainLabel.Text = 'GPT Live → Discord output volume: ' + $gainSlider.Value + '%' })
$refreshButton.Add_Click({
  Set-RelayBusy $true
  try { Update-RelayStatus } catch { Show-RelayError $_.Exception.Message } finally { Set-RelayBusy $false }
})
$applyButton.Add_Click({
  Set-RelayBusy $true
  try {
    Set-RelayGain $gainSlider.Value
    $gainLabel.Text = 'GPT Live → Discord output volume: ' + $gainSlider.Value + '% (saved)'
  }
  catch { Show-RelayError $_.Exception.Message }
  finally { Set-RelayBusy $false }
})
$shareStartButton.Add_Click({ Start-ScreenShareOperation 'start' })
$shareStopButton.Add_Click({ Start-ScreenShareOperation 'stop' })
$startButton.Add_Click({
  Start-RelayControlOperation
})
$stopButton.Add_Click({
  Set-RelayBusy $true
  try {
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-RelayArgument $stopScript)
    $script:activeOperation = Start-RelayChild $windowsPowerShell $arguments 15000 $false
    $script:activeOperation | Add-Member -NotePropertyName Kind -NotePropertyValue 'Stop Relay'
  }
  catch { Set-RelayBusy $false; Show-RelayError $_.Exception.Message }
})
$form.Add_Shown({
  $autoStart = $false
  Set-RelayBusy $true
  try {
    $gain = Get-RelayGain
    $gainSlider.Value = [Math]::Max($gainSlider.Minimum, [Math]::Min($gainSlider.Maximum, [int]$gain.gainPercent))
    $gainLabel.Text = 'GPT Live → Discord output volume: ' + $gainSlider.Value + '%'
    Update-RelayStatus
    if ($script:lastSnapshot.controlCount -eq 1 -and $script:lastSnapshot.runnerCount -eq 0 -and -not $script:lastSnapshot.lockPresent) {
      $script:ownsControl = $true
      $script:controlHealthySince = [DateTime]::UtcNow
    }
    $autoStart = $script:lastSnapshot.controlCount -eq 0 -and $script:lastSnapshot.runnerCount -eq 0 -and -not $script:lastSnapshot.lockPresent
  }
  catch { Show-RelayError $_.Exception.Message }
  finally { Set-RelayBusy $false }
  if ($autoStart) { Start-RelayControlOperation }
})
$form.Add_FormClosing({
  param($sender, $eventArgs)
  if ($null -ne $script:activeOperation) { $eventArgs.Cancel = $true; Show-RelayError 'Wait for the bounded Relay operation to finish.'; return }
  if (-not $script:ownsControl) { return }
  try {
    $snapshot = Get-RelaySnapshot
    if ($snapshot.runnerCount -ne 0 -or $snapshot.lockPresent) { $eventArgs.Cancel = $true; Show-RelayError 'Use /disconnect in Discord before closing Discodex Relay.'; return }
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + (Quote-RelayArgument $stopScript)
    $result = Invoke-RelayChild $windowsPowerShell $arguments 15000
    if ($result.TimedOut -or $result.ExitCode -ne 0) { throw 'Relay control did not stop cleanly.' }
  }
  catch { $eventArgs.Cancel = $true; Show-RelayError $_.Exception.Message }
})

try {
  [Windows.Forms.Application]::EnableVisualStyles()
  [Windows.Forms.Application]::Run($form)
}
finally {
  $operationTimer.Stop()
  $operationTimer.Dispose()
  $healthTimer.Stop()
  $healthTimer.Dispose()
  $form.Dispose()
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
