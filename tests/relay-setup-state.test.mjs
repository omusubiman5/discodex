import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

for (const scenario of ["repeat", "refresh", "read-error", "start", "prepare"]) {
  test(`Windows Relay setup state transition: ${scenario}`, { skip: process.platform !== "win32" }, () => {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", resolve("tests/fixtures/relay-setup-state.ps1"), "-Scenario", scenario,
    ], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`PASS ${scenario}`));
  });
}
