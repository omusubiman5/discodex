[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)
$controls = @($nodes | Where-Object { $_.CommandLine -match 'run-discord-production-control\.mjs' })
$runners = @($nodes | Where-Object { $_.CommandLine -match 'run-meetron-windows-live' })
$lockPath = Join-Path $repoRoot 'runtime\live-call.lock'
if ($controls.Count -eq 0) {
  [pscustomobject]@{ stopped = $false; alreadyStopped = $true; secretOutput = $false; identifierOutput = $false } | ConvertTo-Json -Compress
  exit 0
}
if ($controls.Count -ne 1) { throw 'Fail-closed: production control ownership is not unique.' }
if ($runners.Count -ne 0 -or (Test-Path -LiteralPath $lockPath)) { throw 'Disconnect the Discord voice runner before stopping Relay.' }

Stop-Process -Id $controls[0].ProcessId
Wait-Process -Id $controls[0].ProcessId -Timeout 10 -ErrorAction SilentlyContinue
$remaining = @(
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'run-discord-production-control\.mjs' }
)
if ($remaining.Count -ne 0) { throw 'Production control did not stop within the bounded window.' }
[pscustomobject]@{ stopped = $true; alreadyStopped = $false; secretOutput = $false; identifierOutput = $false } | ConvertTo-Json -Compress
