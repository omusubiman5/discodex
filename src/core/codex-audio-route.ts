import type { PcmAudioFrame } from "../adapters/windows/ffmpeg-opus-codec.ts";

export interface CodexPcmAdapter {
  respond(input: PcmAudioFrame): Promise<PcmAudioFrame>;
}

export type CodexVoiceBrainState = "idle" | "starting" | "active" | "reconnecting" | "stopping" | "stopped" | "failed";

export interface CodexAppServerNotification {
  readonly method: string;
  readonly params?: unknown;
}

/** The Desktop host owns the one writable app-server connection for an active task. */
export interface CodexAppServerRpcTransport {
  connect?(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
  subscribe(listener: (notification: CodexAppServerNotification) => void): () => void;
  close?(): void;
}

export interface CodexRealtimeVoiceBrainOptions {
  readonly threadId: string;
  readonly transport: CodexAppServerRpcTransport;
  readonly onOutputAudio?: (frame: PcmAudioFrame) => void | Promise<void>;
  readonly onBargeIn?: () => void | Promise<void>;
  readonly onTranscript?: (role: string, text: string) => void;
  readonly onStateChange?: (state: CodexVoiceBrainState) => void;
}

interface RealtimeAudioChunk {
  readonly data: string;
  readonly sampleRate: number;
  readonly numChannels: number;
  readonly samplesPerChannel: number | null;
  readonly itemId: string | null;
}

function assertThreadId(threadId: string): void {
  if (!/^[0-9a-f-]{20,}$/i.test(threadId)) throw new Error("A concrete current Codex thread ID is required.");
}

function pcm16ToBase64(samples: Int16Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
}

function base64ToPcm16(data: string): Int16Array {
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length % 2 !== 0) throw new Error("Codex realtime PCM output is empty or truncated.");
  const copy = Uint8Array.from(bytes);
  return new Int16Array(copy.buffer);
}

/** Convert Discord 48 kHz stereo PCM16 to Codex realtime 24 kHz mono PCM16. */
export function discordPcmToCodexAudio(frame: PcmAudioFrame): RealtimeAudioChunk {
  if (frame.sampleRate !== 48_000 || frame.channels !== 2 || frame.samples.length < 4 || frame.samples.length % 2 !== 0) {
    throw new Error("Discord PCM input must be 48 kHz stereo PCM16 with at least two complete stereo frames.");
  }
  // FFmpeg can return an odd count of complete stereo frames after Opus loss
  // concealment. Downsample only complete 48 kHz frame pairs; at most one
  // trailing stereo frame is intentionally omitted.
  const mono = new Int16Array(Math.floor(frame.samples.length / 4));
  for (let output = 0, input = 0; output < mono.length; output += 1, input += 4) {
    const sum = frame.samples[input]! + frame.samples[input + 1]! + frame.samples[input + 2]! + frame.samples[input + 3]!;
    mono[output] = Math.max(-32_768, Math.min(32_767, Math.round(sum / 4)));
  }
  return Object.freeze({ data: pcm16ToBase64(mono), sampleRate: 24_000, numChannels: 1, samplesPerChannel: mono.length, itemId: null });
}

/** Convert Codex realtime 24 kHz mono PCM16 to Discord 48 kHz stereo PCM16. */
export function codexAudioToDiscordPcm(audio: RealtimeAudioChunk): PcmAudioFrame {
  if (audio.sampleRate !== 24_000 || audio.numChannels !== 1) throw new Error("Codex realtime output must be 24 kHz mono PCM16.");
  const mono = base64ToPcm16(audio.data);
  if (audio.samplesPerChannel !== null && audio.samplesPerChannel !== mono.length) throw new Error("Codex realtime PCM sample count is inconsistent.");
  const stereo = new Int16Array(mono.length * 4);
  for (let input = 0, output = 0; input < mono.length; input += 1, output += 4) {
    const sample = mono[input]!;
    stereo[output] = sample; stereo[output + 1] = sample; stereo[output + 2] = sample; stereo[output + 3] = sample;
  }
  return Object.freeze({ samples: stereo, sampleRate: 48_000 as const, channels: 2 as const });
}

function notificationParams(notification: CodexAppServerNotification): Record<string, unknown> | undefined {
  return notification.params && typeof notification.params === "object" ? notification.params as Record<string, unknown> : undefined;
}

function isSpeechStartedItem(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const type = (item as Record<string, unknown>).type;
  return type === "input_audio_buffer.speech_started" || type === "conversation.input_audio.speech_started" || type === "input_audio.speech_started";
}

export class CodexRealtimeVoiceBrain {
  readonly #threadId: string;
  readonly #transport: CodexAppServerRpcTransport;
  readonly #outputListeners = new Set<(frame: PcmAudioFrame) => void | Promise<void>>();
  readonly #bargeInListeners = new Set<() => void | Promise<void>>();
  readonly #onTranscript?: (role: string, text: string) => void;
  readonly #stateListeners = new Set<(state: CodexVoiceBrainState) => void>();
  #state: CodexVoiceBrainState = "idle";
  #unsubscribe?: () => void;
  #generation = 0;

  constructor(options: CodexRealtimeVoiceBrainOptions) {
    assertThreadId(options.threadId);
    this.#threadId = options.threadId;
    this.#transport = options.transport;
    if (options.onOutputAudio) this.#outputListeners.add(options.onOutputAudio);
    if (options.onBargeIn) this.#bargeInListeners.add(options.onBargeIn);
    this.#onTranscript = options.onTranscript;
    if (options.onStateChange) this.#stateListeners.add(options.onStateChange);
  }

  get state(): CodexVoiceBrainState { return this.#state; }

  onOutputAudio(listener: (frame: PcmAudioFrame) => void | Promise<void>): () => void {
    this.#outputListeners.add(listener);
    return () => this.#outputListeners.delete(listener);
  }

  onBargeIn(listener: () => void | Promise<void>): () => void {
    this.#bargeInListeners.add(listener);
    return () => this.#bargeInListeners.delete(listener);
  }

  onStateChange(listener: (state: CodexVoiceBrainState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  async waitUntilActive(timeoutMs = 15_000): Promise<void> {
    if (this.#state === "active") return;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Codex realtime active timeout must be positive.");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error("Timed out before the current Codex realtime task became active.")); }, timeoutMs);
      const unsubscribe = this.onStateChange((state) => {
        if (state === "active") { clearTimeout(timeout); unsubscribe(); resolve(); }
        else if (state === "failed" || state === "stopped") { clearTimeout(timeout); unsubscribe(); reject(new Error(`Codex realtime entered ${state} before active.`)); }
      });
    });
  }

  #setState(state: CodexVoiceBrainState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }

  async start(): Promise<void> {
    if (!["idle", "stopped", "failed"].includes(this.#state)) throw new Error(`Codex realtime cannot start from ${this.#state}.`);
    this.#setState("starting");
    const generation = ++this.#generation;
    this.#unsubscribe?.();
    this.#unsubscribe = this.#transport.subscribe((notification) => { void this.#handleNotification(notification, generation); });
    try {
      await this.#transport.request("thread/realtime/start", {
        threadId: this.#threadId, outputModality: "audio", includeStartupContext: true, version: "v3",
        transport: { type: "websocket" }, clientManagedHandoffs: false, codexResponsesAsItems: true,
        flushTranscriptTailOnSessionEnd: true,
      });
    } catch (error) {
      this.#setState("failed");
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      throw error;
    }
  }

  async appendInput(frame: PcmAudioFrame): Promise<void> {
    if (this.#state !== "active") throw new Error(`Codex realtime audio requires active state, got ${this.#state}.`);
    await this.#transport.request("thread/realtime/appendAudio", { threadId: this.#threadId, audio: discordPcmToCodexAudio(frame) });
  }

  async reconnect(): Promise<void> {
    if (this.#state === "starting" || this.#state === "stopping") throw new Error(`Codex realtime cannot reconnect from ${this.#state}.`);
    this.#setState("reconnecting");
    try { await this.#transport.request("thread/realtime/stop", { threadId: this.#threadId }); } catch { /* already closed */ }
    this.#setState("stopped");
    await this.start();
  }

  async stop(): Promise<void> {
    if (this.#state === "idle" || this.#state === "stopped") return;
    this.#setState("stopping");
    ++this.#generation;
    try { await this.#transport.request("thread/realtime/stop", { threadId: this.#threadId }); }
    finally { this.#unsubscribe?.(); this.#unsubscribe = undefined; this.#setState("stopped"); }
  }

  async #handleNotification(notification: CodexAppServerNotification, generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    const params = notificationParams(notification);
    if (!params || params.threadId !== this.#threadId) return;
    if (notification.method === "thread/realtime/started") { this.#setState("active"); return; }
    if (notification.method === "thread/realtime/outputAudio/delta") {
      const frame = codexAudioToDiscordPcm(params.audio as RealtimeAudioChunk);
      for (const listener of this.#outputListeners) await listener(frame);
      return;
    }
    if (notification.method === "thread/realtime/transcript/done") {
      if (typeof params.role === "string" && typeof params.text === "string") this.#onTranscript?.(params.role, params.text);
      return;
    }
    if (notification.method === "thread/realtime/itemAdded" && isSpeechStartedItem(params.item)) {
      for (const listener of this.#bargeInListeners) await listener();
      return;
    }
    if (notification.method === "thread/realtime/error") { this.#setState("failed"); return; }
    if (notification.method === "thread/realtime/closed" && this.#state !== "stopping" && this.#state !== "stopped") this.#setState("failed");
  }
}

/** Historical 20 ms echo proxy retained only to fail closed at product use. */
export class BoundedCodexPcmAdapter implements CodexPcmAdapter {
  async respond(_input: PcmAudioFrame): Promise<PcmAudioFrame> {
    throw new Error("BoundedCodexPcmAdapter is an invalidated echo proxy; use CodexRealtimeVoiceBrain with the current Codex thread.");
  }
}
