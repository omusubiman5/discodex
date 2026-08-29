import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CodexAppServerNotification, CodexAppServerRpcTransport } from "./codex-audio-route.ts";

interface JsonRpcError { readonly code?: number; readonly message?: string }
interface JsonRpcMessage { readonly id?: number; readonly method?: string; readonly params?: unknown; readonly result?: unknown; readonly error?: JsonRpcError }

interface CdpSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { readonly data?: unknown }) => void, options?: { readonly once?: boolean }): void;
}

interface CdpTarget {
  readonly type?: string;
  readonly url?: string;
  readonly webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
}

export interface CodexAppServerProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): this;
}

export interface SpawnedCodexAppServerTransportOptions {
  readonly threadId: string;
  readonly executable?: string;
  readonly processFactory?: () => CodexAppServerProcess;
}

function assertThreadId(threadId: string): void {
  if (!/^[0-9a-f-]{20,}$/i.test(threadId)) throw new Error("A concrete current Codex thread ID is required.");
}

export interface DesktopOwnedCodexAppServerTransportOptions {
  readonly threadId: string;
  readonly debuggerEndpoint?: string;
  readonly targetResolver?: (endpoint: string) => Promise<readonly CdpTarget[]>;
  readonly socketFactory?: (url: string) => CdpSocket;
  /** Observer-only attachments must not issue thread/read against an active voice writer. */
  readonly verifyThreadOnConnect?: boolean;
}

const DESKTOP_BINDING = "__codexDiscordVoiceBridgeEmit";
const DESKTOP_RELAY = "__codexDiscordVoiceBridgeHost";
const ACTIVE_VOICE_EXPRESSION = `(() => {
  const active = /(end|stop).*(voice|call)|(voice|call).*(end|stop)|音声チャットを終了|通話を終了|マイク.*ミュート/i;
  return [...document.querySelectorAll("button,[role=button]")].some((element) => {
    const label = [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-testid")].filter(Boolean).join(" ");
    return active.test(label);
  });
})()`;

function startNativeVoiceExpression(threadId: string, verifiedActiveTask: boolean): string {
  return `(async () => {
    const legacyThreadKey = document.querySelector('[data-above-composer-conversation-id]')
      ?.getAttribute('data-above-composer-conversation-id')
      ?? document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]')
        ?.getAttribute('data-app-action-sidebar-thread-id')
      ?? document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')
        ?.getAttribute('data-app-action-sidebar-thread-id');
    const resolveMainSessionThreadKey = () => {
      const main = document.querySelector('main');
      if (!main) return undefined;
      const queue = [];
      const seen = new WeakSet();
      for (const key of Object.getOwnPropertyNames(main)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactProps$')) queue.push({ value: main[key], depth: 0 });
      }
      const ids = new Set();
      let inspected = 0;
      while (queue.length && inspected < 20000) {
        const entry = queue.shift();
        const value = entry.value;
        inspected += 1;
        if (!value || typeof value !== 'object' || entry.depth > 4 || seen.has(value)) continue;
        seen.add(value);
        if (Array.isArray(value.sessions) && typeof value.sessions[0]?.localConversationId === 'string') {
          ids.add(value.sessions[0].localConversationId);
        }
        let descriptors;
        try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { continue; }
        for (const descriptor of Object.values(descriptors)) {
          if ('value' in descriptor) queue.push({ value: descriptor.value, depth: entry.depth + 1 });
        }
      }
      return ids.size === 1 ? [...ids][0] : undefined;
    };
    const activeThreadKey = legacyThreadKey ?? resolveMainSessionThreadKey();
    const domTaskMatched = activeThreadKey === ${JSON.stringify(threadId)};
    const activeTaskFallback = activeThreadKey === undefined && ${JSON.stringify(verifiedActiveTask)};
    if (!domTaskMatched && !activeTaskFallback) return { ok: false, category: 'task-mismatch' };
    const urls = [...new Set([
      ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
      ...performance.getEntriesByType('resource').map((entry) => entry.name)
    ])];
    const commandsUrl = urls.find((value) => value.includes('/assets/run-command-'));
    if (!commandsUrl) return { ok: false, category: 'command-module-unavailable' };
    const commands = await import(commandsUrl);
    if (typeof commands.i !== 'function') return { ok: false, category: 'command-runner-unavailable' };
    const handled = commands.i('composer.startVoiceMode', 'discord_voice_bridge');
    return handled
      ? { ok: true, category: 'started' }
      : { ok: false, category: 'voice-command-inactive' };
  })()`;
}

function isDesktopVoiceOverlay(target: CdpTarget): boolean {
  if (target.type !== "page" || !target.webSocketDebuggerUrl) return false;
  try {
    const url = new URL(target.url ?? "");
    return url.protocol === "app:" && url.hostname === "-" && url.pathname === "/index.html"
      && url.searchParams.get("initialRoute") === "/avatar-overlay";
  } catch { return false; }
}

async function evaluateBooleanOnTarget(target: CdpTarget, socketFactory: (url: string) => CdpSocket): Promise<boolean> {
  if (!target.webSocketDebuggerUrl) return false;
  const socket = socketFactory(target.webSocketDebuggerUrl);
  try {
    if (socket.readyState !== 1) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex Desktop voice overlay debugger connection timed out.")), 3_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Codex Desktop voice overlay debugger connection failed.")); }, { once: true });
    });
    return await new Promise<boolean>((resolve, reject) => {
      const id = 1;
      const timer = setTimeout(() => reject(new Error("Codex Desktop voice overlay inspection timed out.")), 5_000);
      socket.addEventListener("message", (event) => {
        let message: CdpResponse;
        try { message = JSON.parse(String(event.data ?? "")) as CdpResponse; } catch { return; }
        if (message.id !== id) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message ?? "Codex Desktop voice overlay inspection failed."));
        else resolve((message.result?.result as { value?: unknown } | undefined)?.value === true);
      });
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: ACTIVE_VOICE_EXPRESSION, returnByValue: true } }));
    });
  } finally { socket.close(); }
}

async function closeInactiveVoiceOverlayTarget(target: CdpTarget, socketFactory: (url: string) => CdpSocket): Promise<void> {
  if (!target.webSocketDebuggerUrl) throw new Error("Codex Desktop voice overlay has no debugger endpoint.");
  const socket = socketFactory(target.webSocketDebuggerUrl);
  try {
    if (socket.readyState !== 1) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex Desktop voice overlay close timed out.")), 3_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Codex Desktop voice overlay close failed.")); }, { once: true });
    });
    const value = await new Promise<{ closed?: unknown; category?: unknown }>((resolve, reject) => {
      const id = 1;
      const timer = setTimeout(() => reject(new Error("Codex Desktop voice overlay close confirmation timed out.")), 5_000);
      socket.addEventListener("message", (event) => {
        let message: CdpResponse;
        try { message = JSON.parse(String(event.data ?? "")) as CdpResponse; } catch { return; }
        if (message.id !== id) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message ?? "Codex Desktop voice overlay close failed."));
        else resolve(((message.result?.result as { value?: unknown } | undefined)?.value ?? {}) as { closed?: unknown; category?: unknown });
      });
      socket.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: {
          expression: `(() => { if (${ACTIVE_VOICE_EXPRESSION}) return { closed: false, category: 'active' }; window.close(); return { closed: true, category: 'inactive-closed' }; })()`,
          returnByValue: true,
        },
      }));
    });
    if (value.closed !== true) throw new Error(`Codex Desktop voice overlay remained open [${String(value.category ?? "unknown")}].`);
  } finally { socket.close(); }
}

async function stopActiveVoiceOverlayTarget(target: CdpTarget, socketFactory: (url: string) => CdpSocket): Promise<void> {
  if (!target.webSocketDebuggerUrl) throw new Error("Codex Desktop voice overlay has no debugger endpoint.");
  const socket = socketFactory(target.webSocketDebuggerUrl);
  try {
    if (socket.readyState !== 1) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex Desktop voice overlay stop timed out.")), 3_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Codex Desktop voice overlay stop failed.")); }, { once: true });
    });
    const value = await new Promise<{ stopped?: unknown; category?: unknown }>((resolve, reject) => {
      const id = 1;
      const timer = setTimeout(() => reject(new Error("Codex Desktop voice overlay stop confirmation timed out.")), 5_000);
      socket.addEventListener("message", (event) => {
        let message: CdpResponse;
        try { message = JSON.parse(String(event.data ?? "")) as CdpResponse; } catch { return; }
        if (message.id !== id) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message ?? "Codex Desktop voice overlay stop failed."));
        else resolve(((message.result?.result as { value?: unknown } | undefined)?.value ?? {}) as { stopped?: unknown; category?: unknown });
      });
      socket.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: {
          expression: `(() => {
            const stop = /(end|stop).*(voice|call)|(voice|call).*(end|stop)|音声チャットを(?:終了|停止)|通話を(?:終了|停止)/i;
            const controls = [...document.querySelectorAll("button,[role=button]")].filter((element) => {
              const label = [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-testid")].filter(Boolean).join(" ");
              return stop.test(label);
            });
            if (controls.length !== 1) return { stopped: false, category: controls.length === 0 ? "stop-control-missing" : "stop-control-ambiguous" };
            controls[0].click();
            return { stopped: true, category: "voice-reset-clicked" };
          })()`,
          returnByValue: true,
        },
      }));
    });
    if (value.stopped !== true) throw new Error(`Codex Desktop voice overlay did not expose one stop control [${String(value.category ?? "unknown")}].`);
  } finally { socket.close(); }
}

async function resolveDesktopTargets(endpoint: string): Promise<readonly CdpTarget[]> {
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/json/list`);
  if (!response.ok) throw new Error(`Codex Desktop debugger target discovery failed (${response.status}).`);
  return await response.json() as readonly CdpTarget[];
}

/**
 * Uses the already-owned Codex Desktop renderer -> main-process app-server
 * transport. It never starts, resumes, or forks a second task writer.
 */
export class DesktopOwnedCodexAppServerTransport implements CodexAppServerRpcTransport {
  readonly #threadId: string;
  readonly #debuggerEndpoint: string;
  readonly #relayName: string;
  readonly #directOutputName: string;
  readonly #targetResolver: (endpoint: string) => Promise<readonly CdpTarget[]>;
  readonly #socketFactory: (url: string) => CdpSocket;
  readonly #verifyThreadOnConnect: boolean;
  readonly #listeners = new Set<(notification: CodexAppServerNotification) => void>();
  readonly #pendingRpc = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #pendingCdp = new Map<number, { resolve: (value: CdpResponse) => void; reject: (error: Error) => void }>();
  readonly #pendingDirectCdp = new Map<number, { resolve: (value: CdpResponse) => void; reject: (error: Error) => void }>();
  #socket?: CdpSocket;
  #directSocket?: CdpSocket;
  #nextCdpId = 1;
  #nextRpcId = 1;
  #connected = false;
  #activeThreadVerifiedOnConnect = false;
  readonly #executionContexts = new Set<number>();
  readonly #directExecutionContexts = new Set<number>();
  #directOutputContextId?: number;

  constructor(options: DesktopOwnedCodexAppServerTransportOptions) {
    assertThreadId(options.threadId);
    this.#threadId = options.threadId;
    this.#debuggerEndpoint = options.debuggerEndpoint ?? process.env.CODEX_DESKTOP_DEBUGGER_ENDPOINT ?? "http://127.0.0.1:52232";
    this.#relayName = `${DESKTOP_RELAY}_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    this.#directOutputName = `${this.#relayName}_direct_output`;
    this.#targetResolver = options.targetResolver ?? resolveDesktopTargets;
    this.#socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as CdpSocket);
    this.#verifyThreadOnConnect = options.verifyThreadOnConnect !== false;
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    if (this.#socket) throw new Error("Codex Desktop transport is already starting.");
    const targets = await this.#targetResolver(this.#debuggerEndpoint);
    const target = targets.find((candidate) => candidate.type === "page" && candidate.url === "app://-/index.html" && candidate.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) throw new Error("The main Codex Desktop renderer debugger target was not found.");
    const socket = this.#socketFactory(target.webSocketDebuggerUrl);
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#consumeCdp(String(event.data ?? "")));
    socket.addEventListener("close", () => this.#failAll(new Error("Codex Desktop transport closed.")));
    socket.addEventListener("error", () => this.#failAll(new Error("Codex Desktop transport failed.")));
    if (socket.readyState !== 1) await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Codex Desktop debugger connection failed.")), { once: true });
    });
    await this.#cdp("Runtime.enable");
    await this.#cdp("Runtime.addBinding", { name: DESKTOP_BINDING });
    await this.#evaluate(`(() => {
      const old = window[${JSON.stringify(this.#relayName)}];
      if (old?.listener) window.removeEventListener("message", old.listener);
      old?.teardownRealtime?.();
      const relay = {
        listener: null,
        peer: null,
        context: null,
        input: null,
        outputProcessor: null,
        directOutputSource: null,
        directOutputProcessor: null,
        directOutputSilent: null,
        directOutputContext: null,
        nextInputTime: 0,
        activeSent: false,
        async prepareRealtime() {
          this.teardownRealtime();
          const context = new AudioContext({ sampleRate: 24000 });
          await context.resume();
          const input = context.createMediaStreamDestination();
          const peer = new RTCPeerConnection();
          for (const track of input.stream.getAudioTracks()) peer.addTrack(track, input.stream);
          peer.ontrack = (event) => {
            const stream = new MediaStream([event.track]);
            const source = context.createMediaStreamSource(stream);
            const processor = context.createScriptProcessor(2048, 1, 1);
            const silent = context.createGain();
            silent.gain.value = 0;
            processor.onaudioprocess = (audioEvent) => {
              const floats = audioEvent.inputBuffer.getChannelData(0);
              let nonSilentSamples = 0;
              for (let index = 0; index < floats.length; index += 1) {
                if (Math.abs(floats[index]) >= 0.00025) nonSilentSamples += 1;
              }
              if (nonSilentSamples === 0) return;
              const bytes = new Uint8Array(floats.length * 2);
              const view = new DataView(bytes.buffer);
              for (let index = 0; index < floats.length; index += 1) {
                const sample = Math.max(-1, Math.min(1, floats[index]));
                view.setInt16(index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
              }
              let binary = "";
              for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
              window[${JSON.stringify(DESKTOP_BINDING)}](JSON.stringify({ kind: "audio", data: btoa(binary), samples: floats.length }));
            };
            source.connect(processor);
            processor.connect(silent);
            silent.connect(context.destination);
            relay.outputProcessor = processor;
          };
          await peer.setLocalDescription(await peer.createOffer({ offerToReceiveAudio: true }));
          if (peer.iceGatheringState !== "complete") await new Promise((resolve) => {
            const timeout = setTimeout(resolve, 5000);
            const changed = () => {
              if (peer.iceGatheringState !== "complete") return;
              clearTimeout(timeout);
              peer.removeEventListener("icegatheringstatechange", changed);
              resolve();
            };
            peer.addEventListener("icegatheringstatechange", changed);
          });
          this.peer = peer;
          this.context = context;
          this.input = input;
          this.nextInputTime = context.currentTime;
          this.activeSent = false;
          return peer.localDescription?.sdp ?? "";
        },
        async acceptAnswer(sdp) {
          if (!this.peer || typeof sdp !== "string" || sdp.length === 0) throw new Error("Codex realtime WebRTC answer is missing.");
          if (this.peer.signalingState === "stable") return;
          if (this.peer.signalingState !== "have-local-offer") throw new Error("Codex realtime WebRTC answer arrived in an invalid signaling state.");
          await this.peer.setRemoteDescription({ type: "answer", sdp });
          if (this.peer.connectionState !== "connected") await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Codex realtime WebRTC connection timed out.")), 10000);
            const changed = () => {
              if (this.peer?.connectionState !== "connected") return;
              clearTimeout(timeout);
              this.peer.removeEventListener("connectionstatechange", changed);
              resolve();
            };
            this.peer.addEventListener("connectionstatechange", changed);
          });
          if (!this.activeSent) {
            this.activeSent = true;
            window[${JSON.stringify(DESKTOP_BINDING)}](JSON.stringify({ kind: "webrtc-active" }));
          }
        },
        appendAudio(data) {
          if (!this.context || !this.input || typeof data !== "string") return { ok: false, category: "relay-not-ready" };
          try {
            const binary = atob(data);
            const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
            if (bytes.length === 0 || bytes.length % 2 !== 0) return { ok: false, category: "pcm-wire" };
            const view = new DataView(bytes.buffer);
            const buffer = this.context.createBuffer(1, bytes.length / 2, 24000);
            const channel = buffer.getChannelData(0);
            for (let index = 0; index < channel.length; index += 1) channel[index] = view.getInt16(index * 2, true) / 32768;
            const source = this.context.createBufferSource();
            source.buffer = buffer;
            source.connect(this.input);
            const startAt = Math.max(this.context.currentTime + 0.01, this.nextInputTime);
            source.start(startAt);
            this.nextInputTime = startAt + buffer.duration;
            return { ok: true, category: "appended" };
          } catch (error) {
            const name = typeof error?.name === "string" ? error.name : "";
            const category = name === "InvalidStateError" ? "audio-invalid-state"
              : name === "NotSupportedError" ? "audio-not-supported"
              : "audio-append-error";
            return { ok: false, category };
          }
        },
        detachExistingOutput() {
          try { this.directOutputSource?.disconnect(); } catch {}
          try { this.directOutputProcessor?.disconnect(); } catch {}
          try { this.directOutputSilent?.disconnect(); } catch {}
          try { this.directOutputContext?.close(); } catch {}
          this.directOutputSource = null;
          this.directOutputProcessor = null;
          this.directOutputSilent = null;
          this.directOutputContext = null;
        },
        teardownRealtime() {
          this.detachExistingOutput();
          try { this.outputProcessor?.disconnect(); } catch {}
          try { this.peer?.close(); } catch {}
          try { this.context?.close(); } catch {}
          this.outputProcessor = null;
          this.peer = null;
          this.context = null;
          this.input = null;
          this.nextInputTime = 0;
          this.activeSent = false;
        },
      };
      const listener = (event) => {
        const message = event.data;
        if (!message || typeof message !== "object" || message.hostId !== "local") return;
        if (message.type === "mcp-response") window[${JSON.stringify(DESKTOP_BINDING)}](JSON.stringify({ kind: "response", message: message.message }));
        else if (message.type === "mcp-notification") {
          if (message.method === "thread/realtime/sdp" && message.params?.threadId === ${JSON.stringify(this.#threadId)}) {
            void relay.acceptAnswer(message.params?.sdp).catch(() => window[${JSON.stringify(DESKTOP_BINDING)}](JSON.stringify({ kind: "relay-error", code: "sdp-answer-failed" })));
          }
          window[${JSON.stringify(DESKTOP_BINDING)}](JSON.stringify({ kind: "notification", method: message.method, params: message.params }));
        }
      };
      window.addEventListener("message", listener);
      relay.listener = listener;
      window[${JSON.stringify(this.#relayName)}] = relay;
      return true;
    })()`);
    this.#connected = true;
    if (this.#verifyThreadOnConnect) {
      const result = await this.request("thread/read", { threadId: this.#threadId, includeTurns: false }) as {
        thread?: { id?: string; status?: { type?: string }; canAcceptDirectInput?: boolean };
      };
      if (result.thread?.id !== this.#threadId) {
        this.close();
        throw new Error("Codex Desktop returned a different task identity.");
      }
      this.#activeThreadVerifiedOnConnect = result.thread.status?.type === "active"
        && result.thread.canAcceptDirectInput === true;
    }
  }

  subscribe(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async isForegroundRealtimeVoiceActive(): Promise<boolean> {
    if (!this.#connected) throw new Error("Codex Desktop transport is not connected.");
    if (await this.#evaluate(ACTIVE_VOICE_EXPRESSION) === true) return true;
    const overlays = (await this.#targetResolver(this.#debuggerEndpoint)).filter(isDesktopVoiceOverlay);
    if (overlays.length > 1) throw new Error("Multiple Codex Desktop voice overlays were found.");
    return overlays.length === 1 && await evaluateBooleanOnTarget(overlays[0]!, this.#socketFactory);
  }

  /**
   * Taps the one already-connected foreground WebRTC receiver. This does not
   * create, start, stop, renegotiate, or replace a realtime peer/track.
   */
  async attachExistingRealtimeOutput(): Promise<{ peers: number; liveAudioReceivers: number; sampleRate: number; channels: number; localPlaybackSuppressed: boolean }> {
    if (!this.#connected) throw new Error("Codex Desktop transport is not connected.");
    if (this.#directSocket) throw new Error("Codex direct WebRTC output is already attaching or attached.");
    const overlays = (await this.#targetResolver(this.#debuggerEndpoint)).filter(isDesktopVoiceOverlay);
    if (overlays.length !== 1 || !overlays[0]?.webSocketDebuggerUrl) {
      throw new Error(`Codex direct WebRTC output attachment failed [voice-overlay-identity count=${overlays.length}].`);
    }
    const directSocket = this.#socketFactory(overlays[0].webSocketDebuggerUrl);
    this.#directSocket = directSocket;
    directSocket.addEventListener("message", (event) => this.#consumeDirectCdp(String(event.data ?? "")));
    directSocket.addEventListener("close", () => this.#failDirect(new Error("Codex Desktop voice overlay transport closed.")));
    directSocket.addEventListener("error", () => this.#failDirect(new Error("Codex Desktop voice overlay transport failed.")));
    if (directSocket.readyState !== 1) await new Promise<void>((resolve, reject) => {
      directSocket.addEventListener("open", () => resolve(), { once: true });
      directSocket.addEventListener("error", () => reject(new Error("Codex Desktop voice overlay debugger connection failed.")), { once: true });
    });
    await this.#directCdp("Runtime.enable");
    await this.#directCdp("Runtime.addBinding", { name: DESKTOP_BINDING });
    // Runtime.enable publishes executionContextCreated asynchronously. Give
    // the renderer one bounded turn before evaluating ownership; an empty
    // context set must never broaden to the default world.
    if (this.#directExecutionContexts.size === 0) await new Promise((resolve) => setTimeout(resolve, 75));
    const inspectedContexts: Array<{ contextId: number; peersId: string; peers: number; liveAudioReceivers: number }> = [];
    for (const contextId of this.#directExecutionContexts) {
      const prototype = await this.#directCdp("Runtime.evaluate", { contextId, expression: "typeof RTCPeerConnection === 'function' ? RTCPeerConnection.prototype : null" }).catch(() => undefined);
      const prototypeId = (prototype?.result?.result as { objectId?: string; subtype?: string } | undefined)?.objectId;
      if (!prototypeId) continue;
      const queried = await this.#directCdp("Runtime.queryObjects", { prototypeObjectId: prototypeId }).catch(() => undefined);
      const peersId = (queried?.result?.objects as { objectId?: string } | undefined)?.objectId;
      if (!peersId) continue;
      const inspected = await this.#directCdp("Runtime.callFunctionOn", {
        objectId: peersId,
        functionDeclaration: `function() {
          const peers = this.filter((peer) => ['connected', 'connecting'].includes(peer.connectionState));
          const liveAudioReceivers = peers.flatMap((peer) => peer.getReceivers())
            .filter((receiver) => receiver.track?.kind === 'audio' && receiver.track.readyState === 'live').length;
          return { peers: peers.length, liveAudioReceivers };
        }`,
        returnByValue: true,
      });
      const exception = inspected.result?.exceptionDetails as { text?: string } | undefined;
      if (exception) throw new Error(`Codex direct WebRTC context inspection failed: ${exception.text ?? "renderer exception"}.`);
      const identity = (inspected?.result?.result as { value?: { peers?: number; liveAudioReceivers?: number } } | undefined)?.value;
      inspectedContexts.push({ contextId, peersId, peers: identity?.peers ?? 0, liveAudioReceivers: identity?.liveAudioReceivers ?? 0 });
    }
    const owners = inspectedContexts.filter((entry) => entry.peers > 0 || entry.liveAudioReceivers > 0);
    if (owners.length !== 1 || owners[0]!.peers !== 1 || owners[0]!.liveAudioReceivers !== 1) {
      const peers = owners.reduce((sum, owner) => sum + owner.peers, 0);
      const receivers = owners.reduce((sum, owner) => sum + owner.liveAudioReceivers, 0);
      throw new Error(`Codex direct WebRTC output attachment failed [receiver-identity inspected=${inspectedContexts.length} owners=${owners.length} peers=${peers} receivers=${receivers}].`);
    }
    const owner = owners[0]!;
    const response = await this.#directCdp("Runtime.callFunctionOn", {
      objectId: owner.peersId,
      functionDeclaration: `async function(directOutputName, bindingName) {
        const prior = globalThis[directOutputName];
        try { if (prior?.receiverTrack) prior.receiverTrack.enabled = prior.receiverTrackEnabled; } catch {}
        try { prior?.tapTrack?.stop(); } catch {}
        try { prior?.source?.disconnect(); } catch {}
        try { prior?.processor?.disconnect(); } catch {}
        try { prior?.silent?.disconnect(); } catch {}
        try { await prior?.context?.close(); } catch {}
        delete globalThis[directOutputName];
        const peers = this.filter((peer) => ['connected', 'connecting'].includes(peer.connectionState));
        const receivers = peers.flatMap((peer) => peer.getReceivers())
          .filter((receiver) => receiver.track?.kind === 'audio' && receiver.track.readyState === 'live');
        if (peers.length !== 1 || receivers.length !== 1) {
          return { attached: false, category: 'receiver-identity', peers: peers.length, liveAudioReceivers: receivers.length };
        }
        const receiverTrack = receivers[0].track;
        const receiverTrackEnabled = receiverTrack.enabled;
        const tapTrack = receiverTrack.clone();
        if (!tapTrack || tapTrack.readyState !== 'live') return { attached: false, category: 'receiver-clone' };
        // The clone retains the remote source for Discord while the original
        // track is silenced only for Codex's local playback graph. Detach
        // restores the exact prior enabled state.
        receiverTrack.enabled = false;
        const context = new AudioContext({ sampleRate: 48000 });
        await context.resume();
        const source = context.createMediaStreamSource(new MediaStream([tapTrack]));
        const processor = context.createScriptProcessor(2048, 2, 2);
        const silent = context.createGain();
        silent.gain.value = 0;
        let trailingSilentFrames = 0;
        processor.onaudioprocess = (audioEvent) => {
          const input = audioEvent.inputBuffer;
          const frames = input.length;
          const sourceChannels = Math.max(1, input.numberOfChannels);
          const left = input.getChannelData(0);
          const right = sourceChannels > 1 ? input.getChannelData(1) : left;
          const bytes = new Uint8Array(frames * 2 * 2);
          const view = new DataView(bytes.buffer);
          let nonSilentSamples = 0;
          for (let index = 0; index < frames; index += 1) {
            const l = Math.max(-1, Math.min(1, left[index]));
            const r = Math.max(-1, Math.min(1, right[index]));
            if (Math.abs(l) >= 0.00025 || Math.abs(r) >= 0.00025) nonSilentSamples += 1;
            view.setInt16(index * 4, l < 0 ? l * 32768 : l * 32767, true);
            view.setInt16(index * 4 + 2, r < 0 ? r * 32768 : r * 32767, true);
          }
          if (nonSilentSamples === 0) {
            if (trailingSilentFrames <= 0) return;
            trailingSilentFrames -= 1;
          } else {
            // LiveOutputSpeechGate requires 25 silent frames to close a
            // Discord Speaking cycle. Preserve a bounded tail from the
            // existing Codex receiver instead of dropping every silent frame.
            trailingSilentFrames = 30;
          }
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
          window[bindingName](JSON.stringify({ kind: 'existing-audio', data: btoa(binary), samples: frames, sampleRate: context.sampleRate, channels: 2 }));
        };
        source.connect(processor);
        processor.connect(silent);
        silent.connect(context.destination);
        globalThis[directOutputName] = { receiverTrack, receiverTrackEnabled, tapTrack, source, processor, silent, context };
        return { attached: true, peers: peers.length, liveAudioReceivers: receivers.length, sampleRate: context.sampleRate, channels: 2, localPlaybackSuppressed: receiverTrack.enabled === false };
      }`,
      arguments: [{ value: this.#directOutputName }, { value: DESKTOP_BINDING }],
      awaitPromise: true,
      returnByValue: true,
    });
    const value = (response.result?.result as { value?: unknown } | undefined)?.value as {
      attached?: unknown; category?: unknown; peers?: unknown; liveAudioReceivers?: unknown; sampleRate?: unknown; channels?: unknown; localPlaybackSuppressed?: unknown;
    } | undefined;
    if (value?.attached !== true || value.peers !== 1 || value.liveAudioReceivers !== 1 || value.sampleRate !== 48_000 || value.channels !== 2 || value.localPlaybackSuppressed !== true) {
      const category = typeof value?.category === "string" ? value.category : "direct-output-attach";
      throw new Error(`Codex direct WebRTC output attachment failed [${category}].`);
    }
    this.#directOutputContextId = owner.contextId;
    return { peers: 1, liveAudioReceivers: 1, sampleRate: 48_000, channels: 2, localPlaybackSuppressed: true };
  }

  async detachExistingRealtimeOutput(): Promise<void> {
    if (!this.#directSocket) return;
    const contextId = this.#directOutputContextId;
    this.#directOutputContextId = undefined;
    try {
      if (contextId !== undefined) await this.#directCdp("Runtime.evaluate", {
        contextId,
        expression: `(async () => { const tap = globalThis[${JSON.stringify(this.#directOutputName)}]; try { if (tap?.receiverTrack) tap.receiverTrack.enabled = tap.receiverTrackEnabled; } catch {} try { tap?.tapTrack?.stop(); } catch {} try { tap?.source?.disconnect(); } catch {} try { tap?.processor?.disconnect(); } catch {} try { tap?.silent?.disconnect(); } catch {} try { await tap?.context?.close(); } catch {} delete globalThis[${JSON.stringify(this.#directOutputName)}]; return true; })()`,
        awaitPromise: true,
        returnByValue: true,
      });
    } finally {
      const socket = this.#directSocket;
      this.#directSocket = undefined;
      this.#directExecutionContexts.clear();
      socket?.close();
      this.#failDirect(new Error("Codex direct WebRTC output detached."));
    }
  }

  /** Uses the same native Codex command as the physical M18 VOICE TALK key. */
  async ensureForegroundRealtimeVoiceActive(timeoutMs = 12_000): Promise<"already-active" | "started"> {
    if (!this.#connected) throw new Error("Codex Desktop transport is not connected.");
    if (await this.isForegroundRealtimeVoiceActive()) return "already-active";
    const inactiveOverlays = (await this.#targetResolver(this.#debuggerEndpoint)).filter(isDesktopVoiceOverlay);
    if (inactiveOverlays.length > 1) throw new Error("Multiple Codex Desktop voice overlays were found.");
    if (inactiveOverlays.length === 1) {
      throw new Error("An inactive Codex voice overlay is still open.");
    }
    const evaluated = await this.#evaluate(startNativeVoiceExpression(this.#threadId, this.#activeThreadVerifiedOnConnect), true);
    const result = evaluated && typeof evaluated === "object"
      ? evaluated as { ok?: unknown; category?: unknown }
      : undefined;
    if (result?.ok !== true) {
      const category = typeof result?.category === "string" && /^[a-z-]+$/.test(result.category)
        ? result.category
        : "desktop-evaluate";
      if (category === "command-module-unavailable" || category === "command-runner-unavailable") {
        // Current Codex builds expose composer.startVoiceMode through the
        // app-scoped Ctrl+Shift+V command even when the lazily-loaded command
        // dispatcher module is not present in this renderer. Dispatch only to
        // the already identity-pinned renderer; never emit a global OS key.
        const key = { key: "V", code: "KeyV", modifiers: 10, windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 };
        await this.#cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
        await this.#cdp("Input.dispatchKeyEvent", { type: "keyUp", ...key });
      } else {
        throw new Error(`Codex native Voice Talk could not start [${category}].`);
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isForegroundRealtimeVoiceActive()) return "started";
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Codex native Voice Talk did not become active before the bounded timeout.");
  }

  /** Stops the exact task's prior GPT Live call and removes its inactive overlay before a fresh connect. */
  async resetForegroundRealtimeVoice(timeoutMs = 12_000): Promise<void> {
    if (!this.#connected) throw new Error("Codex Desktop transport is not connected.");
    await this.detachExistingRealtimeOutput().catch(() => undefined);
    if (await this.isForegroundRealtimeVoiceActive()) {
      await this.request("thread/realtime/stop", { threadId: this.#threadId });
      const deadline = Date.now() + timeoutMs;
      const rpcGraceDeadline = Math.min(deadline, Date.now() + 1_500);
      while (Date.now() < rpcGraceDeadline) {
        if (!(await this.isForegroundRealtimeVoiceActive())) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (await this.isForegroundRealtimeVoiceActive()) {
        const activeOverlays = (await this.#targetResolver(this.#debuggerEndpoint)).filter(isDesktopVoiceOverlay);
        if (activeOverlays.length !== 1 || !(await evaluateBooleanOnTarget(activeOverlays[0]!, this.#socketFactory))) {
          throw new Error("The exact previous Codex GPT Live overlay could not be identified before reconnect.");
        }
        await stopActiveVoiceOverlayTarget(activeOverlays[0]!, this.#socketFactory);
        while (Date.now() < deadline) {
          if (!(await this.isForegroundRealtimeVoiceActive())) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (await this.isForegroundRealtimeVoiceActive()) throw new Error("The previous Codex GPT Live call did not stop before reconnect.");
    }
    const overlays = (await this.#targetResolver(this.#debuggerEndpoint)).filter(isDesktopVoiceOverlay);
    if (overlays.length > 1) throw new Error("Multiple Codex Desktop voice overlays remained before reconnect.");
    if (overlays.length === 1) {
      if (await evaluateBooleanOnTarget(overlays[0]!, this.#socketFactory)) throw new Error("The previous Codex GPT Live call remained active before reconnect.");
      await closeInactiveVoiceOverlayTarget(overlays[0]!, this.#socketFactory);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((await this.#targetResolver(this.#debuggerEndpoint)).filter(isDesktopVoiceOverlay).length === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("The previous Codex GPT Live overlay did not close before reconnect.");
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.#connected) throw new Error("Codex Desktop transport is not connected.");
    if (method === "thread/realtime/appendAudio") {
      const audio = (params as { audio?: { data?: unknown } })?.audio;
      if (typeof audio?.data !== "string") throw new Error("Codex realtime appendAudio requires PCM data.");
      const appendResult = await this.#evaluate(`(() => {
        const relay = window[${JSON.stringify(this.#relayName)}];
        if (!relay || typeof relay.appendAudio !== "function") return { ok: false, category: "relay-not-ready" };
        return relay.appendAudio(${JSON.stringify(audio.data)});
      })()`);
      const result = appendResult && typeof appendResult === "object" ? appendResult as { ok?: unknown; category?: unknown } : undefined;
      if (result?.ok !== true) {
        const category = typeof result?.category === "string" && /^[a-z-]+$/.test(result.category) ? result.category : "desktop-evaluate";
        throw new Error(`Codex realtime WebRTC append failed [${category}].`);
      }
      return {};
    }
    let requestParams = params;
    if (method === "thread/realtime/start") {
      const desktopConfig = await this.#evaluate(`(() => {
        const value = globalThis.__STATSIG__?.firstInstance?.getDynamicConfig?.("3566525122")?.value;
        if (!value || typeof value !== "object") return null;
        return { model: value.model, version: value.version, includeStartupContext: value.include_startup_context };
      })()`);
      if (!desktopConfig || typeof desktopConfig !== "object"
        || !/^gpt-live-[a-z0-9-]+$/i.test(String((desktopConfig as Record<string, unknown>).model ?? ""))
        || !["v1", "v3"].includes(String((desktopConfig as Record<string, unknown>).version ?? ""))) {
        throw new Error("Codex Desktop realtime feature configuration is unavailable or invalid.");
      }
      const sdp = await this.#evaluate(`window[${JSON.stringify(this.#relayName)}].prepareRealtime()`, true);
      if (typeof sdp !== "string" || sdp.length === 0) throw new Error("Codex Desktop failed to create a realtime WebRTC offer.");
      requestParams = {
        ...(params as Record<string, unknown>),
        model: (desktopConfig as Record<string, unknown>).model,
        version: (desktopConfig as Record<string, unknown>).version,
        includeStartupContext: (desktopConfig as Record<string, unknown>).includeStartupContext === true,
        transport: { type: "webrtc", sdp },
      };
    }
    const id = `discord-voice-${Date.now()}-${this.#nextRpcId++}`;
    const response = new Promise<unknown>((resolve, reject) => this.#pendingRpc.set(id, { resolve, reject }));
    const priority = method === "thread/realtime/start" || method === "thread/realtime/stop" ? "critical" : "interactive";
    const envelope = { type: "mcp-request", hostId: "local", priority, source: "discord_voice_bridge", request: { id, method, params: requestParams } };
    try {
      await this.#evaluate(`electronBridge.sendMessageFromView(JSON.parse(${JSON.stringify(JSON.stringify(envelope))}))`, true);
    } catch (error) {
      this.#pendingRpc.delete(id);
      throw error;
    }
    try { return await response; }
    finally {
      if (method === "thread/realtime/stop") await this.#evaluate(`window[${JSON.stringify(this.#relayName)}].teardownRealtime()`).catch(() => undefined);
    }
  }

  close(): void {
    void this.detachExistingRealtimeOutput().catch(() => undefined);
    this.#connected = false;
    this.#activeThreadVerifiedOnConnect = false;
    this.#listeners.clear();
    const socket = this.#socket;
    if (socket) {
      void this.#evaluate(`(() => { const relay = window[${JSON.stringify(this.#relayName)}]; relay?.detachExistingOutput?.(); if (relay?.listener) window.removeEventListener("message", relay.listener); delete window[${JSON.stringify(this.#relayName)}]; })()`)
        .catch(() => undefined)
        .finally(() => {
          if (this.#socket === socket) this.#socket = undefined;
          socket.close();
          this.#failAll(new Error("Codex Desktop transport closed."));
        });
      return;
    }
    this.#failAll(new Error("Codex Desktop transport closed."));
  }

  async #evaluate(expression: string, awaitPromise = false): Promise<unknown> {
    const response = await this.#cdp("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    const exception = response.result?.exceptionDetails as { text?: string } | undefined;
    if (exception) throw new Error(exception.text ?? "Codex Desktop renderer evaluation failed.");
    return (response.result?.result as { value?: unknown } | undefined)?.value;
  }

  #cdp(method: string, params: unknown = {}): Promise<CdpResponse> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== 1) return Promise.reject(new Error("Codex Desktop debugger socket is not open."));
    const id = this.#nextCdpId++;
    return new Promise((resolve, reject) => {
      this.#pendingCdp.set(id, { resolve, reject });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.#pendingCdp.delete(id); reject(error as Error); }
    });
  }

  #directCdp(method: string, params: unknown = {}): Promise<CdpResponse> {
    const socket = this.#directSocket;
    if (!socket || socket.readyState !== 1) return Promise.reject(new Error("Codex Desktop voice overlay debugger socket is not open."));
    const id = this.#nextCdpId++;
    return new Promise((resolve, reject) => {
      this.#pendingDirectCdp.set(id, { resolve, reject });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.#pendingDirectCdp.delete(id); reject(error as Error); }
    });
  }

  #consumeDirectCdp(data: string): void {
    let message: CdpResponse;
    try { message = JSON.parse(data) as CdpResponse; } catch { return; }
    if (message.method === "Runtime.executionContextCreated") {
      const contextId = (message.params?.context as { id?: unknown } | undefined)?.id;
      if (typeof contextId === "number") this.#directExecutionContexts.add(contextId);
      return;
    }
    if (message.method === "Runtime.executionContextDestroyed") {
      const contextId = message.params?.executionContextId;
      if (typeof contextId === "number") this.#directExecutionContexts.delete(contextId);
      if (contextId === this.#directOutputContextId) this.#directOutputContextId = undefined;
      return;
    }
    if (message.method === "Runtime.executionContextsCleared") {
      this.#directExecutionContexts.clear();
      this.#directOutputContextId = undefined;
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pendingDirectCdp.get(message.id);
      if (!pending) return;
      this.#pendingDirectCdp.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex Desktop voice overlay debugger request failed."));
      else pending.resolve(message);
      return;
    }
    if (message.method === "Runtime.bindingCalled") this.#consumeCdp(data);
  }

  #failDirect(error: Error): void {
    for (const pending of this.#pendingDirectCdp.values()) pending.reject(error);
    this.#pendingDirectCdp.clear();
  }

  #consumeCdp(data: string): void {
    let message: CdpResponse;
    try { message = JSON.parse(data) as CdpResponse; } catch { return; }
    if (message.method === "Runtime.executionContextCreated") {
      const contextId = (message.params?.context as { id?: unknown } | undefined)?.id;
      if (typeof contextId === "number") this.#executionContexts.add(contextId);
      return;
    }
    if (message.method === "Runtime.executionContextDestroyed") {
      const contextId = message.params?.executionContextId;
      if (typeof contextId === "number") this.#executionContexts.delete(contextId);
      if (contextId === this.#directOutputContextId) this.#directOutputContextId = undefined;
      return;
    }
    if (message.method === "Runtime.executionContextsCleared") {
      this.#executionContexts.clear();
      this.#directOutputContextId = undefined;
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.#pendingCdp.get(message.id);
      if (!pending) return;
      this.#pendingCdp.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex Desktop debugger request failed."));
      else pending.resolve(message);
      return;
    }
    if (message.method !== "Runtime.bindingCalled" || message.params?.name !== DESKTOP_BINDING || typeof message.params.payload !== "string") return;
    let payload: { kind?: string; method?: string; params?: unknown; data?: string; samples?: number; sampleRate?: number; channels?: number; code?: string; message?: { id?: unknown; result?: unknown; error?: JsonRpcError } };
    try { payload = JSON.parse(message.params.payload) as typeof payload; } catch { return; }
    if (payload.kind === "notification" && typeof payload.method === "string") {
      for (const listener of this.#listeners) listener({ method: payload.method, params: payload.params });
      return;
    }
    if (payload.kind === "audio" && typeof payload.data === "string" && Number.isSafeInteger(payload.samples) && payload.samples! > 0) {
      const params = { threadId: this.#threadId, audio: { data: payload.data, sampleRate: 24_000, numChannels: 1, samplesPerChannel: payload.samples, itemId: null } };
      for (const listener of this.#listeners) listener({ method: "thread/realtime/outputAudio/delta", params });
      return;
    }
    if (payload.kind === "existing-audio" && typeof payload.data === "string" && Number.isSafeInteger(payload.samples) && payload.samples! > 0
      && payload.sampleRate === 48_000 && payload.channels === 2) {
      const params = { threadId: this.#threadId, audio: { data: payload.data, sampleRate: 48_000, numChannels: 2, samplesPerChannel: payload.samples, itemId: null, source: "existing-webrtc-receiver" } };
      for (const listener of this.#listeners) listener({ method: "thread/realtime/outputAudio/delta", params });
      return;
    }
    if (payload.kind === "webrtc-active") {
      const params = { threadId: this.#threadId, source: "desktop-owned-webrtc" };
      for (const listener of this.#listeners) listener({ method: "thread/realtime/started", params });
      return;
    }
    if (payload.kind === "relay-error") {
      for (const listener of this.#listeners) listener({
        method: "thread/realtime/error",
        params: { threadId: this.#threadId, code: payload.code === "sdp-answer-failed" ? payload.code : "relay-failed" },
      });
      return;
    }
    if (payload.kind !== "response" || typeof payload.message?.id !== "string") return;
    const pending = this.#pendingRpc.get(payload.message.id);
    if (!pending) return;
    this.#pendingRpc.delete(payload.message.id);
    if (payload.message.error) pending.reject(new Error(payload.message.error.message ?? "Codex Desktop app-server request failed."));
    else pending.resolve(payload.message.result);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pendingRpc.values()) pending.reject(error);
    for (const pending of this.#pendingCdp.values()) pending.reject(error);
    this.#pendingRpc.clear();
    this.#pendingCdp.clear();
    this.#connected = false;
  }
}

function defaultExecutable(): string {
  if (process.env.CODEX_EXECUTABLE) return process.env.CODEX_EXECUTABLE;
  if (process.platform !== "win32") return "codex";
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is unavailable for Codex executable discovery.");
  const root = join(localAppData, "OpenAI", "Codex", "bin");
  const candidates = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name, "codex.exe")).filter(existsSync)
    : [];
  candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (!candidates[0]) throw new Error("Codex executable was not found in the local Desktop runtime.");
  return candidates[0];
}

export class SpawnedCodexAppServerTransport implements CodexAppServerRpcTransport {
  readonly #threadId: string;
  readonly #processFactory: () => CodexAppServerProcess;
  readonly #listeners = new Set<(notification: CodexAppServerNotification) => void>();
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #process?: CodexAppServerProcess;
  #buffer = "";
  #nextId = 10;
  #connected = false;

  constructor(options: SpawnedCodexAppServerTransportOptions) {
    assertThreadId(options.threadId);
    this.#threadId = options.threadId;
    const executable = options.executable ?? defaultExecutable();
    this.#processFactory = options.processFactory ?? (() => spawn(executable, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    }) as ChildProcessWithoutNullStreams);
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    if (this.#process) throw new Error("Codex app-server connection is already starting.");
    const child = this.#processFactory();
    this.#process = child;
    child.stdout.on("data", (chunk: Buffer | string) => this.#consume(String(chunk)));
    child.stderr.on("data", () => { /* app-server diagnostics may contain local paths; do not forward */ });
    child.once("error", () => this.#failAll(new Error("Codex app-server process failed to start.")));
    child.once("exit", () => this.#failAll(new Error("Codex app-server process exited.")));
    await this.#rawRequest(1, "initialize", {
      clientInfo: { name: "codex-discord-voice-bridge", title: "Codex Discord Voice Bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.#write({ method: "initialized", params: {} });
    try { await this.#rawRequest(2, "thread/resume", { threadId: this.#threadId }); }
    catch (error) {
      if ((error as Error).message.includes("active writer")) throw new Error("The current Codex task still has an active writer; release that Desktop task before ownership handoff.");
      throw error;
    }
    this.#connected = true;
  }

  subscribe(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.#connected) throw new Error("Codex app-server transport is not connected.");
    return this.#rawRequest(this.#nextId++, method, params);
  }

  close(): void {
    this.#connected = false;
    this.#listeners.clear();
    const child = this.#process;
    this.#process = undefined;
    if (child && child.exitCode === null) child.kill();
    this.#failAll(new Error("Codex app-server transport closed."));
  }

  #rawRequest(id: number, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try { this.#write({ id, method, params }); }
      catch (error) { this.#pending.delete(id); reject(error as Error); }
    });
  }

  #write(message: JsonRpcMessage): void {
    if (!this.#process || this.#process.exitCode !== null) throw new Error("Codex app-server process is not writable.");
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try { message = JSON.parse(line) as JsonRpcMessage; } catch { continue; }
      if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "Codex app-server request failed."));
        else pending.resolve(message.result);
      } else if (typeof message.method === "string") {
        for (const listener of this.#listeners) listener({ method: message.method, params: message.params });
      }
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#connected = false;
  }
}
