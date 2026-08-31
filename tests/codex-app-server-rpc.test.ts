import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DesktopOwnedCodexAppServerTransport, SpawnedCodexAppServerTransport, type CodexAppServerProcess } from "../src/core/codex-app-server-rpc.ts";
import { TEST_CODEX_TASK_ID_1 } from "./fixtures/public-identities.mjs";

const THREAD_ID = TEST_CODEX_TASK_ID_1;

class FakeProcess extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly requests: Array<Record<string, unknown>> = [];
  readonly #resumeError?: string;

  constructor(resumeError?: string) {
    super();
    this.#resumeError = resumeError;
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        buffer = buffer.slice(newline + 1);
        this.requests.push(message);
        if (message.id === 1) this.respond({ id: 1, result: {} });
        if (message.id === 2) this.respond(this.#resumeError ? { id: 2, error: { code: -32600, message: this.#resumeError } } : { id: 2, result: { thread: {} } });
        if (typeof message.id === "number" && Number(message.id) >= 10) this.respond({ id: message.id, result: {} });
      }
    });
  }

  respond(message: unknown): void { this.stdout.write(`${JSON.stringify(message)}\n`); }
  kill(): boolean { this.exitCode = 0; this.emit("exit", 0); return true; }
}

class FakeCdpSocket {
  readonly readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly #listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();
  #voiceActive: boolean;
  readonly #commandModuleAvailable: boolean;
  readonly #activeTaskVerified: boolean;
  readonly #rpcStopChangesVoice: boolean;
  readonly #resumeVisible: boolean;

  constructor(voiceActive = true, commandModuleAvailable = true, activeTaskVerified = true, rpcStopChangesVoice = true, resumeVisible = false) {
    this.#voiceActive = voiceActive;
    this.#commandModuleAvailable = commandModuleAvailable;
    this.#activeTaskVerified = activeTaskVerified;
    this.#rpcStopChangesVoice = rpcStopChangesVoice;
    this.#resumeVisible = resumeVisible;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  send(data: string): void {
    const command = JSON.parse(data) as { id: number; method: string; params?: { expression?: string; type?: string; key?: string; modifiers?: number } };
    this.sent.push(command as unknown as Record<string, unknown>);
    queueMicrotask(() => {
      const expression = command.params?.expression;
      const activeFallbackDenied = expression?.includes("activeTaskFallback") && expression.includes("&& false");
      if (expression?.includes("thread/realtime/stop") && this.#rpcStopChangesVoice) this.#voiceActive = false;
      if (expression?.includes("voice-reset-clicked")) this.#voiceActive = false;
      if (expression?.includes("window.close()")) this.#voiceActive = false;
      if (expression?.includes("composer.startVoiceMode") && this.#commandModuleAvailable && !activeFallbackDenied) this.#voiceActive = true;
      if (command.method === "Input.dispatchKeyEvent" && command.params?.type === "rawKeyDown" && command.params.key === "V" && command.params.modifiers === 10) this.#voiceActive = true;
      const value = expression?.includes("voice-reset-clicked")
        ? { stopped: true, category: "voice-reset-clicked" }
        : expression?.includes("window.close()")
        ? { closed: true, category: "inactive-closed" }
        : expression?.includes("getDynamicConfig")
        ? { model: "gpt-live-1-codex", version: "v3", includeStartupContext: true }
        : expression?.includes("composer.startVoiceMode") ? activeFallbackDenied
          ? { ok: false, category: "task-mismatch" }
          : this.#commandModuleAvailable ? { ok: true, category: "started" } : { ok: false, category: "command-module-unavailable" }
        : expression?.includes(".appendAudio(") ? { ok: true, category: "appended" }
        : expression?.includes("prepareRealtime()") ? "v=0\r\n" : true;
      const evaluatedValue = expression?.includes("window.close()") || expression?.includes("voice-reset-clicked") ? value
        : expression?.includes("querySelectorAll(\"button,[role=button]\")")
          ? expression.includes("音声チャットを再開") && this.#resumeVisible ? false : this.#voiceActive
          : value;
      this.emit({ id: command.id, result: command.method === "Runtime.evaluate" ? { result: { value: evaluatedValue } } : {} });
      const rpcId = expression?.match(/discord-voice-[0-9]+-[0-9]+/)?.[0];
      if (!rpcId) return;
      const result = expression!.includes("thread/read") ? {
        thread: {
          id: THREAD_ID,
          status: { type: this.#activeTaskVerified ? "active" : "idle" },
          canAcceptDirectInput: true,
        },
      } : {};
      this.emit({ method: "Runtime.bindingCalled", params: { name: "__codexDiscordVoiceBridgeEmit", payload: JSON.stringify({ kind: "response", message: { id: rpcId, result } }) } });
    });
  }

  close(): void { this.#dispatch("close", {}); }
  emit(message: unknown): void { this.#dispatch("message", { data: JSON.stringify(message) }); }
  #dispatch(type: string, event: { data?: unknown }): void { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
}

test("spawned app-server transport resumes only the exact task and forwards realtime notifications", async () => {
  const child = new FakeProcess();
  const transport = new SpawnedCodexAppServerTransport({ threadId: THREAD_ID, processFactory: () => child });
  await transport.connect();
  const notifications: string[] = [];
  transport.subscribe((notification) => notifications.push(notification.method));
  await transport.request("thread/realtime/start", { threadId: THREAD_ID, outputModality: "audio" });
  child.respond({ method: "thread/realtime/started", params: { threadId: THREAD_ID, realtimeSessionId: "rt", version: "v3" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.requests.slice(0, 3).map((request) => request.method), ["initialize", "initialized", "thread/resume"]);
  assert.deepEqual(child.requests[2]?.params, { threadId: THREAD_ID });
  assert.deepEqual(notifications, ["thread/realtime/started"]);
  transport.close();
});

test("active Desktop writer produces an explicit ownership-handoff failure", async () => {
  const child = new FakeProcess(`thread ${THREAD_ID} already has an active writer`);
  const transport = new SpawnedCodexAppServerTransport({ threadId: THREAD_ID, processFactory: () => child });
  await assert.rejects(transport.connect(), /release that Desktop task/);
  transport.close();
});

test("Desktop-owned transport uses the existing renderer app-server path and pins the exact task", async () => {
  const socket = new FakeCdpSocket();
  const transport = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => [{ type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" }],
    socketFactory: () => socket,
  });
  await transport.connect();
  const notifications: string[] = [];
  transport.subscribe((notification) => notifications.push(notification.method));
  await transport.request("thread/realtime/start", { threadId: THREAD_ID });
  socket.emit({ method: "Runtime.bindingCalled", params: { name: "__codexDiscordVoiceBridgeEmit", payload: JSON.stringify({ kind: "notification", method: "thread/realtime/started", params: { threadId: THREAD_ID } }) } });
  assert.deepEqual(notifications, ["thread/realtime/started"]);
  assert.equal(socket.sent.some((command) => command.method === "Runtime.addBinding"), true);
  assert.equal(socket.sent.some((command) => JSON.stringify(command).includes("thread/read")), true);
  assert.equal(socket.sent.some((command) => JSON.stringify(command).includes("nonSilentSamples === 0")), true);
  assert.match(DesktopOwnedCodexAppServerTransport.prototype.attachExistingRealtimeOutput.toString(), /trailingSilentFrames = 30/);
  transport.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.some((command) => JSON.stringify(command).includes("delete window")), true);
});

test("Desktop-owned transports isolate renderer relay names so identity checks cannot tear down live audio", async () => {
  const firstSocket = new FakeCdpSocket();
  const secondSocket = new FakeCdpSocket();
  const first = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => [{ type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" }],
    socketFactory: () => firstSocket,
  });
  const second = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => [{ type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" }],
    socketFactory: () => secondSocket,
  });
  await first.connect();
  await second.connect();
  const relayExpression = (socket: FakeCdpSocket) => String(socket.sent.find((command) => String((command as { params?: { expression?: string } }).params?.expression).includes("const old = window"))?.params?.expression ?? "");
  const firstRelay = relayExpression(firstSocket).match(/__codexDiscordVoiceBridgeHost_[a-z0-9_]+/i)?.[0];
  const secondRelay = relayExpression(secondSocket).match(/__codexDiscordVoiceBridgeHost_[a-z0-9_]+/i)?.[0];
  assert.ok(firstRelay);
  assert.ok(secondRelay);
  assert.notEqual(firstRelay, secondRelay);
  first.close();
  second.close();
  await new Promise((resolve) => setImmediate(resolve));
});

test("Desktop voice activity follows the owned avatar overlay when the main renderer has no call controls", async () => {
  const main = new FakeCdpSocket(false);
  const overlay = new FakeCdpSocket(true);
  const targets = [
    { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" },
    { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://desktop/voice" },
  ];
  const transport = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => targets,
    socketFactory: (url) => url.endsWith("/voice") ? overlay : main,
  });
  await transport.connect();
  assert.equal(await transport.isForegroundRealtimeVoiceActive(), true);
  transport.close();
});

test("Desktop Voice Talk activation uses the M18 native command and waits for active voice", async () => {
  const socket = new FakeCdpSocket(false);
  const transport = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => [{ type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" }],
    socketFactory: () => socket,
  });
  await transport.connect();
  assert.equal(await transport.ensureForegroundRealtimeVoiceActive(), "started");
  assert.equal(await transport.ensureForegroundRealtimeVoiceActive(), "already-active");
  const nativeCommand = socket.sent.find((command) => String((command as { params?: { expression?: string } }).params?.expression).includes("composer.startVoiceMode"));
  assert.ok(nativeCommand);
  assert.match(String((nativeCommand as { params?: { expression?: string } }).params?.expression), /localConversationId/);
  assert.match(String((nativeCommand as { params?: { expression?: string } }).params?.expression), /sessions\[0\]/);
  assert.match(String((nativeCommand as { params?: { expression?: string } }).params?.expression), /activeTaskFallback/);
  assert.match(String((nativeCommand as { params?: { expression?: string } }).params?.expression), /&& true/);
  assert.match(JSON.stringify(nativeCommand), new RegExp(THREAD_ID));
  assert.match(JSON.stringify(nativeCommand), /discord_voice_bridge/);
  transport.close();
});

test("Desktop voice activity treats an explicit resume control as inactive despite a microphone mute control", async () => {
  const main = new FakeCdpSocket(false);
  const pausedOverlay = new FakeCdpSocket(true, true, true, true, true);
  const transport = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => [
      { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" },
      { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://desktop/voice" },
    ],
    socketFactory: (url) => url.endsWith("/voice") ? pausedOverlay : main,
  });
  await transport.connect();
  assert.equal(await transport.isForegroundRealtimeVoiceActive(), false);
  transport.close();
});

test("Desktop fresh-connect reset stops the exact GPT Live call before reconnect", async () => {
  const socket = new FakeCdpSocket(true);
  const transport = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => [{ type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" }],
    socketFactory: () => socket,
  });
  await transport.connect();
  await transport.resetForegroundRealtimeVoice();
  assert.equal(await transport.isForegroundRealtimeVoiceActive(), false);
  assert.equal(socket.sent.some((command) => JSON.stringify(command).includes("thread/realtime/stop")), true);
  transport.close();
});

test("Desktop fresh-connect reset closes one inactive GPT Live overlay", async () => {
  const main = new FakeCdpSocket(false);
  const overlay = new FakeCdpSocket(false);
  const targets = () => [
    { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" },
    ...(overlay.sent.some((command) => JSON.stringify(command).includes("window.close()")) ? [] : [
      { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://desktop/voice" },
    ]),
  ];
  const transport = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => targets(),
    socketFactory: (url) => url.endsWith("/voice") ? overlay : main,
  });
  await transport.connect();
  await transport.resetForegroundRealtimeVoice();
  assert.equal(overlay.sent.some((command) => JSON.stringify(command).includes("window.close()")), true);
  transport.close();
});

test("Desktop fresh-connect reset stops the unique active overlay without using a stale task-scoped RPC", async () => {
  const main = new FakeCdpSocket(false);
  const overlay = new FakeCdpSocket(true, true, true, false);
  const targets = () => [
    { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" },
    ...(overlay.sent.some((command) => JSON.stringify(command).includes("window.close()")) ? [] : [
      { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://desktop/voice" },
    ]),
  ];
  const transport = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => targets(),
    socketFactory: (url) => url.endsWith("/voice") ? overlay : main,
  });
  await transport.connect();
  await transport.resetForegroundRealtimeVoice(3_000);
  assert.equal(main.sent.some((command) => JSON.stringify(command).includes("thread/realtime/stop")), false);
  assert.equal(overlay.sent.some((command) => JSON.stringify(command).includes("voice-reset-clicked")), true);
  assert.equal(overlay.sent.some((command) => JSON.stringify(command).includes("window.close()")), true);
  transport.close();
});

test("Desktop fresh-connect reset rejects an unverified main-renderer Voice task", async () => {
  const main = new FakeCdpSocket(true, true, false);
  const transport = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => [{ type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" }],
    socketFactory: () => main,
  });
  await transport.connect();
  await assert.rejects(() => transport.resetForegroundRealtimeVoice(3_000), /active Codex Voice task could not be verified/);
  assert.equal(main.sent.some((command) => JSON.stringify(command).includes("thread/realtime/stop")), false);
  transport.close();
});

test("Desktop Voice Talk does not use the active-task fallback for an idle task", async () => {
  const socket = new FakeCdpSocket(false, true, false);
  const transport = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => [{ type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" }],
    socketFactory: () => socket,
  });
  await transport.connect();
  await assert.rejects(() => transport.ensureForegroundRealtimeVoiceActive(), /task-mismatch/);
  assert.equal(socket.sent.some((command) => command.method === "Input.dispatchKeyEvent"), false);
  transport.close();
});

test("Desktop Voice Talk rejects an inactive avatar overlay before starting another task call", async () => {
  const main = new FakeCdpSocket(false);
  const overlay = new FakeCdpSocket(false);
  const transport = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => [
      { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" },
      { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://desktop/voice" },
    ],
    socketFactory: (url) => url.endsWith("/voice") ? overlay : main,
  });
  await transport.connect();
  await assert.rejects(() => transport.ensureForegroundRealtimeVoiceActive(), /inactive Codex voice overlay/);
  assert.equal(main.sent.some((command) => String((command as { params?: { expression?: string } }).params?.expression).includes("composer.startVoiceMode")), false);
  transport.close();
});

test("Desktop Voice Talk falls back to the app-scoped Codex keybinding when its dispatcher module is lazy", async () => {
  const socket = new FakeCdpSocket(false, false);
  const transport = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => [{ type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" }],
    socketFactory: () => socket,
  });
  await transport.connect();
  assert.equal(await transport.ensureForegroundRealtimeVoiceActive(), "started");
  const keys = socket.sent.filter((command) => command.method === "Input.dispatchKeyEvent");
  assert.deepEqual(keys.map((command) => (command.params as { type?: string }).type), ["rawKeyDown", "keyUp"]);
  assert.equal(keys.every((command) => (command.params as { key?: string; modifiers?: number }).key === "V" && (command.params as { modifiers?: number }).modifiers === 10), true);
  transport.close();
});

test("Desktop relay filters SDP to the exact task and relay errors keep the CDP transport connected", async () => {
  const socket = new FakeCdpSocket();
  const transport = new DesktopOwnedCodexAppServerTransport({
    threadId: THREAD_ID,
    targetResolver: async () => [{ type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://desktop/main" }],
    socketFactory: () => socket,
  });
  await transport.connect();
  const installedRelay = String(socket.sent.find((command) => String((command as { params?: { expression?: string } }).params?.expression).includes("const old = window"))?.params?.expression ?? "");
  assert.match(installedRelay, new RegExp(`message\\.params\\?\\.threadId === ["']${THREAD_ID}["']`));
  socket.emit({
    method: "Runtime.bindingCalled",
    params: { name: "__codexDiscordVoiceBridgeEmit", payload: JSON.stringify({ kind: "relay-error", code: "sdp-answer-failed" }) },
  });
  await transport.request("thread/realtime/appendAudio", { audio: { data: Buffer.from(new Int16Array(8).buffer).toString("base64") } });
  transport.close();
});
