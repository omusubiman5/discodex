[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ThreadId
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputDir = Join-Path $repoRoot 'outputs'
$lockPath = Join-Path $repoRoot 'runtime\live-call.lock'

$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
$controls = @($nodes | Where-Object { $_.CommandLine -match 'run-discord-production-control\.mjs' })
$runners = @($nodes | Where-Object { $_.CommandLine -match 'run-meetron-windows-live' })
if ($controls.Count -ne 0) { throw 'Fail-closed: production control is already running.' }
if ($runners.Count -ne 0 -or (Test-Path -LiteralPath $lockPath)) { throw 'Fail-closed: a runner or live-call lock already exists.' }
if ($ThreadId -notmatch '^[0-9a-f-]{20,}$') { throw 'Fail-closed: the exact Codex task identity is invalid.' }

$codexRoots = @(
  Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -match 'OpenAI\.Codex_' -and $_.CommandLine -notmatch '--type=' }
)
$debuggerEndpoint = $null
$codexDesktopPid = $null
if ($codexRoots.Count -eq 1) {
  $debugPortMatch = [regex]::Match([string]$codexRoots[0].CommandLine, '--remote-debugging-port=(\d+)')
  if ($debugPortMatch.Success) {
    $candidateEndpoint = "http://127.0.0.1:$($debugPortMatch.Groups[1].Value)"
    try {
      $targets = Invoke-RestMethod -Uri "$candidateEndpoint/json/list" -TimeoutSec 3
      if (@($targets | Where-Object { $_.type -eq 'page' -and $_.url -eq 'app://-/index.html' }).Count -eq 1) {
        $debuggerEndpoint = $candidateEndpoint
        $codexDesktopPid = [string]$codexRoots[0].ProcessId
      }
    }
    catch {
      # Discord command control remains available. /connect re-checks and
      # fails closed before runner/network activity when this route is absent.
    }
  }
}

$cable = @(
  Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq 'OK' -and $_.FriendlyName -eq 'CABLE Input (VB-Audio Virtual Cable)' }
)
$cableEndpointId = $null
if ($cable.Count -eq 1) {
  $endpointMatch = [regex]::Match([string]$cable[0].InstanceId, '^SWD\\MMDEVAPI\\(.+)$')
  if ($endpointMatch.Success) { $cableEndpointId = $endpointMatch.Groups[1].Value }
}

[Environment]::SetEnvironmentVariable('CODEX_THREAD_ID', $ThreadId, 'Process')
[Environment]::SetEnvironmentVariable('CODEX_DESKTOP_DEBUGGER_ENDPOINT', $debuggerEndpoint, 'Process')
[Environment]::SetEnvironmentVariable('CODEX_BRIDGE_CODEX_DESKTOP_PID', $codexDesktopPid, 'Process')
[Environment]::SetEnvironmentVariable('CODEX_BRIDGE_VB_CABLE_RENDER_ENDPOINT_ID', $cableEndpointId, 'Process')
[Environment]::SetEnvironmentVariable('CODEX_BRIDGE_CONFIG', (Join-Path $repoRoot 'config\bridge.example.json'), 'Process')
[Environment]::SetEnvironmentVariable('CODEX_BRIDGE_MEETRON_RUNTIME_CONFIG', (Join-Path $repoRoot 'runtime\meetron-windows-live.json'), 'Process')

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$ready = $false
$stdoutPath = $null
$stderrPath = $null
for ($startupAttempt = 1; $startupAttempt -le 1 -and -not $ready; $startupAttempt += 1) {
  $stamp = Get-Date -Format 'yyyyMMddTHHmmssfff'
  $stdoutPath = Join-Path $outputDir "discord-production-control-$stamp.jsonl"
  $stderrPath = Join-Path $outputDir "discord-production-control-$stamp.stderr.txt"
  $process = Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList @('scripts/run-discord-production-control.mjs') `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru

  for ($readyAttempt = 0; $readyAttempt -lt 40; $readyAttempt += 1) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { break }
    if ((Test-Path -LiteralPath $stdoutPath) -and (Select-String -LiteralPath $stdoutPath -SimpleMatch '"state":"discord-ui-ready"' -Quiet)) {
      $ready = $true
      break
    }
  }
  if (-not $ready) {
    if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) {
      Stop-Process -Id $process.Id
      Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
    }
  }
}
if (-not $ready) { throw 'Production control did not reach discord-ui-ready; no automatic restart was attempted.' }

[pscustomobject]@{
  ready = $true
  controlCount = 1
  runnerCount = 0
  lockPresent = $false
  routeConfigured = $null -ne $debuggerEndpoint
  cableConfigured = $null -ne $cableEndpointId
  stdoutFile = Split-Path $stdoutPath -Leaf
  stderrFile = Split-Path $stderrPath -Leaf
  secretOutput = $false
  identifierOutput = $false
} | ConvertTo-Json -Compress
