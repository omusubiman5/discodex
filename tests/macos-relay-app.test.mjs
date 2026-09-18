import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const swift = await readFile(new URL("../native/macos/Sources/DiscodexRelayMac/main.swift", import.meta.url), "utf8");
const manager = await readFile(new URL("../scripts/manage-discodex-relay-macos.mjs", import.meta.url), "utf8");
const builder = await readFile(new URL("../scripts/build-discodex-relay-macos.sh", import.meta.url), "utf8");
const packageSource = await readFile(new URL("../native/macos/Package.swift", import.meta.url), "utf8");

test("macOS Relay exposes the same launch and control workflow as Windows", () => {
  assert.match(swift, /Prepare Codex/);
  assert.match(swift, /Start Relay/);
  assert.match(swift, /Stop Relay/);
  assert.match(swift, /GPT Live → Discord output volume/);
  assert.match(swift, /Start Screen Share/);
  assert.match(swift, /Use \/disconnect in Discord before closing/);
  assert.match(swift, /refreshState\(autoStart: true\)/);
  assert.match(swift, /Timer\.scheduledTimer\(withTimeInterval: 2/);
  assert.match(swift, /controlRecoveryUsed/);
  assert.match(swift, /runnerCount == 0 && !state\.lockPresent/);
  assert.match(swift, /beginActivity\(options: \[\.idleSystemSleepDisabled\]/);
  assert.match(swift, /endActivity\(sleepActivity\)/);
  assert.match(swift, /System sleep blocked while Relay is open/);
  assert.doesNotMatch(swift, /EXACT_CODEX_TASK_ID|Terminal/);
});

test("macOS Relay manager owns bounded prepare, start, stop, and exact-task configuration", () => {
  assert.match(manager, /resolve\(runtimeRoot, "discodex-relay\.thread-id"\)/);
  assert.match(manager, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(manager, /--remote-debugging-port=9224/);
  assert.match(manager, /scripts\/run-discodex-macos\.sh/);
  assert.match(manager, /discord-ui-ready/);
  assert.match(manager, /Use \/disconnect in Discord before stopping Relay/);
  assert.match(manager, /Date\.now\(\) \+ 30_000/);
  assert.doesNotMatch(manager, /SetDefaultAudio|sudo|launchctl/);
});

test("macOS Relay presents a safe first-time setup checklist before it enables launch", () => {
  assert.match(swift, /struct RelaySetup/);
  assert.match(swift, /let relay = !setup\.ready \? "SETUP NEEDED"/);
  assert.match(swift, /latestSetup\?\.ready == true/);
  assert.match(swift, /setupHeading\.stringValue = "Complete these setup items before starting Relay"/);
  assert.match(swift, /window\.appearance = NSAppearance\(named: \.aqua\)/);
  assert.match(swift, /setupHint\.frame = NSRect\(x: 25, y: 338, width: 670, height: 72\)/);
  assert.match(swift, /setupHint\.maximumNumberOfLines = 5/);
  assert.match(swift, /Next: complete the items above, then click Check Setup\./);
  assert.match(swift, /primary\.title = setup\.ready \? \(state\.routePrepared \? "Start Relay" : "Prepare Codex"\) : "Check Setup"/);
  assert.match(swift, /guard latestSetup\?\.ready == true else \{ refreshState\(\); return \}/);
  assert.match(swift, /config\/meetron-macos-live\.example\.json/);
  assert.match(swift, /runtime\/meetron-macos-live\.json/);
  assert.match(swift, /Login Keychain/);
  assert.match(swift, /runtime\/discodex-relay\.thread-id/);
  assert.match(swift, /48 kHz \/ 2 ch/);
  assert.match(swift, /healthCheck \? \["status", "--skip-setup"\] : \["status"\]/);
  assert.match(swift, /autoStart && setup\.ready && state\.controlCount == 0/);
  assert.match(manager, /inspectRelaySetup/);
  assert.match(manager, /requireSharedRelaySetup/);
  assert.match(manager, /includeSetup: !has\("--skip-setup"\)/);
  assert.doesNotMatch(manager, /discordGuildId.*process\.stderr|discordVoiceChannelId.*process\.stderr/);
});

test("macOS Relay builder creates one signed app under dist", () => {
  assert.match(packageSource, /discodex-relay-macos/);
  assert.match(builder, /app_root="\$dist_root\/Discodex Relay\.app"/);
  assert.match(builder, /codesign --force --sign - --timestamp=none/);
  assert.match(builder, /codesign --verify --deep --strict/);
  assert.match(builder, /Relay output escaped the repository dist directory/);
});
