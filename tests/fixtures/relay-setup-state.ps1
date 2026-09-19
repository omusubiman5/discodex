param([Parameter(Mandatory=$true)][string]$Scenario)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$source = Join-Path $PSScriptRoot '../../scripts/run-discodex-relay-app.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Source parse failed' }
foreach ($name in @('Start-RelayControlOperation','Set-RelayBusy','Set-RelayButtonState','Update-RelayStatus')) {
  $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }.GetNewClosure(), $true)
  if (-not $definition) { throw "Missing function: $name" }
  Invoke-Expression $definition.Extent.Text
}
# Self-verification: production functions with synthetic UI and OS boundaries.
function Update-RelayButtonVisualStates {}
function Get-RelaySnapshot {
  if ($script:failRead) { throw 'Synthetic read failure' }
  return $script:fixture
}
function Get-ConfiguredThreadId { return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
function Show-RelayError { param($Message) $script:errorShown = $true }
function Get-CimInstance { return @() }
function Write-RelayAudit {}
function Quote-RelayArgument { param($Value) return $Value }
function Start-RelayChild {
  $script:launches += 1
  return [pscustomobject]@{ Synthetic = $true }
}
function Assert-State { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
$form = [pscustomobject]@{ UseWaitCursor = $false }
foreach ($name in @('refreshButton','applyButton','shareStopButton','startButton','stopButton','shareStartButton','statusLabel','relayBadge','voiceBadge','routeBadge')) {
  Set-Variable -Name $name -Value ([pscustomobject]@{ Enabled=$true; Text=''; BackColor='' })
}
$ghibliBlue='blue'; $labelGray='gray'; $orangeAccent='orange'
$windowsPowerShell='synthetic'; $prepareCodexScript='prepare'; $startScript='start'
$script:fixture = [pscustomobject]@{ setup=[pscustomobject]@{ ready=$false }; controlCount=0; runnerCount=0; lockPresent=$false; routePrepared=$false }
$script:activeOperation=$null; $script:busy=$false; $script:launches=0; $script:failRead=$false; $script:errorShown=$false
Update-RelayStatus
switch ($Scenario) {
  'repeat' {
    1..2 | ForEach-Object {
      Start-RelayControlOperation
      Assert-State (-not $script:busy -and -not $form.UseWaitCursor) 'Setup check left the UI busy'
      Assert-State ($startButton.Enabled -and $refreshButton.Enabled) 'Setup check disabled retry'
      Assert-State ($null -eq $script:activeOperation -and $script:launches -eq 0) 'Incomplete setup started a child'
    }
  }
  'refresh' {
    Start-RelayControlOperation
    Assert-State $refreshButton.Enabled 'Cannot refresh after correcting setup'
    $script:fixture.setup.ready=$true
    $script:fixture.routePrepared=$true
    Set-RelayBusy $true
    try { Update-RelayStatus } finally { Set-RelayBusy $false }
    Assert-State ($startButton.Enabled -and $startButton.Text -eq 'Start Relay') 'Refresh did not enable start'
    Assert-State ($null -ne $script:threadId) 'Refresh did not reload task'
    Start-RelayControlOperation
    Assert-State ($script:launches -eq 1 -and $script:busy) 'Corrected setup did not start'
  }
  'read-error' {
    $script:failRead=$true
    Start-RelayControlOperation
    Assert-State ($script:errorShown -and -not $script:busy -and -not $form.UseWaitCursor) 'Read error left UI busy'
    Assert-State ($refreshButton.Enabled -and $script:launches -eq 0) 'Read error prevented retry or started a child'
  }
  { $_ -in @('start','prepare') } {
    $script:fixture.setup.ready=$true
    $script:fixture.routePrepared=($Scenario -eq 'start')
    Update-RelayStatus
    Start-RelayControlOperation
    Assert-State ($script:busy -and $form.UseWaitCursor -and -not $startButton.Enabled) 'Async operation released busy too soon'
    $expectedKind = if ($Scenario -eq 'start') { 'Start Relay' } else { 'Prepare Codex' }
    Assert-State ($script:activeOperation.Kind -eq $expectedKind) 'Wrong operation selected'
    Start-RelayControlOperation
    Assert-State ($script:launches -eq 1) 'Duplicate child started'
  }
  default { throw 'Unknown scenario' }
}
Write-Output "PASS $Scenario"
