[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
$controls = @($nodes | Where-Object { $_.CommandLine -match 'run-discord-production-control\.mjs' })
$standaloneRunners = @($nodes | Where-Object { $_.CommandLine -match 'run-meetron-windows-live' })
$lockPresent = Test-Path -LiteralPath (Join-Path $repoRoot 'runtime\live-call.lock')
$lockOwnerPid = 0
if ($lockPresent) {
  try { $lockOwnerPid = [int](Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'runtime\live-call.lock')).Trim() } catch { $lockOwnerPid = 0 }
}
$embeddedRunnerCount = @($controls | Where-Object { $_.ProcessId -eq $lockOwnerPid }).Count
$runnerCount = $standaloneRunners.Count + $embeddedRunnerCount
$ownershipConsistent = (($runnerCount -eq 1) -and $lockPresent) -or (($runnerCount -eq 0) -and (-not $lockPresent))
$codexRoots = @(
  Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -match 'OpenAI\.Codex_' -and $_.CommandLine -notmatch '--type=' }
)
$routePrepared = $false
if ($codexRoots.Count -eq 1) {
  $portMatch = [regex]::Match([string]$codexRoots[0].CommandLine, '--remote-debugging-port=(\d+)')
  if ($portMatch.Success) {
    try {
      $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:$($portMatch.Groups[1].Value)/json/list" -TimeoutSec 2)
      $routePrepared = @($targets | Where-Object { $_.type -eq 'page' -and $_.url -eq 'app://-/index.html' }).Count -eq 1
    }
    catch { $routePrepared = $false }
  }
}

[pscustomobject]@{
  controlCount = $controls.Count
  runnerCount = $runnerCount
  lockPresent = $lockPresent
  routePrepared = $routePrepared
  healthy = ($controls.Count -le 1) -and ($runnerCount -le 1) -and $ownershipConsistent
  secretOutput = $false
  identifierOutput = $false
} | ConvertTo-Json -Compress
