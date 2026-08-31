import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../src/core/config.ts";
import { createProductionDiscordControlRuntime, createCodexCallInputRoute, createPreviousBridgeSessionReset } from "../src/adapters/discord/production-control-runtime.ts";

test("previous-session reset uses the validated runtime voice target instead of environment-only configuration", async () => {
  const previousThreadId = process.env.CODEX_THREAD_ID;
  const previousEndpoint = process.env.CODEX_DESKTOP_DEBUGGER_ENDPOINT;
  process.env.CODEX_THREAD_ID = "00000000-0000-0000-0000-000000000000";
  process.env.CODEX_DESKTOP_DEBUGGER_ENDPOINT = "http://127.0.0.1:52232";
  let leaveTarget: { guildId: string; channelId: string } | undefined;
  let connected = 0; let resolved = 0; let reset = 0; let closed = 0;
  const transportOptions: Array<{ threadId: string; verifyThreadOnConnect?: boolean }> = [];
  try {
    const barrier = createPreviousBridgeSessionReset(
      { guildId: "11111111111111111", voiceChannelId: "22222222222222222" },
      {
        voiceLeave: async (options) => {
          leaveTarget = options.target;
          return { phase: "voice-leave", state: "pass" };
        },
        createTransport: (options) => {
          transportOptions.push(options);
          return {
          async connect() { connected += 1; },
          async resolveForegroundTaskId() { resolved += 1; return "11111111-2222-3333-4444-555555555555"; },
          async resetForegroundRealtimeVoice() { reset += 1; },
          close() { closed += 1; },
          };
        },
      },
    );
    await barrier.reset();
    assert.deepEqual(leaveTarget, { guildId: "11111111111111111", channelId: "22222222222222222" });
    assert.equal(connected, 2);
    assert.equal(resolved, 1);
    assert.equal(reset, 1);
    assert.equal(closed, 2);
    assert.equal(transportOptions[0]?.verifyThreadOnConnect, false);
    assert.equal(transportOptions[1]?.threadId, "11111111-2222-3333-4444-555555555555");
    assert.equal(process.env.CODEX_THREAD_ID, "11111111-2222-3333-4444-555555555555");
  } finally {
    if (previousThreadId === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previousThreadId;
    if (previousEndpoint === undefined) delete process.env.CODEX_DESKTOP_DEBUGGER_ENDPOINT; else process.env.CODEX_DESKTOP_DEBUGGER_ENDPOINT = previousEndpoint;
  }
});

test("route restore makes one deterministic attempt and leaves stale reconciliation to the next preflight", async () => {
  const reports = [
    { graphAttached: true, cableSenders: 1 },
    { applied: true, graphAttached: false, cableSenders: 0 },
  ];
  let calls = 0;
  const route = createCodexCallInputRoute(async (...args) => {
    calls += 1;
    if (args[0] === "--apply-physical-input") return reports.shift() ?? {};
    return reports.shift() ?? {};
  });
  await route.restore();
  assert.equal(calls, 2);

  let failures = 0;
  const bounded = createCodexCallInputRoute(async (...args) => {
    failures += 1;
    return args[0] === "--apply-physical-input" ? { applied: false, graphAttached: true, cableSenders: 1 } : { graphAttached: true, cableSenders: 1 };
  });
  await assert.rejects(() => bounded.restore(), /could not be restored/);
  assert.equal(failures, 2);
});

test("route attach reconciles an orphaned CABLE sender before making a fresh reversible attachment", async () => {
  const calls: string[] = [];
  const reports = [
    { liveAudioSenders: 1, cableSenders: 1, rollbackAvailable: false, graphAttached: false },
    { applied: true, liveAudioSenders: 1, cableSenders: 0, graphAttached: false },
    { liveAudioSenders: 1, cableSenders: 0, currentTrackLabel: "Physical microphone" },
    { applied: true, liveAudioSenders: 1, cableSenders: 1, previousTrackLabel: "Physical microphone" },
    { applied: true, liveAudioSenders: 1, cableSenders: 0, graphAttached: true, graphContextState: "running", graphSourceTrackState: "live", graphDestinationTrackState: "live", graphSenderMatched: true },
  ];
  const route = createCodexCallInputRoute(async (...args) => {
    calls.push(args[0] ?? "inspect");
    return reports.shift() ?? {};
  });
  await route.attach();
  assert.deepEqual(calls, ["inspect", "--reconcile-physical-input", "inspect", "--apply-cable-input", "--apply-cable-graph-input"]);
});

test("route attach reconciles a stale rollback marker after normal restore cannot apply", async () => {
  const calls: string[] = [];
  const reports = [
    { liveAudioSenders: 1, cableSenders: 1, rollbackAvailable: true, graphAttached: true },
    new Error("normal restore rejected stale marker"),
    { liveAudioSenders: 1, cableSenders: 1, rollbackAvailable: true, graphAttached: true },
    { applied: true, liveAudioSenders: 1, cableSenders: 0, graphAttached: false },
    { liveAudioSenders: 1, cableSenders: 0, currentTrackLabel: "Physical microphone" },
    { applied: true, liveAudioSenders: 1, cableSenders: 1, previousTrackLabel: "Physical microphone" },
    { applied: true, liveAudioSenders: 1, cableSenders: 0, graphAttached: true, graphContextState: "running", graphSourceTrackState: "live", graphDestinationTrackState: "live", graphSenderMatched: true },
  ];
  const route = createCodexCallInputRoute(async (...args) => {
    calls.push(args[0] ?? "inspect");
    const report = reports.shift() ?? {};
    if (report instanceof Error) throw report;
    return report;
  });
  await route.attach();
  assert.deepEqual(calls, ["inspect", "--apply-physical-input", "inspect", "--reconcile-physical-input", "inspect", "--apply-cable-input", "--apply-cable-graph-input"]);
});

test("fresh native Voice Talk gets exactly one sender-readiness readback without a connection retry", async () => {
  const calls: string[] = [];
  const reports = [
    { liveAudioSenders: 0, cableSenders: 0 },
    { liveAudioSenders: 1, cableSenders: 0, currentTrackLabel: "physical" },
    { applied: true, liveAudioSenders: 1, cableSenders: 1, previousTrackLabel: "physical" },
    { applied: true, liveAudioSenders: 1, cableSenders: 0, graphAttached: true, graphContextState: "running", graphSourceTrackState: "live", graphDestinationTrackState: "live", graphSenderMatched: true },
  ];
  const route = createCodexCallInputRoute(async (...args) => {
    calls.push(args[0] ?? "inspect");
    return reports.shift()!;
  }, async () => "started");
  await route.attach();
  assert.deepEqual(calls, ["inspect", "inspect", "--apply-cable-input", "--apply-cable-graph-input"]);
});

test("route attach rolls back an unhealthy WebAudio graph before Discord starts", async () => {
  const calls: string[] = [];
  const reports = [
    { liveAudioSenders: 1, cableSenders: 0, currentTrackLabel: "physical" },
    { applied: true, liveAudioSenders: 1, cableSenders: 1, previousTrackLabel: "physical" },
    { applied: true, liveAudioSenders: 1, cableSenders: 0, graphAttached: true, graphContextState: "suspended", graphSourceTrackState: "live", graphDestinationTrackState: "live", graphSenderMatched: true },
    { applied: true, liveAudioSenders: 1, cableSenders: 0, graphAttached: false },
  ];
  const route = createCodexCallInputRoute(async (...args) => {
    calls.push(args[0] ?? "inspect");
    return reports.shift() ?? {};
  });
  await assert.rejects(() => route.attach(), /healthy current Codex audio graph/);
  assert.deepEqual(calls, ["inspect", "--apply-cable-input", "--apply-cable-graph-input", "--apply-physical-input"]);
});

test("route attach accepts the Codex-owned existing destination without inventing an AudioContext state", async () => {
  const calls: string[] = [];
  const reports = [
    { liveAudioSenders: 1, cableSenders: 0, currentTrackLabel: "MediaStreamAudioDestinationNode" },
    { applied: true, liveAudioSenders: 1, cableSenders: 1, previousTrackLabel: "MediaStreamAudioDestinationNode" },
    { applied: true, liveAudioSenders: 1, cableSenders: 0, graphAttached: true, graphMode: "existing-destination", graphContextState: undefined, graphSourceTrackState: "live", graphDestinationTrackState: "live", graphSenderMatched: true },
  ];
  const route = createCodexCallInputRoute(async (...args) => {
    calls.push(args[0] ?? "inspect");
    return reports.shift() ?? {};
  });
  await route.attach();
  assert.deepEqual(calls, ["inspect", "--apply-cable-input", "--apply-cable-graph-input"]);
});

test("production control composition starts one runner, observes join/match, and aborts only bridge-owned runner", async () => {
  const raw = JSON.parse(await readFile(new URL("../config/bridge.example.json", import.meta.url), "utf8"));
  const config = validateConfig(raw).discord;
  const storeDir = mkdtempSync(join(tmpdir(), "cdvb-production-gain-"));
  const lockPath = join(storeDir, "live-call.lock");
  const previousStore = process.env.CODEX_BRIDGE_GAIN_STORE_PATH;
  process.env.CODEX_BRIDGE_GAIN_STORE_PATH = join(storeDir, "gain.json");
  let starts = 0; let aborted = false; let resolveRunner!: () => void; let gainProvider!: () => number;
  const runner = ({ signal, observer, gainProvider: provider }: any) => {
    starts += 1; observer({ state: "voice-state-matched", joined: true, targetMatched: true });
    gainProvider = provider;
    return new Promise<void>((resolve) => { resolveRunner = resolve; signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }); });
  };
  let attaches = 0; let restores = 0; let resets = 0;
  const inputRoute = {
    async attach() { attaches += 1; },
    async restore() { restores += 1; },
  };
  const runtime = createProductionDiscordControlRuntime(config, runner, inputRoute, { lockPath, previousSessionReset: { async reset() { resets += 1; } } });
  const context = { guildId: config.guildId, channelId: config.textChannelId, userId: config.allowedUserIds[0], command: "status" as const };
  const make = (command: any, id: string) => ({ id, command, createdAt: Date.now(), context });
  assert.equal(runtime.controls.handle(make("connect", "connect-1")).ok, true);
  assert.equal(runtime.controls.handle(make("connect", "connect-2")).message, "Already connected.");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attaches, 1);
  assert.equal(resets, 1);
  assert.equal(starts, 1);
  assert.equal(gainProvider(), 0.5);
  const gainResult = runtime.controls.handle({ ...make("gain", "gain-live"), options: { linear: 0.75 } });
  assert.equal(gainResult.ok, true);
  assert.equal(gainProvider(), 0.75);
  assert.equal(runtime.controls.handle({ ...make("gain", "gain-bad"), options: { linear: 1.1 } }).ok, false);
  assert.equal(gainProvider(), 0.75);
  assert.match(runtime.controls.handle(make("status", "status-1")).message, /Status: connected; channel configured-target-matched/);
  assert.equal(runtime.controls.handle(make("disconnect", "disconnect-1")).ok, true);
  resolveRunner?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, true);
  assert.equal(runtime.lifecycle.failureCode(), undefined);
  assert.equal(restores, 2);
  if (previousStore === undefined) delete process.env.CODEX_BRIDGE_GAIN_STORE_PATH; else process.env.CODEX_BRIDGE_GAIN_STORE_PATH = previousStore;
  rmSync(storeDir, { recursive: true, force: true });
});

test("production control restores the original input when attachment fails", async () => {
  const raw = JSON.parse(await readFile(new URL("../config/bridge.example.json", import.meta.url), "utf8"));
  const config = validateConfig(raw).discord;
  const storeDir = mkdtempSync(join(tmpdir(), "cdvb-production-gain-"));
  const lockPath = join(storeDir, "live-call.lock");
  const previousStore = process.env.CODEX_BRIDGE_GAIN_STORE_PATH;
  process.env.CODEX_BRIDGE_GAIN_STORE_PATH = join(storeDir, "gain.json");
  let starts = 0; let restores = 0;
  const runtime = createProductionDiscordControlRuntime(config, async () => { starts += 1; }, {
    async attach() { throw new Error("route rejected"); },
    async restore() { restores += 1; },
  }, { lockPath, previousSessionReset: { async reset() {} } });
  const context = { guildId: config.guildId, channelId: config.textChannelId, userId: config.allowedUserIds[0], command: "connect" as const };
  assert.equal(runtime.controls.handle({ id: "connect-fail", command: "connect", createdAt: Date.now(), context }).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 0);
  assert.equal(restores, 2);
  assert.equal(runtime.lifecycle.status().state, "degraded");
  if (previousStore === undefined) delete process.env.CODEX_BRIDGE_GAIN_STORE_PATH; else process.env.CODEX_BRIDGE_GAIN_STORE_PATH = previousStore;
  rmSync(storeDir, { recursive: true, force: true });
});

test("production control reports an unavailable Codex attachment endpoint without starting a runner", async () => {
  const raw = JSON.parse(await readFile(new URL("../config/bridge.example.json", import.meta.url), "utf8"));
  const config = validateConfig(raw).discord;
  const storeDir = mkdtempSync(join(tmpdir(), "cdvb-production-route-failure-"));
  const lockPath = join(storeDir, "live-call.lock");
  const previousStore = process.env.CODEX_BRIDGE_GAIN_STORE_PATH;
  process.env.CODEX_BRIDGE_GAIN_STORE_PATH = join(storeDir, "gain.json");
  let starts = 0;
  const runtime = createProductionDiscordControlRuntime(config, async () => { starts += 1; }, {
    async attach() { throw new Error("The exact current Codex task route is not configured."); },
    async restore() {},
  }, { lockPath, previousSessionReset: { async reset() {} } });
  const context = { guildId: config.guildId, channelId: config.textChannelId, userId: config.allowedUserIds[0], command: "connect" as const };
  const result = await runtime.controls.handleAsync({ id: "connect-no-debugger", command: "connect", createdAt: Date.now(), context });
  assert.equal(starts, 0);
  assert.equal(result.ok, false);
  assert.equal(result.message, "Connection blocked: current Codex Desktop has no local audio attachment endpoint; no runner was started.");
  if (previousStore === undefined) delete process.env.CODEX_BRIDGE_GAIN_STORE_PATH; else process.env.CODEX_BRIDGE_GAIN_STORE_PATH = previousStore;
  rmSync(storeDir, { recursive: true, force: true });
});

test("production connect fails closed when previous Discord or GPT Live dependencies do not reset", async () => {
  const raw = JSON.parse(await readFile(new URL("../config/bridge.example.json", import.meta.url), "utf8"));
  const config = validateConfig(raw).discord;
  const storeDir = mkdtempSync(join(tmpdir(), "cdvb-production-reset-failure-"));
  const lockPath = join(storeDir, "live-call.lock");
  const previousStore = process.env.CODEX_BRIDGE_GAIN_STORE_PATH;
  process.env.CODEX_BRIDGE_GAIN_STORE_PATH = join(storeDir, "gain.json");
  let starts = 0; let attaches = 0; let restores = 0;
  const runtime = createProductionDiscordControlRuntime(config, async () => { starts += 1; }, {
    async attach() { attaches += 1; },
    async restore() { restores += 1; },
  }, {
    lockPath,
    previousSessionReset: { async reset() { throw new Error("GPT Live still active"); } },
  });
  const context = { guildId: config.guildId, channelId: config.textChannelId, userId: config.allowedUserIds[0], command: "connect" as const };
  const result = await runtime.controls.handleAsync({ id: "connect-reset-fail", command: "connect", createdAt: Date.now(), context });
  assert.equal(result.ok, false);
  assert.equal(result.message, "Connection blocked: the previous Discord/Codex voice session could not be fully disconnected; no new runner was started.");
  assert.equal(starts, 0);
  assert.equal(attaches, 0);
  assert.equal(restores, 2);
  if (previousStore === undefined) delete process.env.CODEX_BRIDGE_GAIN_STORE_PATH; else process.env.CODEX_BRIDGE_GAIN_STORE_PATH = previousStore;
  rmSync(storeDir, { recursive: true, force: true });
});

test("production control reports an unverified Codex task without claiming voice is absent", async () => {
  const raw = JSON.parse(await readFile(new URL("../config/bridge.example.json", import.meta.url), "utf8"));
  const config = validateConfig(raw).discord;
  const storeDir = mkdtempSync(join(tmpdir(), "cdvb-production-task-mismatch-"));
  const lockPath = join(storeDir, "live-call.lock");
  const previousStore = process.env.CODEX_BRIDGE_GAIN_STORE_PATH;
  process.env.CODEX_BRIDGE_GAIN_STORE_PATH = join(storeDir, "gain.json");
  let starts = 0;
  const runtime = createProductionDiscordControlRuntime(config, async () => { starts += 1; }, {
    async attach() { throw new Error("Codex native Voice Talk command failed [task-mismatch]."); },
    async restore() {},
  }, { lockPath, previousSessionReset: { async reset() {} } });
  const context = { guildId: config.guildId, channelId: config.textChannelId, userId: config.allowedUserIds[0], command: "connect" as const };
  const result = await runtime.controls.handleAsync({ id: "connect-task-mismatch", command: "connect", createdAt: Date.now(), context });
  assert.equal(starts, 0);
  assert.equal(result.message, "Connection blocked: Relay could not verify that this is the configured Codex task. Open the configured task and run /connect again; no runner was started.");
  if (previousStore === undefined) delete process.env.CODEX_BRIDGE_GAIN_STORE_PATH; else process.env.CODEX_BRIDGE_GAIN_STORE_PATH = previousStore;
  rmSync(storeDir, { recursive: true, force: true });
});

test("production control tells the user to start Codex voice when no sender exists", async () => {
  const raw = JSON.parse(await readFile(new URL("../config/bridge.example.json", import.meta.url), "utf8"));
  const config = validateConfig(raw).discord;
  const storeDir = mkdtempSync(join(tmpdir(), "cdvb-production-no-sender-"));
  const lockPath = join(storeDir, "live-call.lock");
  const previousStore = process.env.CODEX_BRIDGE_GAIN_STORE_PATH;
  process.env.CODEX_BRIDGE_GAIN_STORE_PATH = join(storeDir, "gain.json");
  let starts = 0;
  const runtime = createProductionDiscordControlRuntime(config, async () => { starts += 1; }, {
    async attach() { throw new Error("The current Codex task has no live audio sender exposed for non-owning attachment."); },
    async restore() {},
  }, { lockPath, previousSessionReset: { async reset() {} } });
  const context = { guildId: config.guildId, channelId: config.textChannelId, userId: config.allowedUserIds[0], command: "connect" as const };
  const result = await runtime.controls.handleAsync({ id: "connect-no-sender", command: "connect", createdAt: Date.now(), context });
  assert.equal(starts, 0);
  assert.equal(result.message, "Connection blocked: start the Codex voice call in this task first; no runner was started.");
  if (previousStore === undefined) delete process.env.CODEX_BRIDGE_GAIN_STORE_PATH; else process.env.CODEX_BRIDGE_GAIN_STORE_PATH = previousStore;
  rmSync(storeDir, { recursive: true, force: true });
});
