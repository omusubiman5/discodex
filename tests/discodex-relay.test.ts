import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { TEST_DISCORD_ID_5, TEST_DISCORD_ID_10 } from "./fixtures/public-identities.mjs";

const sourcePath = resolve("scripts/run-discodex-relay-app.ps1");
const buildPath = resolve("scripts/build-discodex-relay.ps1");
const artifactPath = resolve("dist/Discodex Relay.lnk");

test("Relay app script is UTF-8 with BOM for Windows PowerShell 5.1", () => {
  const source = readFileSync(sourcePath);
  assert.deepEqual(Array.from(source.subarray(0, 3)), [0xef, 0xbb, 0xbf]);
});

test("Relay app exposes only fixed start, stop, status, and output-gain controls", () => {
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /start-discord-production-control-current\.ps1/);
  assert.match(source, /stop-discord-production-control-current\.ps1/);
  assert.match(source, /get-discodex-relay-status\.ps1/);
  assert.match(source, /manage-discord-output-gain\.mjs/);
  assert.match(source, /prepare-codex-desktop-for-discodex\.ps1/);
  assert.match(source, /Local\\DiscodexRelayApplication/);
  assert.match(source, /\[Windows\.Forms\.Application\]::Run\(\$form\)/);
  assert.match(source, /\$gainSlider\.Minimum = 25/);
  assert.match(source, /\$gainSlider\.Maximum = 100/);
  assert.match(source, /GPT Live → Discord output volume/);
  assert.match(source, /True-peak limiter: −1 dBTP/);
  assert.match(source, /CODEX ROUTE SETUP NEEDED/);
  assert.match(source, /Codex Desktop needs one Relay-managed restart/);
  assert.match(source, /Use \/disconnect in Discord before closing/);
  assert.doesNotMatch(source, /ScheduledTask|Registry|discodex:\/\/|cmd\.exe|run-meetron-windows-live/);
});

test("Relay app follows the supplied classical brown and blue design system", () => {
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /FromArgb\(0x22, 0x18, 0x15\)/);
  assert.match(source, /FromArgb\(0x10, 0x9c, 0xeb\)/);
  assert.match(source, /FromArgb\(0x00, 0x8c, 0xc1\)/);
  assert.match(source, /FromArgb\(0xf7, 0x9b, 0x30\)/);
  assert.match(source, /FromArgb\(0xf4, 0xf4, 0xf4\)/);
  assert.match(source, /\[Drawing\.Font\]::new\('Meiryo'/);
  assert.match(source, /\$header\.BackColor = \$ghibliBrown/);
  assert.match(source, /FlatAppearance\.BorderColor = \$buttonBorderBlue/);
  assert.match(source, /Set-RoundedRegion \$Button 7/);
  assert.match(source, /BorderStyle = \[Windows\.Forms\.BorderStyle\]::FixedSingle/);
  assert.doesNotMatch(source, /DropShadow|WebFont|CssCustomProperty/);
});

test("Relay probe returns before mutex, audit, UI, or child process creation", () => {
  const source = readFileSync(sourcePath, "utf8");
  const probeIndex = source.indexOf("if ($Probe)");
  assert.ok(probeIndex > 0);
  for (const marker of ["[Threading.Mutex]::new", "$auditPath =", "Start-RelayChild", "Application]::Run"]) {
    assert.ok(source.indexOf(marker) > probeIndex, `${marker} must follow the probe boundary`);
  }
});

test("Relay keeps long start and stop operations asynchronous and bounded", () => {
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /\$operationTimer\.Interval = 200/);
  assert.match(source, /Start-RelayChild \$windowsPowerShell \$arguments 30000 \$false/);
  assert.match(source, /Start-RelayChild \$windowsPowerShell \$arguments 15000 \$false/);
  assert.match(source, /\[DateTime\]::UtcNow -gt \$script:activeOperation\.Deadline/);
  assert.match(source, /controlCount -ne 1.*runnerCount -ne 0.*lockPresent/s);
});

test("opening the Relay app automatically readies command control when ownership is clear", () => {
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /\$form\.Add_Shown\(/);
  assert.match(source, /\$autoStart = \$script:lastSnapshot\.controlCount -eq 0.*runnerCount -eq 0.*lockPresent/s);
  assert.match(source, /if \(\$autoStart\) \{ Start-RelayControlOperation \}/);
  assert.match(source, /\$relayBadge\.Text = 'RELAY STARTING'/);
});

test("Relay supervises only command control with one recovery and never retries the voice runner", () => {
  const source = readFileSync(new URL("../scripts/run-discodex-relay-app.ps1", import.meta.url), "utf8");
  assert.match(source, /controlRecoveryUsed/);
  assert.match(source, /relay-control-unexpected-exit/);
  assert.match(source, /healthTimer\.Interval = 2000/);
  assert.match(source, /TotalSeconds -ge 60/);
  assert.doesNotMatch(source, /healthTimer[\s\S]*run-meetron-windows-live/);
});

test("Relay button state follows single-control and voice-lock ownership", () => {
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /\$script:lastSnapshot = \$snapshot/);
  assert.match(source, /\$startButton\.Enabled = \$script:lastSnapshot\.controlCount -le 1.*runnerCount -eq 0.*lockPresent/s);
  assert.match(source, /\$stopButton\.Enabled = \$script:lastSnapshot\.controlCount -eq 1.*runnerCount -eq 0.*lockPresent/s);
});

test("Relay owns Codex route preparation without exposing debugger settings to the user", () => {
  const source = readFileSync(sourcePath, "utf8");
  const prepare = readFileSync(resolve("scripts/prepare-codex-desktop-for-discodex.ps1"), "utf8");
  const status = readFileSync(resolve("scripts/get-discodex-relay-status.ps1"), "utf8");
  assert.match(source, /if \(-not \$snapshot\.routePrepared\)/);
  assert.match(source, /\$startButton\.Text = if \(\$script:lastSnapshot\.routePrepared\) \{ 'Start Relay' \} else \{ 'Prepare Codex' \}/);
  assert.match(prepare, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(prepare, /--remote-debugging-port=\$debugPort/);
  assert.match(prepare, /CloseMainWindow\(\)/);
  assert.match(prepare, /\$ownedCodexPids = @\(/);
  assert.match(prepare, /Stop-Process -Id \$processId -Force/);
  assert.ok(prepare.indexOf("CloseMainWindow()") < prepare.indexOf("Stop-Process -Id $processId -Force"));
  assert.doesNotMatch(prepare, /taskkill|SetDefaultAudioEndpoint|ScheduledTask/);
  assert.match(status, /routePrepared = \$routePrepared/);
  assert.match(status, /\$embeddedRunnerCount = @\(\$controls/);
  assert.match(status, /\$runnerCount = \$standaloneRunners\.Count \+ \$embeddedRunnerCount/);
});

test("production launcher starts control once and cleans a failed process without retry", () => {
  const source = readFileSync(resolve("scripts/start-discord-production-control-current.ps1"), "utf8");
  assert.match(source, /startupAttempt = 1/);
  assert.match(source, /startupAttempt -le 1/);
  assert.match(source, /no automatic restart was attempted/);
  assert.match(source, /Wait-Process -Id \$process\.Id -Timeout 5/);
  assert.match(source, /Discord command control remains available/);
  assert.match(source, /routeConfigured = \$null -ne \$debuggerEndpoint/);
  assert.match(source, /cableConfigured = \$null -ne \$cableEndpointId/);
  assert.doesNotMatch(source, /debugger port was not published/);
  assert.doesNotMatch(source, /ScheduledTask|SetDefaultAudioEndpoint/);
});

test("gain command persists approved values and rejects unsafe values", () => {
  const directory = mkdtempSync(join(tmpdir(), "discodex-relay-gain-"));
  try {
    const runtimePath = join(directory, "runtime.json");
    const storePath = join(directory, "gain.json");
    writeFileSync(runtimePath, JSON.stringify({
      discordGuildId: TEST_DISCORD_ID_5,
      discordVoiceChannelId: TEST_DISCORD_ID_10,
    }));
    const env = { ...process.env, CODEX_BRIDGE_MEETRON_RUNTIME_CONFIG: runtimePath, CODEX_BRIDGE_GAIN_STORE_PATH: storePath };
    const initial = spawnSync("node.exe", [resolve("scripts/manage-discord-output-gain.mjs"), "get"], { encoding: "utf8", env });
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(JSON.parse(initial.stdout).gainPercent, 50);
    const set = spawnSync("node.exe", [resolve("scripts/manage-discord-output-gain.mjs"), "set", "0.40"], { encoding: "utf8", env });
    assert.equal(set.status, 0, set.stderr);
    assert.equal(JSON.parse(set.stdout).gainPercent, 40);
    const unsafe = spawnSync("node.exe", [resolve("scripts/manage-discord-output-gain.mjs"), "set", "1.01"], { encoding: "utf8", env });
    assert.notEqual(unsafe.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Relay PowerShell boundaries parse without errors", () => {
  for (const script of [
    sourcePath,
    buildPath,
    resolve("scripts/get-discodex-relay-status.ps1"),
    resolve("scripts/prepare-codex-desktop-for-discodex.ps1"),
    resolve("scripts/start-discord-production-control-current.ps1"),
    resolve("scripts/stop-discord-production-control-current.ps1"),
  ]) {
    const command = `$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors); if ($errors.Count) { $errors | ForEach-Object Message; exit 1 }`;
    const parsed = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
    assert.equal(parsed.status, 0, `${script}: ${parsed.stderr || parsed.stdout}`);
  }
});

test("Relay builds a fixed shortcut to signed Windows PowerShell and probe is read-only", () => {
  const buildSource = readFileSync(buildPath, "utf8");
  assert.match(buildSource, /WScript\.Shell/);
  assert.match(buildSource, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(buildSource, /-NoProfile -STA -WindowStyle Hidden/);
  const controlCount = () => spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object CommandLine -match 'run-discord-production-control\\.mjs').Count"],
    { encoding: "utf8" },
  ).stdout.trim();
  const auditFiles = () => existsSync(resolve("outputs"))
    ? readdirSync(resolve("outputs")).filter((name) => name.startsWith("discodex-relay-") && name.endsWith(".jsonl")).sort()
    : [];
  const controlsBefore = controlCount();
  const auditsBefore = auditFiles();
  const build = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", buildPath], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  assert.equal(existsSync(artifactPath), true);
  const probe = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", sourcePath, "-Probe"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
  assert.equal(JSON.parse(probe.stdout).mutation, false);
  assert.equal(controlCount(), controlsBefore);
  assert.deepEqual(auditFiles(), auditsBefore);
});
