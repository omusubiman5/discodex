Option Explicit

Dim shell, fileSystem, scriptDirectory, appScript, windowsPowerShell, command

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
appScript = fileSystem.BuildPath(scriptDirectory, "run-discodex-relay-app.ps1")
windowsPowerShell = fileSystem.BuildPath(shell.ExpandEnvironmentStrings("%SystemRoot%"), "System32\WindowsPowerShell\v1.0\powershell.exe")

If Not fileSystem.FileExists(appScript) Then
  Err.Raise vbObjectError + 1, "Discodex Relay", "Relay application script is unavailable."
End If

If Not fileSystem.FileExists(windowsPowerShell) Then
  Err.Raise vbObjectError + 2, "Discodex Relay", "Windows PowerShell is unavailable."
End If

command = QuoteArgument(windowsPowerShell) & " -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File " & QuoteArgument(appScript)

' Window style 0 is intentionally enforced here. Launching powershell.exe
' directly from a shortcut can make Windows Terminal display an empty tab
' when it is configured as the default terminal host.
shell.Run command, 0, False

Function QuoteArgument(value)
  QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
