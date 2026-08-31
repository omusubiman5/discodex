import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("a later Relay instance replaces only an older exact-script process without killing itself", () => {
  const source = readFileSync(resolve("scripts/run-discodex-relay-app.ps1"), "utf8");
  assert.match(source, /Local\\DiscodexRelayApplicationStartup/);
  assert.match(source, /\$relayScriptPath = \[IO\.Path\]::GetFullPath\(\$PSCommandPath\)/);
  assert.match(source, /\$_\.ProcessId -ne \$PID/);
  assert.match(source, /\$_\.Name -in @\('powershell\.exe', 'pwsh\.exe'\)/);
  assert.match(source, /\[string\]\$_\.CommandLine -match \$relayFilePattern/);
  assert.match(source, /Stop-Process -Id \$staleRelayProcess\.ProcessId -Force/);
  assert.match(source, /Wait-Process -Id \$staleRelayProcess\.ProcessId -Timeout 5/);
  assert.ok(source.indexOf("Local\\DiscodexRelayApplicationStartup") < source.indexOf("Local\\DiscodexRelayApplication'"));
});
