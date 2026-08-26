[CmdletBinding()]
param(
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$appScript = Join-Path $repoRoot 'scripts\run-discodex-relay-app.ps1'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not $OutputPath) { $OutputPath = Join-Path $repoRoot 'dist\Discodex Relay.lnk' }
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$distRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'dist'))
if (-not $outputFullPath.StartsWith($distRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Relay output must remain under the repository dist directory.'
}
if ([IO.Path]::GetExtension($outputFullPath) -ine '.lnk') { throw 'Relay application entry must be a Windows shortcut.' }
if (-not (Test-Path -LiteralPath $appScript -PathType Leaf)) { throw 'Relay application script is unavailable.' }
if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) { throw 'Windows PowerShell is unavailable.' }

$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($appScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ('Relay application script failed parsing: ' + $parseErrors[0].Message) }

New-Item -ItemType Directory -Path (Split-Path -Parent $outputFullPath) -Force | Out-Null
$shell = New-Object -ComObject WScript.Shell
try {
  $shortcut = $shell.CreateShortcut($outputFullPath)
  $shortcut.TargetPath = $windowsPowerShell
  $shortcut.Arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $appScript + '"'
  $shortcut.WorkingDirectory = $repoRoot
  $shortcut.Description = 'Discodex Voice Bridge control and GPT Live output gain'
  $shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,14"
  $shortcut.Save()
}
finally {
  if ($null -ne $shortcut) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null }
  [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
}

$readbackShell = New-Object -ComObject WScript.Shell
try {
  $readback = $readbackShell.CreateShortcut($outputFullPath)
  if ($readback.TargetPath -ine $windowsPowerShell -or $readback.Arguments -notmatch [regex]::Escape($appScript)) {
    throw 'Relay shortcut readback did not match the fixed signed host and app script.'
  }
}
finally {
  if ($null -ne $readback) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($readback) | Out-Null }
  [Runtime.InteropServices.Marshal]::FinalReleaseComObject($readbackShell) | Out-Null
}

$artifact = Get-Item -LiteralPath $outputFullPath
$stream = [IO.File]::OpenRead($outputFullPath)
try {
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $hash = ([BitConverter]::ToString($hasher.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
}
finally { $stream.Dispose() }
[pscustomobject]@{
  built = $true
  artifact = $artifact.Name
  host = 'Windows PowerShell'
  bytes = $artifact.Length
  sha256 = $hash
  secretOutput = $false
  identifierOutput = $false
} | ConvertTo-Json -Compress
