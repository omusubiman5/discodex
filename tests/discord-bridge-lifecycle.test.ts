import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiscordBridgeLifecycle, createLiveCallRuntimeSnapshotProvider, createDiscordBridgeLifecycle } from "../src/adapters/discord/bridge-lifecycle.ts";

test("bridge lifecycle is idempotent, truthful, and clears owned participant state on disconnect", () => {
  let starts = 0; let stops = 0;
  const bridge = new DiscordBridgeLifecycle({ owner: "bridge-owner", onConnect: () => { starts += 1; return "connected"; }, onDisconnect: () => { stops += 1; }, inspect: () => ({ lock: "runner-owned", voiceJoined: true, targetMatched: true }) });
  bridge.connect(); bridge.connect();
  assert.deepEqual(bridge.status(), { state: "connected", owner: "bridge-owner:runner-owned", channel: "configured-target-matched" });
  bridge.observeParticipant("participant", "session-a", 42);
  assert.deepEqual(bridge.participantState(), { connected: true, transition: "initial" });
  bridge.disconnect(); bridge.disconnect();
  assert.equal(starts, 1); assert.equal(stops, 1); assert.equal(bridge.state, "disconnected");
  bridge.connect(); bridge.observeParticipant("participant", "session-b", 84);
  assert.deepEqual(bridge.participantState(), { connected: true, transition: "initial" });
  bridge.observeParticipant("participant", "session-c", 85);
  assert.deepEqual(bridge.participantState(), { connected: true, transition: "rejoin-remap" });
});

test("bridge lifecycle reports degraded and does not operate foreground Codex lifecycle", () => {
  let foregroundCalls = 0;
  const bridge = new DiscordBridgeLifecycle({ owner: "bridge-owner", onConnect: () => { throw new Error("transport unavailable"); }, onDisconnect: () => { foregroundCalls += 1; }, inspect: () => ({ lock: "stale", voiceJoined: false, targetMatched: false }) });
  assert.throws(() => bridge.connect(), /connection failed/);
  assert.equal(bridge.state, "degraded");
  bridge.disconnect();
  assert.equal(foregroundCalls, 1);
});

test("status distinguishes stale/non-runner/join/channel failures without raw identity", () => {
  for (const lock of ["stale", "non-runner"] as const) {
    const bridge = new DiscordBridgeLifecycle({ owner: "safe-owner", onConnect: () => "connected", inspect: () => ({ lock, voiceJoined: true, targetMatched: true }) });
    bridge.connect();
    assert.deepEqual(bridge.status(), { state: "degraded", owner: "safe-owner:runner-unverified", channel: "configured-target-matched" });
  }
  const mismatch = new DiscordBridgeLifecycle({ owner: "safe-owner", onConnect: () => "connected", inspect: () => ({ lock: "runner-owned", voiceJoined: false, targetMatched: false }) });
  mismatch.connect();
  const status = mismatch.status();
  assert.deepEqual(status, { state: "degraded", owner: "safe-owner:runner-owned", channel: "configured-target-mismatch" });
  assert.doesNotMatch(JSON.stringify(status), /pid|command|guild|channel_id|[0-9]{5,}/i);
});

test("status reports an idle configured target without claiming an unverified runner", () => {
  const bridge = new DiscordBridgeLifecycle({ owner: "safe-owner", inspect: () => ({ lock: "absent", voiceJoined: false, targetMatched: false }) });
  assert.deepEqual(bridge.status(), { state: "disconnected", owner: "none", channel: "configured-target-idle" });
});

test("production snapshot provider reads the live-call lock and runner voice state without mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdvb-provider-"));
  const lockPath = join(dir, "live-call.lock");
  writeFileSync(lockPath, String(process.pid));
  const provider = createLiveCallRuntimeSnapshotProvider({ lockPath, voice: () => ({ joined: true, targetMatched: true }) });
  assert.deepEqual(provider(), { lock: "runner-owned", voiceJoined: true, targetMatched: true });
  const lifecycle = createDiscordBridgeLifecycle({ owner: "runner", runtimeSnapshot: provider, onConnect: () => "connected" });
  lifecycle.connect();
  assert.equal(lifecycle.status().state, "connected");
  rmSync(dir, { recursive: true, force: true });
});
