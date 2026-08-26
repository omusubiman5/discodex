[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ThreadId,
  [switch]$RestartExisting
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$lockPath = Join-Path $repoRoot 'runtime\live-call.lock'
$stopControlScript = Join-Path $PSScriptRoot 'stop-discord-production-control-current.ps1'
$startControlScript = Join-Path $PSScriptRoot 'start-discord-production-control-current.ps1'
$debugPort = 9224
$debugEndpoint = "http://127.0.0.1:$debugPort"

if ($ThreadId -notmatch '^[0-9a-f-]{20,}$') { throw 'Fail-closed: the exact Codex task identity is invalid.' }

function Get-CodexRoots {
  return @(
    Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -match 'OpenAI\.Codex_' -and $_.CommandLine -notmatch '--type=' }
  )
}

function Test-CodexRouteReady {
  param([object[]]$Roots)
  if ($Roots.Count -ne 1) { return $false }
  $portMatch = [regex]::Match([string]$Roots[0].CommandLine, '--remote-debugging-port=(\d+)')
  if (-not $portMatch.Success) { return $false }
  $endpoint = "http://127.0.0.1:$($portMatch.Groups[1].Value)"
  try {
    $targets = @(Invoke-RestMethod -Uri "$endpoint/json/list" -TimeoutSec 2)
    return @($targets | Where-Object { $_.type -eq 'page' -and $_.url -eq 'app://-/index.html' }).Count -eq 1
  }
  catch { return $false }
}

function Get-CodexExecutable {
  param([object[]]$Roots)
  if ($Roots.Count -eq 1 -and (Test-Path -LiteralPath $Roots[0].ExecutablePath -PathType Leaf)) {
    return [string]$Roots[0].ExecutablePath
  }
  $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending | Select-Object -First 1
  if ($null -eq $package) { throw 'The installed Codex Desktop application could not be located.' }
  $candidate = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw 'The installed Codex Desktop executable is unavailable.' }
  return $candidate
}

$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
$controls = @($nodes | Where-Object { $_.CommandLine -match 'run-discord-production-control\.mjs' })
$runners = @($nodes | Where-Object { $_.CommandLine -match 'run-meetron-windows-live' })
if ($controls.Count -gt 1) { throw 'Fail-closed: multiple Relay controls exist.' }
if ($runners.Count -ne 0 -or (Test-Path -LiteralPath $lockPath)) { throw 'Disconnect Discord voice before preparing Codex Desktop.' }

$roots = @(Get-CodexRoots)
if ($roots.Count -gt 1) { throw 'Fail-closed: multiple Codex Desktop roots exist.' }
if (Test-CodexRouteReady $roots) {
  if ($controls.Count -eq 0) {
    & $startControlScript -ThreadId $ThreadId | Out-Null
  }
  [pscustomobject]@{ ready = $true; restarted = $false; controlCount = 1; runnerCount = 0; lockPresent = $false; secretOutput = $false; identifierOutput = $false } | ConvertTo-Json -Compress
  return
}

if ($roots.Count -eq 1 -and -not $RestartExisting) {
  throw 'Codex Desktop requires one Relay-managed restart before audio routing is available.'
}

$executable = Get-CodexExecutable $roots
if ($controls.Count -eq 1) { & $stopControlScript | Out-Null }

if ($roots.Count -eq 1) {
  $rootPid = [int]$roots[0].ProcessId
  $ownedCodexPids = @(
    Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -eq $executable } |
      Select-Object -ExpandProperty ProcessId
  )
  $rootProcess = Get-Process -Id $roots[0].ProcessId -ErrorAction Stop
  $closeAccepted = $rootProcess.CloseMainWindow()
  if ($closeAccepted) { $null = $rootProcess.WaitForExit(8000) }
  if (Get-Process -Id $rootPid -ErrorAction SilentlyContinue) {
    # The packaged desktop app may acknowledge WM_CLOSE while retaining its
    # background process.  The user already confirmed this bounded restart;
    # terminate only the captured Codex package process set, children first.
    foreach ($processId in @($ownedCodexPids | Where-Object { $_ -ne $rootPid })) {
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $rootPid -Force -ErrorAction Stop
    Wait-Process -Id $rootPid -Timeout 5 -ErrorAction SilentlyContinue
  }
  $remainingRoots = @(Get-CodexRoots)
  if ($remainingRoots.Count -ne 0) { throw 'Codex Desktop did not stop within the bounded Relay-managed restart.' }
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $debugPort -ErrorAction SilentlyContinue
if ($null -ne $listener) { throw 'The fixed local Codex attachment port is already in use.' }

$launched = $false
try {
  Start-Process -FilePath $executable -ArgumentList @(
    '--remote-debugging-address=127.0.0.1',
    "--remote-debugging-port=$debugPort"
  ) | Out-Null
  $launched = $true
  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  do {
    Start-Sleep -Milliseconds 250
    $roots = @(Get-CodexRoots)
    $ready = Test-CodexRouteReady $roots
  } until ($ready -or [DateTime]::UtcNow -gt $deadline)
  if (-not $ready) { throw 'Codex Desktop did not expose the verified local audio attachment endpoint.' }
  & $startControlScript -ThreadId $ThreadId | Out-Null
  $status = & (Join-Path $PSScriptRoot 'get-discodex-relay-status.ps1') | ConvertFrom-Json
  if ($status.controlCount -ne 1 -or $status.runnerCount -ne 0 -or $status.lockPresent -or -not $status.routePrepared) {
    throw 'Relay control did not become ready after Codex preparation.'
  }
  [pscustomobject]@{ ready = $true; restarted = ($roots.Count -eq 1); controlCount = 1; runnerCount = 0; lockPresent = $false; routePrepared = $true; secretOutput = $false; identifierOutput = $false } | ConvertTo-Json -Compress
}
catch {
  $remainingRoots = @(Get-CodexRoots)
  if ($launched -and $remainingRoots.Count -eq 0) { Start-Process -FilePath $executable | Out-Null }
  throw
}
