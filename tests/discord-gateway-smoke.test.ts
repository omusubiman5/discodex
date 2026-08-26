import assert from "node:assert/strict";
import test from "node:test";
import { buildGatewayResumePayload, buildVoiceResumePayload, decodeServerBinaryVoiceEnvelope, DiscordHeartbeatAckGate, encodeClientBinaryVoiceEnvelope, isConversationInputPcm, isConversationPcm, isDiscordMicrophoneSpeaking, LiveAudioTurnGate, LiveOutputSpeechGate, measurePcmLevel, measurePcmQuality, normalizeConversationPcm, observeSpeakerSsrc, packetizeDiscordPcm, prepareDaveEpoch, prepareDaveReady, resetParticipantMediaState, resolveIncomingSpeaker, runCurrentTaskLiveCall, runGatewayReadySmoke, runUdpDiscoverySmoke, runVoiceLeave, runWithBoundedRecovery, acquireLiveCallProcessLock, resolveLiveCallTimeoutMs, selectMediaRatchetOnce, sendDiscordSpeakingEnd, SingleFlightCodexInputRoute, type GatewaySocket } from "../src/discord-gateway-smoke.ts";
import { EnvironmentCredentialProvider } from "../src/core/credentials.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TEST_CODEX_TASK_ID_1,
  TEST_DISCORD_ID_1,
  TEST_DISCORD_ID_2,
  TEST_DISCORD_ID_3,
  TEST_DISCORD_ID_4,
} from "./fixtures/public-identities.mjs";

class FakeSocket implements GatewaySocket {
  sent: string[] = [];
  closed = false;
  #listeners = new Map<string, Array<(event: { data?: unknown; code?: unknown }) => void>>();

  send(data: string | Uint8Array): void { this.sent.push(typeof data === "string" ? data : Buffer.from(data).toString("hex")); }
  close(): void { this.closed = true; }
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: unknown }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  emit(type: "message" | "close" | "error", data?: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener({ data });
  }
}

test("final live-call process lock rejects overlap before network activity", () => {
  const directory = mkdtempSync(join(tmpdir(), "cdvb-live-lock-"));
  const lockPath = join(directory, "live-call.lock");
  try {
    const release = acquireLiveCallProcessLock(lockPath);
    assert.throws(() => acquireLiveCallProcessLock(lockPath), /already active/);
    release();
    const releaseAgain = acquireLiveCallProcessLock(lockPath);
    releaseAgain();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("final live-call wait defaults to one hour and bounds explicit overrides", () => {
  assert.equal(resolveLiveCallTimeoutMs(undefined), 3_600_000);
  assert.equal(resolveLiveCallTimeoutMs("7200000"), 7_200_000);
  assert.throws(() => resolveLiveCallTimeoutMs("599999"), /600000/);
  assert.throws(() => resolveLiveCallTimeoutMs("not-a-number"), /600000/);
});

test("recoverable transport failure retries once while identity failures fail closed", async () => {
  const attempts: number[] = [];
  const retries: number[] = [];
  const resumed = await runWithBoundedRecovery(async (attempt) => {
    attempts.push(attempt);
    if (attempt === 0) throw new Error("Discord Voice Gateway connection failed.");
    return "resumed";
  }, { maxReconnectAttempts: 1, onRetry: (attempt) => retries.push(attempt) });
  assert.equal(resumed, "resumed");
  assert.deepEqual(attempts, [0, 1]);
  assert.deepEqual(retries, [1]);

  let identityAttempts = 0;
  await assert.rejects(runWithBoundedRecovery(async () => {
    identityAttempts += 1;
    throw new Error("Existing Codex realtime attachment preflight failed: identity-or-voice-state.");
  }, { maxReconnectAttempts: 1 }), /identity-or-voice-state/);
  assert.equal(identityAttempts, 1);

  let resumeAttempts = 0;
  await assert.rejects(runWithBoundedRecovery(async () => {
    resumeAttempts += 1;
    throw new Error("Discord Voice Gateway resume failed closed (code 1006).");
  }), /resume failed closed/);
  assert.equal(resumeAttempts, 1);

  let exhaustedAttempts = 0;
  await assert.rejects(runWithBoundedRecovery(async () => {
    exhaustedAttempts += 1;
    throw new Error("Discord Gateway connection failed.");
  }, { maxReconnectAttempts: 1 }), /Discord Gateway connection failed/);
  assert.equal(exhaustedAttempts, 2);
  await assert.rejects(runWithBoundedRecovery(async () => "never", { maxReconnectAttempts: 2 }), /0 or 1/);
});

test("Voice Resume op7 preserves the exact session and last received sequence", () => {
  const payload = buildVoiceResumePayload({
    guildId: TEST_DISCORD_ID_1, channelId: TEST_DISCORD_ID_2, userId: TEST_DISCORD_ID_3,
    sessionId: "voice-session", token: "voice-token", endpoint: "voice.example.invalid",
  }, 73);
  assert.deepEqual(payload, { op: 7, d: {
    server_id: TEST_DISCORD_ID_1, session_id: "voice-session", token: "voice-token", seq_ack: 73,
  } });
  assert.throws(() => buildVoiceResumePayload({} as never, -1), /seq_ack/);
});

test("main Gateway Resume op6 preserves token, session, and sequence", () => {
  assert.deepEqual(buildGatewayResumePayload("token", "session", 73), {
    op: 6, d: { token: "token", session_id: "session", seq: 73 },
  });
  assert.throws(() => buildGatewayResumePayload("token", "session", -1), /Resume state/);
});

test("Voice heartbeat requires the matching Opcode 6 ACK before the next send", () => {
  const gate = new DiscordHeartbeatAckGate();
  assert.equal(gate.begin(100), true);
  assert.equal(gate.begin(101), false);
  assert.equal(gate.acknowledge(99), false);
  assert.equal(gate.acknowledge(100), true);
  assert.equal(gate.begin(101), true);
  gate.reset();
  assert.equal(gate.waiting, false);
});

test("DAVE Prepare Epoch keeps the MLS group for epoch greater than one", () => {
  const calls: string[] = [];
  const session = {
    maxProtocolVersion: 1,
    configure: () => { calls.push("configure"); },
    setProtocolVersion: (version: number) => { calls.push(`version:${version}`); },
    setExternalSender: () => { calls.push("external"); },
    createKeyPackage: () => { calls.push("key-package"); return Uint8Array.from([1]); },
  };
  assert.deepEqual(prepareDaveEpoch(session, { epoch: "1", protocolVersion: 1 }, "group", "self", Uint8Array.from([2])), Uint8Array.from([1]));
  assert.deepEqual(calls, ["configure", "version:1", "external", "key-package"]);
  calls.length = 0;
  assert.equal(prepareDaveEpoch(session, { epoch: "2", protocolVersion: 1 }, "group", "self", Uint8Array.from([2])), null);
  assert.deepEqual(calls, ["version:1"]);
});

test("live output evidence distinguishes silence before Opus/DAVE send", () => {
  assert.deepEqual(measurePcmLevel(new Int16Array(1_920)), {
    pcmSamples: 1_920, rms: 0, peak: 0, nonSilentSamples: 0,
  });
  assert.deepEqual(measurePcmLevel(Int16Array.from([0, 8, 9, -10])), {
    pcmSamples: 4, rms: 8, peak: 10, nonSilentSamples: 2,
  });
  assert.equal(isConversationPcm({ pcmSamples: 1_920, rms: 29, peak: 195, nonSilentSamples: 1_000 }), false);
  assert.equal(isConversationPcm({ pcmSamples: 1_920, rms: 113, peak: 564, nonSilentSamples: 1_000 }), true);
  assert.equal(isConversationInputPcm({ pcmSamples: 1_920, rms: 313, peak: 602, nonSilentSamples: 1_000 }), false);
  assert.equal(isConversationInputPcm({ pcmSamples: 1_920, rms: 369, peak: 1_589, nonSilentSamples: 1_000 }), true);
  assert.equal(isDiscordMicrophoneSpeaking(0), false);
  assert.equal(isDiscordMicrophoneSpeaking(1), true);
  assert.equal(isDiscordMicrophoneSpeaking(2), false);
  assert.equal(isDiscordMicrophoneSpeaking(5), true);
  assert.deepEqual(measurePcmQuality(Int16Array.from([-100, 100, -32_768, 32_767])), {
    dcOffset: 0, clippedSamples: 2, zeroCrossingPermille: 1_000, differenceRms: 42_329,
  });
  assert.deepEqual([...normalizeConversationPcm(Int16Array.from([-500, 500]))], [-8_000, 8_000]);
  assert.deepEqual([...normalizeConversationPcm(Int16Array.from([-184, 184]))], [-8_000, 8_000]);
  assert.deepEqual([...normalizeConversationPcm(Int16Array.from([-20_000, 20_000]))], [-20_000, 20_000]);
});

test("live output preserves continuous PCM across arbitrary host chunks", () => {
  const first = packetizeDiscordPcm(new Int16Array(), Int16Array.from({ length: 1_000 }, (_, index) => index));
  assert.equal(first.packets.length, 0);
  assert.equal(first.remainder.length, 1_000);
  const second = packetizeDiscordPcm(first.remainder, Int16Array.from({ length: 2_000 }, (_, index) => index + 1_000));
  assert.equal(second.packets.length, 1);
  assert.equal(second.packets[0]?.length, 1_920);
  assert.equal(second.packets[0]?.[0], 0);
  assert.equal(second.packets[0]?.[1_919], 1_919);
  assert.equal(second.remainder.length, 1_080);
  assert.equal(second.remainder[0], 1_920);
});

test("live turn gate flushes stale output and binds one response to one input sequence", () => {
  const gate = new LiveAudioTurnGate();
  assert.deepEqual(gate.observeOutput(true), { accept: false, responseStarted: false, responseEnded: false });
  assert.deepEqual(gate.inputStarted(), { started: true, resumed: false, sequence: 1 });
  assert.deepEqual(gate.inputStarted(), { started: false, resumed: false, sequence: 1 });
  gate.inputEnded();
  assert.deepEqual(gate.observeOutput(true), { accept: false, responseStarted: false, responseEnded: false });
  assert.deepEqual(gate.observeOutput(false), { accept: false, responseStarted: false, responseEnded: false });
  assert.deepEqual(gate.inputStarted(), { started: false, resumed: true, sequence: 1 });
  gate.inputEnded();
  assert.deepEqual(gate.observeOutput(false), { accept: false, responseStarted: false, responseEnded: false });
  assert.deepEqual(gate.observeOutput(true), { accept: false, responseStarted: false, responseEnded: false });
  assert.deepEqual(gate.confirmInput(), { confirmed: true, sequence: 1 });
  assert.deepEqual(gate.observeOutput(false), { accept: false, responseStarted: false, responseEnded: false });
  assert.deepEqual(gate.observeOutput(true), { accept: true, sequence: 1, responseStarted: true, responseEnded: false });
  assert.deepEqual(gate.observeOutput(true), { accept: true, sequence: 1, responseStarted: false, responseEnded: false });
  assert.deepEqual(gate.observeOutput(false), { accept: false, responseStarted: false, responseEnded: false });
  assert.deepEqual(gate.observeOutput(true), { accept: true, sequence: 1, responseStarted: false, responseEnded: false });
  assert.deepEqual(gate.observeOutput(true), { accept: true, sequence: 1, responseStarted: false, responseEnded: false });
  assert.deepEqual(gate.inputStarted(), { started: true, resumed: false, sequence: 2 });
});

test("a fresh Discord Speaking cycle cannot be absorbed by an unanswered confirmed turn", () => {
  const gate = new LiveAudioTurnGate();
  assert.deepEqual(gate.inputStarted(true), { started: true, resumed: false, sequence: 1 });
  gate.inputEnded();
  assert.deepEqual(gate.confirmInput(1), { confirmed: true, sequence: 1 });
  assert.deepEqual(gate.inputStarted(), { started: false, resumed: true, sequence: 1 });
  gate.inputEnded();
  assert.deepEqual(gate.inputStarted(true), { started: true, resumed: false, sequence: 2 });
});

test("live output forwards scoped Codex speech without waiting for a conversation turn", () => {
  const gate = new LiveOutputSpeechGate();
  assert.deepEqual(gate.observe(true), { accept: true, started: true, ended: false });
  for (let index = 0; index < 10; index += 1) {
    assert.deepEqual(gate.observe(false), { accept: false, started: false, ended: false });
  }
  assert.deepEqual(gate.observe(true), { accept: true, started: false, ended: false });
  for (let index = 0; index < 24; index += 1) {
    assert.deepEqual(gate.observe(false), { accept: false, started: false, ended: false });
  }
  assert.deepEqual(gate.observe(false), { accept: false, started: false, ended: true });
});

test("Discord speaking end sends five encrypted silence packets before Speaking 0", async () => {
  const events: string[] = [];
  await sendDiscordSpeakingEnd(
    { encode: (opus) => { assert.deepEqual([...opus], [0xf8, 0xff, 0xfe]); return Uint8Array.from([0xda, ...opus]); } },
    { send: async (packet) => { events.push(`packet:${Buffer.from(packet).toString("hex")}`); } },
    { send: (payload) => { events.push(`voice:${payload}`); } },
    42,
    async () => {},
  );
  assert.deepEqual(events.slice(0, 5), Array(5).fill("packet:daf8fffe"));
  assert.deepEqual(JSON.parse(events[5]!.slice(6)), { op: 5, d: { speaking: 0, delay: 0, ssrc: 42 } });
});

test("DAVE ratchet selection is idempotent and participant rejoin resets only its SSRC", () => {
  const speakers = new Map<number, string>([[84, "participant"], [42, "self"]]);
  const selected = new Map<number, string>();
  const calls: string[] = [];
  const select = (userId: string, ssrc: number) => calls.push(`${userId}:${ssrc}`);
  assert.equal(selectMediaRatchetOnce(selected, select, "self", 42), true);
  assert.equal(selectMediaRatchetOnce(selected, select, "self", 42), false);
  assert.deepEqual(calls, ["self:42"]);
  assert.equal(selectMediaRatchetOnce(selected, select, "participant", 84), true);
  resetParticipantMediaState(speakers, selected, "participant");
  assert.equal(speakers.has(84), false);
  assert.equal(selected.has(84), false);
  assert.equal(selected.get(42), "self");
  speakers.set(126, "participant");
  assert.equal(selectMediaRatchetOnce(selected, select, "participant", 126), true);
  assert.deepEqual(calls, ["self:42", "participant:84", "participant:126"]);
});

test("missing Speaking Opcode 5 infers a changed SSRC only for one recognized external participant", () => {
  const speakers = new Map<number, string>([[42, "self"], [84, "participant"]]);
  const ratchets = new Map<number, string>([[42, "self"], [84, "participant"]]);
  const recognized = new Set(["self", "participant"]);
  assert.equal(resolveIncomingSpeaker(speakers, ratchets, recognized, "self", 42, 126, true), undefined);
  resetParticipantMediaState(speakers, ratchets, "participant");
  assert.deepEqual(resolveIncomingSpeaker(speakers, ratchets, recognized, "self", 42, 126, true), {
    userId: "participant", inferred: true,
  });
  assert.equal(speakers.has(84), false);
  assert.equal(ratchets.has(84), false);
  assert.equal(speakers.get(126), "participant");
  assert.deepEqual(resolveIncomingSpeaker(speakers, ratchets, recognized, "self", 42, 126, true), {
    userId: "participant", inferred: false,
  });
  assert.equal(resolveIncomingSpeaker(speakers, ratchets, recognized, "self", 42, 42, true), undefined);
  assert.deepEqual(resolveIncomingSpeaker(speakers, ratchets, recognized, "self", 42, 42, false), {
    userId: "self", inferred: false,
  });
  assert.equal(resolveIncomingSpeaker(new Map(), new Map(), new Set(["self", "one", "two"]), "self", 42, 126, true), undefined);
});

test("speaker SSRC lifecycle marks a remap without exposing SSRC values", () => {
  const lastSsrcByUser = new Map<string, number>();

  assert.equal(observeSpeakerSsrc(lastSsrcByUser, "participant", 84), "speaker-ssrc-mapped");
  assert.equal(observeSpeakerSsrc(lastSsrcByUser, "participant", 84), "speaker-ssrc-mapped");
  assert.equal(observeSpeakerSsrc(lastSsrcByUser, "participant", 126), "speaker-ssrc-remapped");
});

test("exact-task input append failure is sanitized and concurrent append is rejected", async () => {
  const route = new SingleFlightCodexInputRoute();
  const stages: string[] = [];
  const failures: unknown[] = [];
  let releaseAppend!: () => void;
  let activeAppends = 0;
  let maxActiveAppends = 0;
  const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve; });
  const brain = {
    state: "active" as const,
    async appendInput() {
      activeAppends += 1;
      maxActiveAppends = Math.max(maxActiveAppends, activeAppends);
      await appendGate;
      activeAppends -= 1;
      throw new Error("sensitive transport detail");
    },
  };
  const first = route.append(brain, { samples: new Int16Array(1_920), sampleRate: 48_000, channels: 2 }, (stage) => stages.push(stage), (failure) => failures.push(failure));
  assert.equal(route.inFlight, true);
  assert.equal(await route.append(brain, { samples: new Int16Array(1_920), sampleRate: 48_000, channels: 2 }), false);
  releaseAppend();
  await assert.rejects(first, (error: Error) => {
    assert.equal(error.message, "Current Codex realtime input append failed [unknown].");
    assert.equal(error.message.includes("sensitive"), false);
    return true;
  });
  assert.equal(maxActiveAppends, 1);
  assert.equal(route.inFlight, false);
  assert.deepEqual(stages, ["codex-input-failed"]);
  assert.deepEqual(failures, [{
    method: "thread/realtime/appendAudio",
    code: "unknown",
    message: "Current Codex realtime input append failed.",
    correlation: "append-1",
  }]);
});

test("product live-call rejects paths without an exact-session audio route before network activity", async () => {
  let acquired = false;
  await assert.rejects(runUdpDiscoverySmoke({
    liveCallWait: true,
    audioRoundTripProbe: true,
    credentialProvider: {
      storage: "development-environment",
      async acquire() { acquired = true; throw new Error("must not acquire"); },
    },
  }), /exact-session audio route/);
  assert.equal(acquired, false);
});

test("explicit product stop tears down before credential or network activity", async () => {
  const controller = new AbortController();
  controller.abort();
  let acquired = false;
  const transport = {
    async request() { return {}; },
    subscribe() { return () => {}; },
  };
  await assert.rejects(runCurrentTaskLiveCall({
    threadId: TEST_CODEX_TASK_ID_1,
    appServerTransport: transport,
    signal: controller.signal,
    credentialProvider: { storage: "development-environment", async acquire() { acquired = true; throw new Error("must not acquire"); } },
  }), /stopped explicitly before start/);
  assert.equal(acquired, false);
});

test("current-task product runner uses a non-owning direct-audio attachment", () => {
  const source = runCurrentTaskLiveCall.toString();
  assert.match(source, /MeetronDirectAudioBridge/);
  assert.match(source, /meetronDirectAudio: directAudio/);
  assert.doesNotMatch(source, /brain\.start|brain\.stop|brain\.reconnect|CodexRealtimeVoiceBrain/);
  assert.doesNotMatch(source, /transport\.request\("thread\/read"/);
  assert.match(source, /thread\/realtime\/transcript\/done/);
});

test("Gateway Ready smoke identifies through a credential lease and reports no identifiers", async () => {
  const previous = process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
  process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = "test-token";
  const socket = new FakeSocket();
  try {
    const result = runGatewayReadySmoke({
      timeoutMs: 1_000,
      socketFactory: () => socket,
      credentialProvider: new EnvironmentCredentialProvider(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    assert.equal(JSON.parse(socket.sent[0]!).op, 2);
    socket.emit("message", JSON.stringify({ op: 0, t: "READY", d: { user: { id: "bot-id" } } }));
    assert.deepEqual(await result, { phase: "gateway-ready", state: "pass" });
    assert.equal(socket.closed, true);
  } finally {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
    else process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = previous;
  }
});

test("binary Voice framing separates sequence/opcode without exposing payload", () => {
  const decoded = decodeServerBinaryVoiceEnvelope(Uint8Array.from([0x12, 0x34, 25, 7, 8, 9]));
  assert.deepEqual(decoded, { sequence: 0x1234, op: 25, payload: Uint8Array.from([7, 8, 9]) });
  assert.deepEqual(encodeClientBinaryVoiceEnvelope(26, Uint8Array.from([4, 5])), Uint8Array.from([26, 4, 5]));
  assert.throws(() => decodeServerBinaryVoiceEnvelope(Uint8Array.from([0, 1, 99])), /unsupported/);
});

test("voice leave explicitly clears a stale Discord voice state", async () => {
  const previous = process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
  process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = "test-token";
  const socket = new FakeSocket();
  try {
    const result = runVoiceLeave({
      timeoutMs: 1_000,
      settleMs: 0,
      target: { guildId: TEST_DISCORD_ID_1, channelId: TEST_DISCORD_ID_2 },
      socketFactory: () => socket,
      credentialProvider: new EnvironmentCredentialProvider(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    socket.emit("message", JSON.stringify({ op: 0, t: "READY", d: { user: { id: "bot-id" } } }));
    assert.deepEqual(await result, { phase: "voice-leave", state: "pass" });
    const leave = JSON.parse(socket.sent.at(-1)!);
    assert.deepEqual(leave, { op: 4, d: { guild_id: TEST_DISCORD_ID_1, channel_id: null, self_mute: false, self_deaf: false } });
  } finally {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
    else process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = previous;
  }
});

test("DAVE ready preflight keeps a native session alive without credential or network access", () => {
  let nativeOpen = false;
  let acquired = false;
  const handle = prepareDaveReady({
    target: { guildId: TEST_DISCORD_ID_1, channelId: TEST_DISCORD_ID_2 },
    credentialProvider: { storage: "windows-dpapi-current-user", async acquire() { acquired = true; throw new Error("must not acquire"); } },
    addonPath: "work/probe.node",
    addonLoader: () => ({
      maxProtocolVersion: 1,
      sessionOpen: () => { nativeOpen = true; return true; },
      sessionClose: () => { nativeOpen = false; return true; },
      sessionIsOpen: () => nativeOpen,
    }),
  });
  assert.deepEqual(handle.report, {
    phase: "dave-ready",
    state: "ready-to-join",
    nativeSession: "initialized",
    externalConnectionOpened: false,
    credentialAcquired: false,
  });
  assert.equal(handle.isOpen(), true);
  assert.equal(acquired, false);
  handle.close();
  assert.equal(handle.isOpen(), false);
});

test("macOS DAVE preparation accepts only the Keychain production boundary", () => {
  let nativeOpen = false;
  const handle = prepareDaveReady({
    target: { guildId: TEST_DISCORD_ID_1, channelId: TEST_DISCORD_ID_2 },
    credentialProvider: { storage: "macos-keychain", async acquire() { throw new Error("must not acquire"); } },
    addonPath: "/synthetic/libdave_node_probe.node",
    addonLoader: () => ({
      maxProtocolVersion: 1,
      sessionOpen: () => { nativeOpen = true; return true; },
      sessionClose: () => { nativeOpen = false; return true; },
      sessionIsOpen: () => nativeOpen,
    }),
  });
  assert.equal(handle.isOpen(), true);
  handle.close();
  assert.equal(handle.isOpen(), false);
  assert.throws(() => prepareDaveReady({
    target: { guildId: TEST_DISCORD_ID_1, channelId: TEST_DISCORD_ID_2 },
    credentialProvider: new EnvironmentCredentialProvider(),
    addonLoader: () => { throw new Error("must not load"); },
  }), /production OS-secret provider/);
});

test("Gateway Ready smoke fails before network activity when the token is absent", async () => {
  const previous = process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
  delete process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
  let opened = false;
  try {
    await assert.rejects(
      runGatewayReadySmoke({
        socketFactory: () => { opened = true; return new FakeSocket(); },
        credentialProvider: new EnvironmentCredentialProvider(),
      }),
      /CODEX_BRIDGE_DISCORD_BOT_TOKEN is not set/,
    );
    assert.equal(opened, false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
    else process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = previous;
  }
});

test("UDP discovery smoke correlates voice handoff and reports no identifiers", async () => {
  const previous = process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
  process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = "test-token";
  const main = new FakeSocket();
  const voice = new FakeSocket();
  const urls: string[] = [];
  let udpObserved = false;
  const liveStages: string[] = [];
  try {
    const result = runUdpDiscoverySmoke({
      timeoutMs: 1_000,
      target: { guildId: TEST_DISCORD_ID_1, channelId: TEST_DISCORD_ID_2 },
      credentialProvider: new EnvironmentCredentialProvider(),
      liveCallWait: true,
      onLiveStage: (stage) => liveStages.push(stage),
      socketFactory: (url) => { urls.push(url); return urls.length === 1 ? main : voice; },
      udpDiscovery: async (ip, port, ssrc) => {
        assert.equal(ip, "203.0.113.10");
        assert.equal(port, 50_000);
        assert.equal(ssrc, 42);
        udpObserved = true;
        return { address: "198.51.100.7", port: 50_001 };
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    main.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    main.emit("message", JSON.stringify({ op: 0, t: "READY", s: 1, d: { user: { id: TEST_DISCORD_ID_3 }, session_id: "gateway-session", resume_gateway_url: "wss://gateway-resume.example.invalid" } }));
    assert.equal(JSON.parse(main.sent.at(-1)!).op, 4);
    main.emit("message", JSON.stringify({ op: 0, t: "VOICE_SERVER_UPDATE", s: 2, d: { guild_id: TEST_DISCORD_ID_1, endpoint: "voice.example.invalid", token: "voice-token" } }));
    main.emit("message", JSON.stringify({ op: 0, t: "VOICE_STATE_UPDATE", s: 3, d: { guild_id: TEST_DISCORD_ID_1, channel_id: TEST_DISCORD_ID_2, user_id: TEST_DISCORD_ID_3, session_id: "voice-session" } }));
    assert.equal(urls[1], "wss://voice.example.invalid/?v=8");
    voice.emit("message", JSON.stringify({ op: 8, d: { heartbeat_interval: 45_000 } }));
    assert.equal(JSON.parse(voice.sent[0]!).op, 0);
    voice.emit("message", JSON.stringify({ op: 2, d: { ip: "203.0.113.10", port: 50_000, ssrc: 42, modes: ["aead_xchacha20_poly1305_rtpsize"] } }));
    assert.deepEqual(await result, { phase: "udp-discovery", state: "pass" });
    assert.equal(udpObserved, true);
    assert.deepEqual(liveStages, ["discord-voice-state-matched", "discord-voice-joined", "udp-discovered"]);
    assert.equal(main.closed, true);
    assert.equal(voice.closed, true);
  } finally {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
    else process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = previous;
  }
});

test("UDP discovery resumes the official main Gateway session once before voice handoff", async () => {
  const previous = process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
  process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = "test-token";
  const main = new FakeSocket();
  const resumedMain = new FakeSocket();
  const voice = new FakeSocket();
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  try {
    const result = runUdpDiscoverySmoke({
      timeoutMs: 1_000,
      target: { guildId: TEST_DISCORD_ID_1, channelId: TEST_DISCORD_ID_2 },
      credentialProvider: new EnvironmentCredentialProvider(),
      socketFactory: (url) => {
        urls.push(url);
        const socket = [main, resumedMain, voice][sockets.length]!;
        sockets.push(socket);
        return socket;
      },
      udpDiscovery: async () => ({ address: "198.51.100.7", port: 50_001 }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    main.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    main.emit("message", JSON.stringify({ op: 0, t: "READY", s: 7, d: { user: { id: TEST_DISCORD_ID_3 }, session_id: "gateway-session", resume_gateway_url: "wss://gateway-resume.example.invalid" } }));
    main.emit("close");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(urls[1], "wss://gateway-resume.example.invalid/?v=10&encoding=json");
    resumedMain.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    assert.deepEqual(JSON.parse(resumedMain.sent[0]!), {
      op: 6, d: { token: "test-token", session_id: "gateway-session", seq: 7 },
    });
    resumedMain.emit("message", JSON.stringify({ op: 0, t: "RESUMED", s: 8, d: {} }));
    resumedMain.emit("message", JSON.stringify({ op: 0, t: "VOICE_SERVER_UPDATE", s: 9, d: { guild_id: TEST_DISCORD_ID_1, endpoint: "voice.example.invalid", token: "voice-token" } }));
    resumedMain.emit("message", JSON.stringify({ op: 0, t: "VOICE_STATE_UPDATE", s: 10, d: { guild_id: TEST_DISCORD_ID_1, channel_id: TEST_DISCORD_ID_2, user_id: TEST_DISCORD_ID_3, session_id: "voice-session" } }));
    voice.emit("message", JSON.stringify({ op: 8, d: { heartbeat_interval: 45_000 } }));
    voice.emit("message", JSON.stringify({ op: 2, d: { ip: "203.0.113.10", port: 50_000, ssrc: 42, modes: ["aead_xchacha20_poly1305_rtpsize"] } }));
    assert.deepEqual(await result, { phase: "udp-discovery", state: "pass" });
    assert.equal(sockets.length, 3);
  } finally {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
    else process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = previous;
  }
});

test("live DAVE routes Opcode25 before Opcode24 initialization and emits binary Opcode26 key package", async () => {
  const previous = process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
  process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = "test-token";
  const main = new FakeSocket();
  const voice = new FakeSocket();
  let sockets = 0;
  let negotiated: { daveProtocolVersion: number; transportMode: string } | undefined;
  const nativeCalls: string[] = [];
  let nativeOpen = false;
  try {
    const result = runUdpDiscoverySmoke({
      timeoutMs: 1_000,
      target: { guildId: TEST_DISCORD_ID_1, channelId: TEST_DISCORD_ID_2 },
      credentialProvider: new EnvironmentCredentialProvider(),
      socketFactory: () => ++sockets === 1 ? main : voice,
      udpDiscovery: async () => ({ address: "198.51.100.7", port: 50_001 }),
      sessionDescriptionProbe: true,
      onSessionDescription: (evidence) => { negotiated = evidence; },
      addonPath: "work/probe.node",
      addonLoader: () => ({
        maxProtocolVersion: 1,
        sessionOpen: () => { nativeOpen = true; nativeCalls.push("open"); return true; },
        sessionClose: () => { nativeOpen = false; nativeCalls.push("close"); return true; },
        sessionIsOpen: () => nativeOpen,
        sessionSetProtocolVersion: (version: number) => { nativeCalls.push(`version:${version}`); return true; },
        sessionSetExternalSender: (payload: Uint8Array) => { nativeCalls.push(`external:${Buffer.from(payload).toString("hex")}`); return true; },
        sessionConfigure: (groupId: string, userId: string) => { nativeCalls.push(`configure:${groupId}:${userId}`); return true; },
        sessionKeyPackage: () => { nativeCalls.push("key-package"); return Uint8Array.from([0xaa, 0xbb]); },
        sessionProcessProposals: (payload: Uint8Array, ids: string[]) => { nativeCalls.push(`proposals:${Buffer.from(payload).toString("hex")}:${ids.length}`); return Uint8Array.from([0xcc]); },
        sessionProcessCommit: (payload: Uint8Array) => { nativeCalls.push(`commit:${Buffer.from(payload).toString("hex")}`); return "accepted"; },
        sessionProcessWelcome: (payload: Uint8Array, ids: string[]) => { nativeCalls.push(`welcome:${Buffer.from(payload).toString("hex")}:${ids.length}`); return false; },
        sessionReset: () => { nativeCalls.push("reset"); return true; },
      }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    main.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    main.emit("message", JSON.stringify({ op: 0, t: "READY", s: 1, d: { user: { id: TEST_DISCORD_ID_3 }, session_id: "gateway-session", resume_gateway_url: "wss://gateway-resume.example.invalid" } }));
    main.emit("message", JSON.stringify({ op: 0, t: "VOICE_SERVER_UPDATE", s: 2, d: { guild_id: TEST_DISCORD_ID_1, endpoint: "voice.example.invalid", token: "voice-token" } }));
    main.emit("message", JSON.stringify({ op: 0, t: "VOICE_STATE_UPDATE", s: 3, d: { guild_id: TEST_DISCORD_ID_1, channel_id: TEST_DISCORD_ID_2, user_id: TEST_DISCORD_ID_3, session_id: "voice-session" } }));
    main.emit("message", JSON.stringify({ op: 0, t: "VOICE_STATE_UPDATE", s: 4, d: { guild_id: TEST_DISCORD_ID_1, channel_id: TEST_DISCORD_ID_2, user_id: TEST_DISCORD_ID_3, session_id: "voice-session" } }));
    voice.emit("message", JSON.stringify({ op: 8, d: { heartbeat_interval: 45_000 } }));
    voice.emit("message", JSON.stringify({ op: 2, d: { ip: "203.0.113.10", port: 50_000, ssrc: 42, modes: ["aead_xchacha20_poly1305_rtpsize"] } }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(JSON.parse(voice.sent.at(-1)!).op, 1);
    voice.emit("message", JSON.stringify({ op: 4, d: { mode: "aead_xchacha20_poly1305_rtpsize", secret_key: Array(32).fill(7), dave_protocol_version: 1 } }));
    voice.emit("message", Uint8Array.from([0x12, 0x34, 25, 0xde, 0xad]));
    assert.equal(nativeCalls.at(-1), "external:dead");
    voice.emit("message", JSON.stringify({ op: 24, d: { epoch: "1", protocol_version: 1 } }));
    assert.equal(voice.sent.at(-1), "1aaabb");
    assert.deepEqual(nativeCalls, [
      "open",
      `configure:${TEST_DISCORD_ID_2}:${TEST_DISCORD_ID_3}`,
      "version:1",
      "key-package",
      "external:dead",
      `configure:${TEST_DISCORD_ID_2}:${TEST_DISCORD_ID_3}`,
      "version:1",
      "external:dead",
      "key-package",
    ]);
    assert.deepEqual(negotiated, { daveProtocolVersion: 1, transportMode: "aead_xchacha20_poly1305_rtpsize" });
    voice.emit("message", JSON.stringify({ op: 11, d: { user_ids: [TEST_DISCORD_ID_4] } }));
    voice.emit("message", Uint8Array.from([0, 2, 27, 0xdd]));
    assert.equal(voice.sent.at(-1), "1ccc");
    voice.emit("message", Uint8Array.from([0, 3, 30, 0, 42, 0xee]));
    assert.deepEqual(JSON.parse(voice.sent.at(-2)!), { op: 31, d: { transition_id: 42 } });
    assert.equal(voice.sent.at(-1), "1aaabb");
    voice.emit("message", Uint8Array.from([0, 4, 29, 0, 43, 0xff]));
    assert.deepEqual(JSON.parse(voice.sent.at(-1)!), { op: 23, d: { transition_id: 43 } });
    voice.emit("message", JSON.stringify({ op: 22, d: { transition_id: 43 } }));
    assert.deepEqual(await result, { phase: "udp-discovery", state: "pass" });
    assert.deepEqual(nativeCalls.slice(9, -1), [
      "proposals:dd:2",
      "welcome:ee:2",
      "reset",
      `configure:${TEST_DISCORD_ID_2}:${TEST_DISCORD_ID_3}`,
      "version:1",
      "external:dead",
      "key-package",
      "commit:ff",
    ]);
    assert.equal(nativeCalls.at(-1), "close");
  } finally {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
    else process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = previous;
  }
});

test("live receive injects authenticated RTP through the UDP boundary before DAVE decrypt", async () => {
  const previous = process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
  process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = "test-token";
  const main = new FakeSocket();
  const voice = new FakeSocket();
  let sockets = 0;
  let frameListener: ((packet: Uint8Array) => void) | undefined;
  let received: { opusBytes: number } | undefined;
  const nativeCalls: string[] = [];
  let nativeOpen = false;
  try {
    const result = runUdpDiscoverySmoke({
      timeoutMs: 1_000,
      target: { guildId: TEST_DISCORD_ID_1, channelId: TEST_DISCORD_ID_2 },
      credentialProvider: new EnvironmentCredentialProvider(),
      socketFactory: () => ++sockets === 1 ? main : voice,
      udpDiscovery: async () => ({
        address: "198.51.100.7", port: 50_001,
        media: {
          async send() {},
          async inject(packet) { frameListener?.(packet); },
          onFrame(listener) { frameListener = listener; },
          close() {},
        },
      }),
      sessionDescriptionProbe: true,
      receiveOpusProbe: true,
      onOpusReceived: (evidence) => { received = evidence; },
      addonPath: "work/probe.node",
      addonLoader: () => ({
        maxProtocolVersion: 1,
        sessionOpen: () => { nativeOpen = true; return true; },
        sessionClose: () => { nativeOpen = false; nativeCalls.push("close"); return true; },
        sessionIsOpen: () => nativeOpen,
        sessionConfigure: () => true,
        sessionSetProtocolVersion: () => true,
        sessionSetExternalSender: () => true,
        sessionKeyPackage: () => Uint8Array.from([0xaa]),
        sessionProcessProposals: () => null,
        sessionProcessCommit: () => "accepted",
        sessionProcessWelcome: () => true,
        sessionReset: () => true,
        sessionSelectMediaRatchet: (userId: string, ssrc: number) => { nativeCalls.push(`ratchet:${userId}:${ssrc}`); return true; },
        sessionEncryptOpus: (_ssrc: number, frame: Uint8Array) => Uint8Array.from([0xda, ...frame]),
        sessionDecryptOpus: (ssrc: number, frame: Uint8Array) => { nativeCalls.push(`dave-decrypt:${ssrc}`); return frame.slice(1); },
      }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    main.emit("message", JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    main.emit("message", JSON.stringify({ op: 0, t: "READY", s: 1, d: { user: { id: TEST_DISCORD_ID_3 }, session_id: "gateway-session", resume_gateway_url: "wss://gateway-resume.example.invalid" } }));
    main.emit("message", JSON.stringify({ op: 0, t: "VOICE_SERVER_UPDATE", s: 2, d: { guild_id: TEST_DISCORD_ID_1, endpoint: "voice.example.invalid", token: "voice-token" } }));
    main.emit("message", JSON.stringify({ op: 0, t: "VOICE_STATE_UPDATE", s: 3, d: { guild_id: TEST_DISCORD_ID_1, channel_id: TEST_DISCORD_ID_2, user_id: TEST_DISCORD_ID_3, session_id: "voice-session" } }));
    voice.emit("message", JSON.stringify({ op: 8, d: { heartbeat_interval: 45_000 } }));
    voice.emit("message", JSON.stringify({ op: 2, d: { ip: "203.0.113.10", port: 50_000, ssrc: 42, modes: ["aead_aes256_gcm_rtpsize"] } }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    voice.emit("message", JSON.stringify({ op: 4, d: { mode: "aead_aes256_gcm_rtpsize", secret_key: Array(32).fill(7), dave_protocol_version: 1 } }));
    voice.emit("message", Uint8Array.from([0, 1, 25, 0xde]));
    voice.emit("message", JSON.stringify({ op: 11, d: { user_ids: [TEST_DISCORD_ID_4] } }));
    voice.emit("message", JSON.stringify({ op: 5, d: { user_id: TEST_DISCORD_ID_4, ssrc: 84, speaking: 1 } }));
    voice.emit("message", Uint8Array.from([0, 2, 30, 0, 0, 0xee]));
    assert.ok(frameListener, "initial DAVE transition must arm the UDP receive path");
    assert.deepEqual(await result, { phase: "udp-discovery", state: "pass" });
    assert.deepEqual(received, { opusBytes: 74 });
    assert.deepEqual(nativeCalls, [`ratchet:${TEST_DISCORD_ID_3}:42`, "dave-decrypt:42", "close"]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN;
    else process.env.CODEX_BRIDGE_DISCORD_BOT_TOKEN = previous;
  }
});
