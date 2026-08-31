import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("the first Relay owner disables later launch entries without terminating processes", () => {
  const source = readFileSync(resolve("scripts/run-discodex-relay-app.ps1"), "utf8");
  assert.match(source, /\$mutex = \[Threading\.Mutex\]::new\(\$true, 'Local\\DiscodexRelayApplication', \[ref\]\$createdNew\)/);
  assert.match(source, /if \(-not \$createdNew\)[\s\S]*?\$mutex\.Dispose\(\)[\s\S]*?return/);
  assert.doesNotMatch(source, /Stop-Process|Wait-Process|staleRelayProcesses|DiscodexRelayApplicationStartup/);
  assert.ok(source.indexOf("if (-not $createdNew)") < source.indexOf("Add-Type -AssemblyName System.Windows.Forms"));
});
