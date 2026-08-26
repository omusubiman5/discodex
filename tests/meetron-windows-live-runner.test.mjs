import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLiveCallProcessLock } from "../src/discord-gateway-smoke.ts";
import { createSupportedStopWatcher, expectedSessionIdentityForThread, LiveTurnCausalTracker, loadMeetronWindowsLiveConfiguration } from "../scripts/run-meetron-windows-live.mjs";

const complete = {
  CODEX_THREAD_ID: "REDACTED_CODEX_TASK_ID_2",
  CODEX_DESKTOP_DEBUGGER_ENDPOINT: "http://127.0.0.1:52895",
  CODEX_BRIDGE_CODEX_DESKTOP_PID: "16340",
  CODEX_BRIDGE_VB_CABLE_RENDER_ENDPOINT_ID: "{0.0.0.00000000}.{00000000-0000-0000-0000-000000000001}",
  CODEX_BRIDGE_DISCORD_GUILD_ID: "REDACTED_DISCORD_ID_7",
  CODEX_BRIDGE_DISCORD_VOICE_CHANNEL_ID: "REDACTED_DISCORD_ID_9",
};

test("Windows Meetron runner requires the exact current Codex task and Discord identities", () => {
  const config = loadMeetronWindowsLiveConfiguration(complete);
  assert.equal(config.threadId, complete.CODEX_THREAD_ID);
  assert.equal(config.debuggerEndpoint, complete.CODEX_DESKTOP_DEBUGGER_ENDPOINT);
  assert.equal(config.desktopProcessId, 16340);
  assert.equal(config.virtualCableRenderEndpointId, complete.CODEX_BRIDGE_VB_CABLE_RENDER_ENDPOINT_ID);
  assert.deepEqual(config.target, { guildId: complete.CODEX_BRIDGE_DISCORD_GUILD_ID, channelId: complete.CODEX_BRIDGE_DISCORD_VOICE_CHANNEL_ID });
  assert.throws(
    () => loadMeetronWindowsLiveConfiguration({ ...complete, CODEX_THREAD_ID: "" }),
    /CODEX_THREAD_ID/,
  );
  assert.throws(() => loadMeetronWindowsLiveConfiguration({ ...complete, CODEX_DESKTOP_DEBUGGER_ENDPOINT: "https://example.com" }), /loopback/);
  assert.throws(
    () => loadMeetronWindowsLiveConfiguration({ ...complete, CODEX_BRIDGE_DISCORD_VOICE_CHANNEL_ID: "" }),
    /CODEX_BRIDGE_DISCORD_VOICE_CHANNEL_ID/,
  );
});

test("production Meetron runner delegates recovery to Voice Gateway without full-session retry", async () => {
  const source = await readFile(new URL("../scripts/run-meetron-windows-live.mjs", import.meta.url), "utf8");
  assert.match(source, /maxReconnectAttempts:\s*0/);
});

test("production Meetron runner reports joined at Discord Voice Ready, not main voice-state handoff", async () => {
  const source = await readFile(new URL("../scripts/run-meetron-windows-live.mjs", import.meta.url), "utf8");
  assert.match(source, /voice-state-matched", joined: false, targetMatched: true/);
  assert.match(source, /voice-ready", joined: true, targetMatched: gates\.targetChannelMatched/);
  assert.match(source, /joined-ready", joined: true, targetMatched: gates\.targetChannelMatched/);
});

test("Windows logged wrapper rejects foreground realtime call ownership before launch", async () => {
  const source = await readFile(new URL("../scripts/run-meetron-windows-live-logged.ps1", import.meta.url), "utf8");
  assert.match(source, /await\\s\+brain\\\.start/);
  assert.match(source, /bridge runner would own or restart the foreground Codex realtime call/);
  assert.ok(source.indexOf("runnerSource") < source.indexOf("npm.cmd run live:meetron:windows"));
});

test("Windows logged wrapper switches only the active Codex call input and always attempts rollback", async () => {
  const source = await readFile(new URL("../scripts/run-meetron-windows-live-logged.ps1", import.meta.url), "utf8");
  const routeSource = await readFile(new URL("../scripts/inspect-codex-realtime-audio-route.mjs", import.meta.url), "utf8");
  assert.match(source, /inspect-codex-realtime-audio-route\.mjs/);
  assert.match(source, /--apply-cable-input/);
  assert.match(source, /--apply-cable-graph-input/);
  assert.match(source, /finally\s*\{/);
  assert.match(source, /--apply-physical-input/);
  assert.doesNotMatch(source, /SetDefaultEndpoint|Set-AudioDevice/);
  assert.ok(source.indexOf("--apply-cable-input") < source.indexOf("npm.cmd run live:meetron:windows"));
  assert.ok(source.indexOf("--apply-cable-graph-input") < source.indexOf("npm.cmd run live:meetron:windows"));
  assert.ok(source.indexOf("npm.cmd run live:meetron:windows") < source.indexOf("--apply-physical-input"));
  assert.match(routeSource, /graphTrack !== graphRollback\.originalTrack/);
  assert.match(routeSource, /if \(ownsIsolatedGraphTrack\) graphRollback\.graphTrack\.stop\(\)/);
});

test("supported restart preserves exact task identity and releases stale ownership", () => {
  const before = loadMeetronWindowsLiveConfiguration({ ...complete });
  const after = loadMeetronWindowsLiveConfiguration({ ...complete });
  assert.equal(expectedSessionIdentityForThread(before.threadId), expectedSessionIdentityForThread(after.threadId));
  assert.equal(expectedSessionIdentityForThread(before.threadId).length, 64);

  const directory = mkdtempSync(join(tmpdir(), "cdvb-supported-restart-"));
  const lockPath = join(directory, "live-call.lock");
  try {
    const releaseBeforeRestart = acquireLiveCallProcessLock(lockPath);
    assert.throws(() => acquireLiveCallProcessLock(lockPath), /already active/);
    releaseBeforeRestart();
    const releaseAfterRestart = acquireLiveCallProcessLock(lockPath);
    releaseAfterRestart();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("supported stop aborts through the control boundary and removes stale state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cdvb-supported-stop-"));
  const stopPath = join(directory, "live-call.stop");
  const watcher = createSupportedStopWatcher({ stopPath, intervalMs: 10 });
  try {
    writeFileSync(stopPath, "stop\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(watcher.requested, true);
    assert.equal(watcher.controller.signal.aborted, true);
  } finally {
    watcher.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("turn causal markers preserve consecutive ordinals without content", () => {
  const tracker = new LiveTurnCausalTracker();
  assert.deepEqual(tracker.inputStarted(), [{ state: "turn-input-started", turnOrdinal: 1 }]);
  assert.deepEqual(tracker.inputStarted(), []);
  assert.deepEqual(tracker.inputEnded(), [{ state: "turn-input-ended", turnOrdinal: 1 }]);
  assert.deepEqual(tracker.inputStarted(), []);
  assert.deepEqual(tracker.inputEnded(), []);
  assert.deepEqual(tracker.outputStarted(), [{ state: "turn-response-started", turnOrdinal: 1 }]);
  assert.deepEqual(tracker.inputStarted(), []);
  assert.deepEqual(tracker.outputSent(), [{ state: "turn-roundtrip-completed", turnOrdinal: 1 }]);
  assert.deepEqual(tracker.inputEnded(), []);
  assert.deepEqual(tracker.inputStarted(), [{ state: "turn-input-started", turnOrdinal: 2 }]);
  assert.deepEqual(tracker.inputEnded(), [{ state: "turn-input-ended", turnOrdinal: 2 }]);
  assert.deepEqual(tracker.outputStarted(), [{ state: "turn-response-started", turnOrdinal: 2 }]);
  assert.deepEqual(tracker.outputSent(), [{ state: "turn-roundtrip-completed", turnOrdinal: 2 }]);
  assert.equal(tracker.completedTurns, 2);
});
