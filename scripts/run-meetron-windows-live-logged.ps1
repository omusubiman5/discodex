[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$lockPath = Join-Path $repoRoot 'runtime\live-call.lock'
$outputDir = Join-Path $repoRoot 'outputs'
$runnerSourcePath = Join-Path $repoRoot 'src\discord-gateway-smoke.ts'

$runnerSource = Get-Content -LiteralPath $runnerSourcePath -Raw
$productRunnerMatch = [regex]::Match($runnerSource, 'export async function runCurrentTaskLiveCall[\s\S]*?\r?\n}\r?\n\r?\nclass NativePrejoinDaveSession')
if (-not $productRunnerMatch.Success) {
  throw 'Fail-closed: the current-task product runner source boundary was not found.'
}
$productRunnerSource = $productRunnerMatch.Value
if ($productRunnerSource -match 'await\s+brain\.start\s*\(' -or $productRunnerSource -match 'brain\.stop\s*\(' -or $productRunnerSource -match 'brain\.reconnect\s*\(') {
  throw 'Fail-closed: bridge runner would own or restart the foreground Codex realtime call.'
}

$codexRoots = @(
  Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -match 'OpenAI\.Codex_' -and $_.CommandLine -notmatch '--type=' }
)
if ($codexRoots.Count -ne 1) {
  throw 'Fail-closed: exactly one existing Codex Desktop root process is required.'
}
$cableRenderEndpoints = @(
  Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq 'OK' -and $_.FriendlyName -eq 'CABLE Input (VB-Audio Virtual Cable)' }
)
if ($cableRenderEndpoints.Count -ne 1) {
  throw 'Fail-closed: exactly one official VB-CABLE render endpoint is required.'
}
$renderInstanceId = [string]$cableRenderEndpoints[0].InstanceId
if ($renderInstanceId -notmatch '^SWD\\MMDEVAPI\\(.+)$') {
  throw 'Fail-closed: the official VB-CABLE render endpoint id is invalid.'
}
$renderEndpointId = $Matches[1]
[Environment]::SetEnvironmentVariable('CODEX_BRIDGE_CODEX_DESKTOP_PID', [string]$codexRoots[0].ProcessId, 'Process')
[Environment]::SetEnvironmentVariable('CODEX_BRIDGE_VB_CABLE_RENDER_ENDPOINT_ID', $renderEndpointId, 'Process')

if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
  $lockOwner = 0
  [void][int]::TryParse((Get-Content -LiteralPath $lockPath -Raw).Trim(), [ref]$lockOwner)
  $ownerProcess = if ($lockOwner -gt 0) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$lockOwner" -ErrorAction SilentlyContinue
  } else {
    $null
  }
  if ($ownerProcess -and $ownerProcess.CommandLine -match 'run-meetron-windows-live|live:meetron:windows') {
    throw 'Fail-closed: runtime/live-call.lock belongs to a live process.'
  }
  Remove-Item -LiteralPath $lockPath -Force
}

$matchingRunners = @(
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'run-meetron-windows-live|live:meetron:windows' }
)
if ($matchingRunners.Count -ne 0) {
  throw 'Fail-closed: a Meetron Windows live runner is already active.'
}

$requiredSettings = @(
  'CODEX_THREAD_ID',
  'CODEX_DESKTOP_DEBUGGER_ENDPOINT',
  'CODEX_BRIDGE_CODEX_DESKTOP_PID',
  'CODEX_BRIDGE_VB_CABLE_RENDER_ENDPOINT_ID'
)
$missingSettings = @(
  $requiredSettings | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, 'Process'))
  }
)
if ($missingSettings.Count -ne 0 -and -not $DryRun) {
  throw "Fail-closed: required current-task settings are missing: $($missingSettings -join ', ')."
}

$cableEndpoints = @(
  Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -eq 'OK' -and $_.FriendlyName -match '^CABLE (Input|Output) \(VB-Audio Virtual Cable\)$' }
)
$vbCableReady = @($cableEndpoints | Select-Object -ExpandProperty FriendlyName -Unique).Count -eq 2
if (-not $vbCableReady -and -not $DryRun) {
  throw 'Fail-closed: official VB-CABLE Input and Output endpoints are not both present and healthy.'
}

$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$stdoutPath = Join-Path $outputDir "meetron-windows-live-$stamp.jsonl"
$stderrPath = Join-Path $outputDir "meetron-windows-live-$stamp.stderr.txt"
$routeScriptPath = Join-Path $repoRoot 'scripts\inspect-codex-realtime-audio-route.mjs'

$report = [ordered]@{
  ready = ($missingSettings.Count -eq 0 -and $vbCableReady)
  dryRun = [bool]$DryRun
  runnerCount = $matchingRunners.Count
  lockPresent = $false
  stdoutPath = $stdoutPath
  stderrPath = $stderrPath
  missingSettings = $missingSettings
  vbCableReady = $vbCableReady
}
$report | ConvertTo-Json -Compress

if ($DryRun) {
  exit 0
}

New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
try {
  $beforeRouteJson = & node $routeScriptPath
  if ($LASTEXITCODE -ne 0) {
    throw 'Fail-closed: exactly one current Codex call input is required.'
  }
  $beforeRoute = $beforeRouteJson | ConvertFrom-Json
  if ([int]$beforeRoute.liveAudioSenders -ne 1 -or [int]$beforeRoute.cableSenders -ne 0 -or [string]::IsNullOrWhiteSpace([string]$beforeRoute.currentTrackLabel)) {
    throw 'Fail-closed: the current Codex call input route lacks a reversible source identity.'
  }
} catch {
  @{
    state = 'codex-call-input-preflight-failed'
    stage = 'active-codex-audio-sender'
    globalDefaultsChanged = $false
    secretOutput = $false
  } | ConvertTo-Json -Compress | Tee-Object -FilePath $stderrPath -Append
  throw
}
$originalInputLabel = [string]$beforeRoute.currentTrackLabel
$routeMutationAttempted = $false
$locationPushed = $false
$runnerExit = 1
try {
  $routeMutationAttempted = $true
  $routeJson = & node $routeScriptPath --apply-cable-input
  if ($LASTEXITCODE -ne 0) {
    throw 'Fail-closed: the current Codex call input could not be switched to VB-CABLE.'
  }
  $route = $routeJson | ConvertFrom-Json
  if (-not $route.applied -or [int]$route.cableSenders -ne 1 -or [string]$route.previousTrackLabel -ne $originalInputLabel) {
    throw 'Fail-closed: the current Codex call input route changed during attachment.'
  }
  @{
    state = 'codex-call-input-routed'
    cableSenders = [int]$route.cableSenders
    globalDefaultsChanged = $false
    reversible = $true
  } | ConvertTo-Json -Compress | Tee-Object -FilePath $stdoutPath -Append

  $graphJson = & node $routeScriptPath --apply-cable-graph-input
  if ($LASTEXITCODE -ne 0) {
    throw 'Fail-closed: VB-CABLE could not be attached to the existing Codex WebAudio graph.'
  }
  $graph = $graphJson | ConvertFrom-Json
  if (-not $graph.applied -or -not $graph.graphAttached -or [int]$graph.cableSenders -ne 0) {
    throw 'Fail-closed: the current Codex WebAudio graph attachment is not isolated and reversible.'
  }
  @{
    state = 'codex-call-input-graph-attached'
    cableSenders = [int]$graph.cableSenders
    globalDefaultsChanged = $false
    reversible = $true
  } | ConvertTo-Json -Compress | Tee-Object -FilePath $stdoutPath -Append

  Push-Location $repoRoot
  $locationPushed = $true
  # PowerShell native redirection may buffer several KiB, hiding the exact
  # Discord/DAVE gate during a live rejoin. Tee writes each emitted JSONL line
  # to the timestamped artifact immediately while preserving terminal output.
  & npm.cmd run live:meetron:windows 2>> $stderrPath | Tee-Object -FilePath $stdoutPath -Append
  $runnerExit = $LASTEXITCODE
}
finally {
  if ($locationPushed) { Pop-Location }
  if ($routeMutationAttempted) {
    $afterRouteJson = & node $routeScriptPath
    $afterRouteExit = $LASTEXITCODE
    $afterRoute = if ($afterRouteExit -eq 0) { $afterRouteJson | ConvertFrom-Json } else { $null }
    if ($afterRoute -and ([int]$afterRoute.cableSenders -eq 1 -or [bool]$afterRoute.graphAttached)) {
      $rollbackJson = & node $routeScriptPath --apply-physical-input
      $rollbackExit = $LASTEXITCODE
      if ($rollbackExit -ne 0) {
        @{
          state = 'codex-call-input-rollback-failed'
          globalDefaultsChanged = $false
        } | ConvertTo-Json -Compress | Tee-Object -FilePath $stderrPath -Append
      } else {
        $rollback = $rollbackJson | ConvertFrom-Json
        @{
          state = 'codex-call-input-restored'
          cableSenders = [int]$rollback.cableSenders
          globalDefaultsChanged = $false
        } | ConvertTo-Json -Compress | Tee-Object -FilePath $stdoutPath -Append
      }
    }
  }
}
exit $runnerExit
