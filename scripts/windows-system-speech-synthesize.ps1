param(
  [Parameter(Mandatory = $true)][string]$WavePath,
  [int]$SampleRate = 24000,
  [string]$Culture = 'ja-JP'
)
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
Add-Type -AssemblyName System.Speech
$text = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($text)) { exit 0 }
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $voice = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo } | Where-Object { $_.Culture.Name -eq $Culture } | Select-Object -First 1
  if ($voice) { $synth.SelectVoice($voice.Name) }
  $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(
    $SampleRate,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
  )
  $synth.SetOutputToWaveFile($WavePath, $format)
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
