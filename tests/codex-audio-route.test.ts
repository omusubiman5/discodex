import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedCodexPcmAdapter,
  CodexRealtimeVoiceBrain,
  codexAudioToDiscordPcm,
  discordPcmToCodexAudio,
  type CodexAppServerNotification,
  type CodexAppServerRpcTransport,
} from "../src/core/codex-audio-route.ts";

class MockRpc implements CodexAppServerRpcTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly listeners = new Set<(notification: CodexAppServerNotification) => void>();
  async request(method: string, params: unknown): Promise<unknown> { this.requests.push({ method, params }); return {}; }
  subscribe(listener: (notification: CodexAppServerNotification) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(notification: CodexAppServerNotification): void { for (const listener of this.listeners) listener(notification); }
}

const THREAD_ID = "REDACTED_CODEX_TASK_ID_1";

test("Discord PCM converts to Codex wire PCM and output converts back", () => {
  const input = { samples: Int16Array.from([100, 300, 500, 700, -100, -300, -500, -700]), sampleRate: 48_000 as const, channels: 2 as const };
  const wire = discordPcmToCodexAudio(input);
  assert.deepEqual({ sampleRate: wire.sampleRate, numChannels: wire.numChannels, samplesPerChannel: wire.samplesPerChannel }, { sampleRate: 24_000, numChannels: 1, samplesPerChannel: 2 });
  assert.deepEqual([...new Int16Array(Uint8Array.from(Buffer.from(wire.data, "base64")).buffer)], [400, -400]);
  const output = codexAudioToDiscordPcm(wire);
  assert.deepEqual([...output.samples], [400, 400, 400, 400, -400, -400, -400, -400]);
});

test("Discord PCM conversion tolerates one trailing complete stereo frame", () => {
  const wire = discordPcmToCodexAudio({
    samples: Int16Array.from([100, 300, 500, 700, 900, 1100]),
    sampleRate: 48_000,
    channels: 2,
  });
  assert.equal(wire.samplesPerChannel, 1);
  assert.deepEqual([...new Int16Array(Uint8Array.from(Buffer.from(wire.data, "base64")).buffer)], [400]);
});

test("same-thread realtime brain preserves startup context, streams audio, barge-in, stop, and reconnect", async () => {
  const rpc = new MockRpc();
  const outputs: number[][] = [];
  let barges = 0;
  const states: string[] = [];
  const brain = new CodexRealtimeVoiceBrain({
    threadId: THREAD_ID, transport: rpc,
    onOutputAudio: (frame) => outputs.push([...frame.samples]),
    onBargeIn: () => { barges += 1; },
    onStateChange: (state) => states.push(state),
  });
  await brain.start();
  assert.deepEqual(rpc.requests[0], { method: "thread/realtime/start", params: {
    threadId: THREAD_ID, outputModality: "audio", includeStartupContext: true, version: "v3",
    transport: { type: "websocket" }, clientManagedHandoffs: false, codexResponsesAsItems: true,
    flushTranscriptTailOnSessionEnd: true,
  } });
  rpc.emit({ method: "thread/realtime/started", params: { threadId: THREAD_ID, realtimeSessionId: "rt", version: "v3" } });
  rpc.emit({ method: "thread/realtime/started", params: { threadId: THREAD_ID, source: "desktop-owned-webrtc" } });
  assert.equal(brain.state, "active");
  assert.equal(states.filter((state) => state === "active").length, 1);
  await brain.appendInput({ samples: new Int16Array(1_920), sampleRate: 48_000, channels: 2 });
  assert.equal(rpc.requests.at(-1)?.method, "thread/realtime/appendAudio");
  const data = Buffer.from(Int16Array.from([9, -9]).buffer).toString("base64");
  rpc.emit({ method: "thread/realtime/outputAudio/delta", params: { threadId: THREAD_ID, audio: { data, sampleRate: 24_000, numChannels: 1, samplesPerChannel: 2, itemId: "out" } } });
  rpc.emit({ method: "thread/realtime/itemAdded", params: { threadId: THREAD_ID, item: { type: "input_audio_buffer.speech_started" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(outputs, [[9, 9, 9, 9, -9, -9, -9, -9]]);
  assert.equal(barges, 1);
  await brain.reconnect();
  assert.deepEqual(rpc.requests.slice(-2).map((request) => request.method), ["thread/realtime/stop", "thread/realtime/start"]);
  await brain.stop();
  assert.equal(brain.state, "stopped");
  assert.ok(states.includes("reconnecting"));
});

test("echo proxy and malformed audio fail closed", async () => {
  await assert.rejects(new BoundedCodexPcmAdapter().respond({ samples: new Int16Array(1_920), sampleRate: 48_000, channels: 2 }), /invalidated echo proxy/);
  assert.throws(() => discordPcmToCodexAudio({ samples: new Int16Array(), sampleRate: 48_000, channels: 2 }), /at least two complete stereo frames/);
  assert.throws(() => codexAudioToDiscordPcm({ data: "AA==", sampleRate: 24_000, numChannels: 1, samplesPerChannel: 1, itemId: null }), /truncated/);
});
