param(
  [Parameter(Mandatory = $true)][string]$WavePath,
  [string]$Culture = 'ja-JP'
)
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
Add-Type -AssemblyName System.Speech
$installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
$info = $installed | Where-Object { $_.Culture.Name -eq $Culture } | Select-Object -First 1
if (-not $info) { throw "No Windows speech recognizer is installed for the requested culture." }
$recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::new($info)
try {
  $recognizer.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
  $recognizer.SetInputToWaveFile($WavePath)
  $result = $recognizer.Recognize()
  if ($result -and $result.Text) { [Console]::Out.Write($result.Text) }
} finally {
  $recognizer.Dispose()
}
