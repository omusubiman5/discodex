import { pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { createSocket } from "node:dgram";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  createDiscordBotCredentialProvider,
  type BotCredentialProvider,
  useCredential,
} from "./core/credentials.ts";
import { DiscordGatewaySession } from "./adapters/discord/gateway-session.ts";
import type { GatewayPayload, VoiceGatewayHandoff } from "./adapters/discord/gateway-session.ts";
import { loadDiscordVoiceTarget, type DiscordVoiceTarget } from "./adapters/discord/voice-target.ts";
import { DiscordVoiceGatewaySession } from "./adapters/discord/voice-gateway-session.ts";
import type { DaveSession } from "./adapters/discord/dave-binding.ts";
import {
  openOfficialLibdaveNativeReadySession,
  type NativeAddonLoader,
  type OfficialLibdaveNativeReadySession,
} from "./adapters/discord/native-addon.ts";
import { redact } from "./core/redaction.ts";
import { DiscordAesRtpTransport } from "./adapters/discord/rtp-aead.ts";
import type { OpusCodec, PcmAudioFrame } from "./adapters/windows/ffmpeg-opus-codec.ts";
import { DiscordJsOpusCodec } from "./adapters/discord/discordjs-opus-codec.ts";
import {
  applyDiscordOutputGain,
  applyResponseNormalization,
  calculateResponseNormalizationGain,
  DEFAULT_OUTPUT_GAIN_LINEAR,
} from "./adapters/discord/output-gain-safety.ts";
import { BoundedCodexPcmAdapter, CodexRealtimeVoiceBrain, type CodexPcmAdapter, type CodexVoiceBrainState } from "./core/codex-audio-route.ts";
import type { CodexAppServerRpcTransport } from "./core/codex-audio-route.ts";
import { DesktopOwnedCodexAppServerTransport } from "./core/codex-app-server-rpc.ts";
import { MeetronDirectAudioBridge } from "../work/meetron/discord/direct-audio-bridge.mjs";
import { WindowsExistingGptLiveAudio } from "../work/meetron/discord/windows-gpt-live-audio.mjs";
import { MacosExistingGptLiveAudio } from "./adapters/macos/existing-gpt-live-audio.mjs";
import { DesktopExistingTaskAudio } from "../work/meetron/discord/desktop-existing-task-audio.mjs";

const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

export interface GatewaySocket {
  binaryType?: "blob" | "arraybuffer";
  send(data: string | Uint8Array): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: unknown }) => void): void;
}

export interface BinaryVoiceEnvelope { readonly sequence: number; readonly op: number; readonly payload: Uint8Array }

export function decodeServerBinaryVoiceEnvelope(data: ArrayBuffer | Uint8Array): BinaryVoiceEnvelope {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 3) throw new Error("Discord binary Voice payload is truncated.");
  const sequence = (bytes[0]! << 8) | bytes[1]!;
  const op = bytes[2]!;
  if (![25, 27, 29, 30].includes(op)) throw new Error("Discord binary Voice opcode is unsupported.");
  return { sequence, op, payload: bytes.slice(3) };
}

export function encodeClientBinaryVoiceEnvelope(op: 26 | 28 | 31, payload: Uint8Array): Uint8Array {
  if (!(payload instanceof Uint8Array) || payload.length === 0) throw new Error("Discord binary Voice response payload is empty.");
  const result = new Uint8Array(payload.length + 1);
  result[0] = op;
  result.set(payload, 1);
  return result;
}

export function buildVoiceResumePayload(handoff: VoiceGatewayHandoff, seqAck: number): GatewayPayload {
  if (!Number.isSafeInteger(seqAck) || seqAck < 0) throw new Error("Voice Resume seq_ack is invalid.");
  return { op: 7, d: {
    server_id: handoff.guildId,
    session_id: handoff.sessionId,
    token: handoff.token,
    seq_ack: seqAck,
  } };
}

export function buildGatewayResumePayload(token: string, sessionId: string, sequence: number): GatewayPayload {
  if (!token || !sessionId || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Discord Gateway Resume state is invalid.");
  }
  return { op: 6, d: { token, session_id: sessionId, seq: sequence } };
}

/** One outstanding Discord heartbeat is allowed until its official ACK. */
export class DiscordHeartbeatAckGate {
  #pending: number | null | undefined;
  begin(nonce: number | null): boolean {
    if (this.#pending !== undefined) return false;
    this.#pending = nonce;
    return true;
  }
  acknowledge(nonce?: number | null): boolean {
    if (this.#pending === undefined) return false;
    if (this.#pending !== null && nonce !== this.#pending) return false;
    this.#pending = undefined;
    return true;
  }
  reset(): void { this.#pending = undefined; }
  get waiting(): boolean { return this.#pending !== undefined; }
}

export type GatewaySocketFactory = (url: string) => GatewaySocket;

export interface GatewayReadySmokeOptions {
  timeoutMs?: number;
  socketFactory?: GatewaySocketFactory;
  credentialProvider?: BotCredentialProvider;
}

export interface VoiceLeaveOptions extends GatewayReadySmokeOptions {
  target?: DiscordVoiceTarget;
  settleMs?: number;
}

export interface UdpDiscoverySmokeOptions extends GatewayReadySmokeOptions {
  readonly outputGainLinear?: number | (() => number);
  signal?: AbortSignal;
  target?: DiscordVoiceTarget;
  targetResolver?: (token: string) => Promise<DiscordVoiceTarget>;
  udpDiscovery?: (ip: string, port: number, ssrc: number, timeoutMs: number) => Promise<DiscoveredUdpAddress>;
  holdAfterDiscoveryMs?: number;
  sessionDescriptionProbe?: boolean;
  onSessionDescription?: (evidence: { daveProtocolVersion: number; transportMode: string }) => void;
  addonPath?: string;
  addonLoader?: NativeAddonLoader;
  onDaveActive?: (evidence: { transitionId: number }) => void;
  sendToneProbe?: boolean;
  onToneSent?: (evidence: { packetBytes: number }) => void;
  receiveOpusProbe?: boolean;
  onOpusReceived?: (evidence: { opusBytes: number }) => void;
  audioRoundTripProbe?: boolean;
  liveCallWait?: boolean;
  opusCodec?: OpusCodec;
  codexAudioAdapter?: CodexPcmAdapter;
  codexVoiceBrain?: CodexRealtimeVoiceBrain;
  meetronDirectAudio?: {
    start(): Promise<void>;
    sendConferencePcm(frame: PcmAudioFrame): Promise<void>;
    setConferencePcmSink(sink: (frame: PcmAudioFrame) => void | Promise<void>): void;
    close(): Promise<void>;
  };
  onAudioRoundTrip?: (evidence: { pcmSamples: number; responseOpusBytes: number; packetBytes: number }) => void;
  onLiveCallReady?: () => void;
  onLiveStage?: (stage: "discord-voice-joined" | "discord-voice-state-matched" | "discord-participant-voice-state" | "discord-clients-connected" | "discord-client-disconnected" | "speaker-ssrc-mapped" | "speaker-ssrc-remapped" | "dave-session-described" | "dave-key-package-sent" | "dave-external-sender-received" | "dave-prepare-epoch-received" | "dave-proposals-received" | "dave-commit-welcome-sent" | "dave-commit-received" | "dave-welcome-received" | "dave-transition-ready-sent" | "dave-execute-transition-received" | "dave-epoch-active" | "dave-ratchet-selected" | "udp-discovered" | "udp-received" | "dave-decrypted" | "pcm-generated" | "codex-realtime-input" | "codex-input-failed" | "codex-realtime-output" | "meetron-chatgpt-input" | "meetron-chatgpt-output" | "codex-turn-submitting" | "codex-first-delta" | "codex-turn-completed" | "codex-turn-failed" | "speech-started" | "response-encoded" | "silence-tail-sent" | "speaking-stopped" | "voice-resume-attempt" | "voice-resumed" | "reconnecting") => void;
  onLiveResponse?: (evidence: { pcmSamples: number; responseOpusBytes: number; packetBytes: number; packets: number; inputSequence: number }) => void;
  onLiveInputLevel?: (evidence: PcmLevelEvidence) => void;
  onLiveOutputLevel?: (evidence: PcmLevelEvidence) => void;
  onLiveOutputQuality?: (evidence: PcmLevelEvidence & PcmQualityEvidence & { readonly accepted: boolean; readonly normalizationGain: number }) => void;
  onLiveCodecQuality?: (evidence: {
    readonly opusBytes: number;
    readonly inputLevel: PcmLevelEvidence;
    readonly outputLevel: PcmLevelEvidence;
    readonly inputQuality: PcmQualityEvidence;
    readonly outputQuality: PcmQualityEvidence;
  }) => void;
  onLiveRtpSendEvidence?: (evidence: {
    readonly speakingActive: boolean;
    readonly daveEncrypted: boolean;
    readonly destinationConfigured: boolean;
    readonly selfSsrcMatched: boolean;
    readonly sequenceAdvancedByOne: boolean;
    readonly timestampAdvancedBy960: boolean;
  }) => void;
  onLiveInputRouteEvidence?: (evidence: {
    readonly pcmSamples: number;
    readonly pcmBytes: number;
    readonly normalized: boolean;
    readonly routedRms: number;
    readonly routedPeak: number;
  }) => void;
  liveInputConfirmation?: {
    begin(inputSequence: number): void;
    confirm(inputSequence: number): Promise<boolean>;
  };
  onLiveTurnGateEvidence?: (evidence: { readonly state: "input-started" | "input-resumed" | "input-ended" | "input-confirmed" | "response-started"; readonly inputSequence: number }) => void;
  onCodexInputFailure?: (evidence: CodexInputFailureEvidence) => void;
  onCodexState?: (state: CodexVoiceBrainState) => void;
}

export interface PcmLevelEvidence {
  readonly pcmSamples: number;
  readonly rms: number;
  readonly peak: number;
  readonly nonSilentSamples: number;
}

export interface PcmQualityEvidence {
  readonly dcOffset: number;
  readonly clippedSamples: number;
  readonly zeroCrossingPermille: number;
  readonly differenceRms: number;
}

const DISCORD_OPUS_PACKET_SAMPLES = 960 * 2;
const OUTPUT_SPEECH_MIN_RMS = 64;
const OUTPUT_SPEECH_MIN_PEAK = 384;
const INPUT_SPEECH_MIN_RMS = 256;
const INPUT_SPEECH_MIN_PEAK = 1_024;

export function measurePcmQuality(samples: Int16Array): PcmQualityEvidence {
  if (samples.length === 0) return { dcOffset: 0, clippedSamples: 0, zeroCrossingPermille: 0, differenceRms: 0 };
  let sum = 0;
  let clippedSamples = 0;
  let zeroCrossings = 0;
  let differenceSquareSum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    sum += sample;
    if (Math.abs(sample) >= 32_760) clippedSamples += 1;
    if (index > 0) {
      const previous = samples[index - 1]!;
      if ((sample < 0 && previous >= 0) || (sample >= 0 && previous < 0)) zeroCrossings += 1;
      const difference = sample - previous;
      differenceSquareSum += difference * difference;
    }
  }
  const transitions = Math.max(1, samples.length - 1);
  return {
    dcOffset: Math.round(sum / samples.length) || 0,
    clippedSamples,
    zeroCrossingPermille: Math.round((zeroCrossings * 1_000) / transitions),
    differenceRms: Math.round(Math.sqrt(differenceSquareSum / transitions)),
  };
}

export function isConversationPcm(level: PcmLevelEvidence): boolean {
  return level.rms >= OUTPUT_SPEECH_MIN_RMS && level.peak >= OUTPUT_SPEECH_MIN_PEAK;
}

/** Reject open-mic noise before gain normalization and Codex input routing. */
export function isConversationInputPcm(level: PcmLevelEvidence): boolean {
  return level.rms >= INPUT_SPEECH_MIN_RMS && level.peak >= INPUT_SPEECH_MIN_PEAK;
}

/** Discord Voice Gateway v8 Opcode 5 uses bit 0 for microphone speech. */
export function isDiscordMicrophoneSpeaking(value: unknown): boolean {
  return Number.isSafeInteger(value) && (Number(value) & 1) === 1;
}

export function packetizeDiscordPcm(remainder: Int16Array, incoming: Int16Array): {
  readonly packets: readonly Int16Array[];
  readonly remainder: Int16Array;
} {
  const combined = new Int16Array(remainder.length + incoming.length);
  combined.set(remainder);
  combined.set(incoming, remainder.length);
  const completeSamples = combined.length - (combined.length % DISCORD_OPUS_PACKET_SAMPLES);
  const packets: Int16Array[] = [];
  for (let offset = 0; offset < completeSamples; offset += DISCORD_OPUS_PACKET_SAMPLES) {
    packets.push(combined.slice(offset, offset + DISCORD_OPUS_PACKET_SAMPLES));
  }
  return { packets, remainder: combined.slice(completeSamples) };
}

export function normalizeConversationPcm(samples: Int16Array, level = measurePcmLevel(samples)): Int16Array {
  if (samples.length === 0 || level.rms === 0) return samples.slice();
  const gain = Math.min(48, Math.max(1, 8_000 / level.rms), level.peak > 0 ? 28_000 / level.peak : 48);
  const normalized = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    normalized[index] = Math.max(-28_000, Math.min(28_000, Math.round(samples[index]! * gain)));
  }
  return normalized;
}

export class LiveAudioTurnGate {
  #sequence = 0;
  #phase: "idle" | "input" | "wait-silence" | "armed" | "responding" = "idle";
  #confirmed = false;

  inputStarted(newSpeakingCycle = false): { readonly started: boolean; readonly resumed: boolean; readonly sequence: number } {
    if (!newSpeakingCycle && this.#phase === "input") return { started: false, resumed: false, sequence: this.#sequence };
    if (newSpeakingCycle && this.#sequence > 0) {
      this.#sequence += 1;
      this.#confirmed = false;
      this.#phase = "input";
      return { started: true, resumed: false, sequence: this.#sequence };
    }
    if (this.#phase === "wait-silence" || this.#phase === "armed") {
      this.#phase = "input";
      return { started: false, resumed: true, sequence: this.#sequence };
    }
    this.#sequence += 1;
    this.#confirmed = false;
    this.#phase = "input";
    return { started: true, resumed: false, sequence: this.#sequence };
  }

  inputEnded(): void {
    if (this.#phase === "input") this.#phase = "wait-silence";
  }

  confirmInput(expectedSequence = this.#sequence): { readonly confirmed: boolean; readonly sequence: number } {
    if (expectedSequence !== this.#sequence || this.#phase === "idle" || this.#phase === "responding" || this.#sequence === 0) {
      return { confirmed: false, sequence: this.#sequence };
    }
    this.#confirmed = true;
    // A response that was already audible before the matching user transcript
    // cannot belong to this input. Require a fresh silence boundary after the
    // confirmation before accepting any output speech.
    if (this.#phase === "armed") this.#phase = "wait-silence";
    return { confirmed: true, sequence: this.#sequence };
  }

  observeOutput(speech: boolean): { readonly accept: boolean; readonly sequence?: number; readonly responseStarted: boolean; readonly responseEnded: boolean } {
    if (this.#phase === "wait-silence") {
      if (!speech && this.#confirmed) this.#phase = "armed";
      return { accept: false, responseStarted: false, responseEnded: false };
    }
    if (this.#phase === "armed" && speech) {
      this.#phase = "responding";
      return { accept: true, sequence: this.#sequence, responseStarted: true, responseEnded: false };
    }
    if (this.#phase === "responding") {
      return speech
        ? { accept: true, sequence: this.#sequence, responseStarted: false, responseEnded: false }
        : { accept: false, responseStarted: false, responseEnded: false };
    }
    return { accept: false, responseStarted: false, responseEnded: false };
  }
}

/** Media transport gate: forward every scoped Codex speech frame while connected. */
export class LiveOutputSpeechGate {
  // Local VAD stability only; this is not a Discord protocol requirement.
  static readonly hangoverFrames = 25;
  #speaking = false;
  #silenceFrames = 0;

  observe(speech: boolean): { readonly accept: boolean; readonly started: boolean; readonly ended: boolean } {
    if (speech) {
      const started = !this.#speaking;
      this.#speaking = true;
      this.#silenceFrames = 0;
      return { accept: true, started, ended: false };
    }
    if (!this.#speaking) return { accept: false, started: false, ended: false };
    this.#silenceFrames += 1;
    if (this.#silenceFrames < LiveOutputSpeechGate.hangoverFrames) return { accept: false, started: false, ended: false };
    this.#speaking = false;
    this.#silenceFrames = 0;
    return { accept: false, started: false, ended: true };
  }

  reset(): void {
    this.#speaking = false;
    this.#silenceFrames = 0;
  }
}

export const DISCORD_OPUS_SILENCE = Uint8Array.from([0xf8, 0xff, 0xfe]);

export async function sendDiscordSpeakingEnd(
  transport: { encode(opus: Uint8Array): Uint8Array },
  media: { send(packet: Uint8Array): Promise<void> },
  voice: { send(payload: string): void },
  ssrc: number,
  delay: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await media.send(transport.encode(DISCORD_OPUS_SILENCE));
    if (index < 4) await delay(20);
  }
  voice.send(JSON.stringify({ op: 5, d: { speaking: 0, delay: 0, ssrc } }));
}

export function selectMediaRatchetOnce(
  selected: Map<number, string>,
  select: (userId: string, ssrc: number) => void,
  userId: string,
  ssrc: number,
): boolean {
  if (selected.get(ssrc) === userId) return false;
  select(userId, ssrc);
  selected.set(ssrc, userId);
  return true;
}

export function resetParticipantMediaState(
  speakerUsers: Map<number, string>,
  selected: Map<number, string>,
  userId: string,
): void {
  for (const [ssrc, mappedUserId] of speakerUsers) {
    if (mappedUserId !== userId) continue;
    speakerUsers.delete(ssrc);
    selected.delete(ssrc);
  }
}

export function resolveIncomingSpeaker(
  speakerUsers: Map<number, string>,
  selectedRatchets: Map<number, string>,
  recognizedUserIds: ReadonlySet<string>,
  selfUserId: string,
  selfSsrc: number,
  incomingSsrc: number,
  excludeSelf: boolean,
): { readonly userId: string; readonly inferred: boolean } | undefined {
  if (excludeSelf && incomingSsrc === selfSsrc) return undefined;
  const mapped = speakerUsers.get(incomingSsrc);
  if (mapped) return { userId: mapped, inferred: false };
  const externalUsers = [...recognizedUserIds].filter((userId) => userId !== selfUserId);
  if (externalUsers.length !== 1) return undefined;
  const userId = externalUsers[0]!;
  // An unknown RTP SSRC is not evidence that the active participant changed
  // SSRC.  Infer only when disconnect/rejoin cleanup removed its old mapping;
  // otherwise multiple sources could manufacture false remap lifecycle marks.
  if ([...speakerUsers.values()].includes(userId)) return undefined;
  speakerUsers.set(incomingSsrc, userId);
  return { userId, inferred: true };
}

export function observeSpeakerSsrc(
  lastSsrcByUser: Map<string, number>,
  userId: string,
  ssrc: number,
): "speaker-ssrc-mapped" | "speaker-ssrc-remapped" {
  const previousSsrc = lastSsrcByUser.get(userId);
  lastSsrcByUser.set(userId, ssrc);
  return previousSsrc !== undefined && previousSsrc !== ssrc ? "speaker-ssrc-remapped" : "speaker-ssrc-mapped";
}

export interface CodexInputFailureEvidence {
  readonly method: "thread/realtime/appendAudio";
  readonly code: "pcm-shape" | "relay-not-ready" | "renderer-evaluation" | "desktop-transport" | "inactive" | "unknown";
  readonly message: "Current Codex realtime input append failed.";
  readonly correlation: string;
}

export class SingleFlightCodexInputRoute {
  #inFlight = false;
  #attempt = 0;

  get inFlight(): boolean { return this.#inFlight; }

  async append(
    brain: Pick<CodexRealtimeVoiceBrain, "state" | "appendInput">,
    frame: PcmAudioFrame,
    onStage?: UdpDiscoveryOptions["onLiveStage"],
    onFailure?: (evidence: CodexInputFailureEvidence) => void,
  ): Promise<boolean> {
    if (this.#inFlight) return false;
    this.#inFlight = true;
    try {
      if (brain.state !== "active") throw new Error("inactive");
      await brain.appendInput(frame);
      onStage?.("codex-realtime-input");
      return true;
    } catch (error) {
      onStage?.("codex-input-failed");
      const message = error instanceof Error ? error.message : "";
      const explicitCategory = message.match(/WebRTC append failed \[([a-z-]+)\]/i)?.[1];
      const category = explicitCategory ?? (message.includes("Discord PCM input") ? "pcm-shape"
        : message.includes("WebRTC input is not ready") ? "relay-not-ready"
        : message.includes("renderer evaluation") ? "renderer-evaluation"
        : message.includes("debugger socket") || message.includes("transport closed") ? "desktop-transport"
        : message === "inactive" || message.includes("requires active state") ? "inactive"
        : "unknown");
      onFailure?.({
        method: "thread/realtime/appendAudio",
        code: category,
        message: "Current Codex realtime input append failed.",
        correlation: `append-${++this.#attempt}`,
      });
      throw new Error(`Current Codex realtime input append failed [${category}].`);
    } finally {
      this.#inFlight = false;
    }
  }
}

export function measurePcmLevel(samples: Int16Array): PcmLevelEvidence {
  if (samples.length === 0) return { pcmSamples: 0, rms: 0, peak: 0, nonSilentSamples: 0 };
  let squareSum = 0;
  let peak = 0;
  let nonSilentSamples = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    squareSum += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude > 8) nonSilentSamples += 1;
  }
  return {
    pcmSamples: samples.length,
    rms: Math.round(Math.sqrt(squareSum / samples.length)),
    peak,
    nonSilentSamples,
  };
}

export interface DiscoveredUdpAddress {
  readonly address: string;
  readonly port: number;
  readonly media?: {
    send(packet: Uint8Array): Promise<void>;
    inject(packet: Uint8Array): Promise<void>;
    onFrame(listener: (packet: Uint8Array) => void): void;
    close(): void;
  };
}

export interface LiveDaveNegotiationOptions extends UdpDiscoverySmokeOptions {
  onNegotiated?: (evidence: { daveProtocolVersion: number; transportMode: string }) => void;
}

export interface CurrentTaskLiveCallOptions extends Omit<UdpDiscoverySmokeOptions, "codexVoiceBrain" | "meetronDirectAudio" | "liveCallWait" | "audioRoundTripProbe"> {
  threadId?: string;
  appServerTransport?: CodexAppServerRpcTransport & { connect?(): Promise<void>; close?(): void };
  maxReconnectAttempts?: number;
  existingTaskAudio?: {
    readonly platform?: "win32" | "darwin";
    readonly desktopProcessId: number;
    readonly virtualCableRenderEndpointId?: string;
    readonly virtualAudioDeviceName?: string;
    readonly expectedSessionIdentity: string;
    readonly verifyExistingSession: (expected: { existingGptLiveProcessId: number; expectedSessionIdentity: string }) => Promise<{
      readonly matches: boolean;
      readonly voiceActive: boolean;
      readonly processId: number;
      readonly sessionIdentity: string;
      readonly reason?: string;
    }>;
  };
}

export function isRecoverableLiveTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^(?:Discord Gateway connection failed|Discord Voice Gateway connection failed|Discord Voice Gateway closed before UDP discovery|Discord Voice Gateway resume failed closed|Timed out before (?:Discord UDP discovery|a DAVE-decrypted Opus frame was received))/i.test(error.message);
}

export async function runWithBoundedRecovery<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    readonly maxReconnectAttempts?: number;
    readonly isRecoverable?: (error: unknown) => boolean;
    readonly onRetry?: (attempt: number) => void;
  } = {},
): Promise<T> {
  const maximum = options.maxReconnectAttempts ?? 0;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 1) {
    throw new Error("maxReconnectAttempts must be 0 or 1.");
  }
  const recoverable = options.isRecoverable ?? isRecoverableLiveTransportError;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maximum || !recoverable(error)) throw error;
      options.onRetry?.(attempt + 1);
    }
  }
}

export interface DaveReadyOptions {
  addonPath?: string;
  addonLoader?: NativeAddonLoader;
  target?: DiscordVoiceTarget;
  credentialProvider?: BotCredentialProvider;
}

export interface DaveReadyHandle {
  readonly report: {
    phase: "dave-ready";
    state: "ready-to-join";
    nativeSession: "initialized";
    externalConnectionOpened: false;
    credentialAcquired: false;
  };
  isOpen(): boolean;
  close(): void;
}

interface GatewayEnvelope {
  op: number;
  d: unknown;
  t?: string;
  s?: number | null;
  seq?: number;
}

function defaultSocketFactory(url: string): GatewaySocket {
  if (typeof WebSocket === "undefined") throw new Error("This Node runtime does not provide WebSocket.");
  return new WebSocket(url) as unknown as GatewaySocket;
}

async function resolveOccupiedVoiceTarget(token: string, candidates: readonly DiscordVoiceTarget[]): Promise<DiscordVoiceTarget> {
  const candidateKeys = new Map(candidates.map((target) => [`${target.guildId}:${target.channelId}`, target]));
  return await new Promise<DiscordVoiceTarget>((resolve, reject) => {
    const socket = defaultSocketFactory(DISCORD_GATEWAY_URL);
    const session = new DiscordGatewaySession();
    const occupied = new Map<string, DiscordVoiceTarget>();
    const seenGuilds = new Set<string>();
    let expectedGuilds: number | undefined;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Discord occupied voice target discovery timed out.")), 10_000);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket.close(); } catch { /* best-effort discovery teardown */ }
      session.close();
      if (error) reject(error);
      else if (occupied.size === 1) resolve([...occupied.values()][0]!);
      else reject(new Error("Discord voice target is ambiguous; configure one explicit guild/channel pair."));
    };
    socket.addEventListener("error", () => finish(new Error("Discord occupied voice target discovery failed.")));
    socket.addEventListener("close", () => { if (!settled) finish(new Error("Discord occupied voice target discovery closed early.")); });
    socket.addEventListener("message", (event) => {
      try {
        const envelope = parseEnvelope(event.data);
        if (envelope.op === 10) {
          session.receiveHello();
          socket.send(JSON.stringify(session.identify(token)));
          return;
        }
        if (envelope.op !== 0 || !envelope.d || typeof envelope.d !== "object") return;
        const data = envelope.d as Record<string, unknown>;
        if (envelope.t === "READY") {
          session.receiveReady(readyUserId(data));
          expectedGuilds = Array.isArray(data.guilds) ? data.guilds.length : undefined;
          if (expectedGuilds === 0) finish();
          return;
        }
        if (envelope.t !== "GUILD_CREATE" || typeof data.id !== "string") return;
        seenGuilds.add(data.id);
        if (Array.isArray(data.voice_states)) {
          for (const state of data.voice_states) {
            if (!state || typeof state !== "object") continue;
            const channelId = (state as { channel_id?: unknown }).channel_id;
            if (typeof channelId !== "string") continue;
            const key = `${data.id}:${channelId}`;
            const target = candidateKeys.get(key);
            if (target) occupied.set(key, target);
          }
        }
        if (expectedGuilds !== undefined && seenGuilds.size >= expectedGuilds) finish();
      } catch (error) { finish(error as Error); }
    });
  });
}

function parseEnvelope(value: unknown): GatewayEnvelope {
  const text = typeof value === "string" ? value : String(value);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("Discord Gateway sent a non-object payload.");
  const envelope = parsed as Partial<GatewayEnvelope>;
  if (!Number.isInteger(envelope.op)) throw new Error("Discord Gateway payload has no valid opcode.");
  return envelope as GatewayEnvelope;
}

function heartbeatInterval(value: unknown): number {
  if (!value || typeof value !== "object") throw new Error("Discord Gateway Hello has no heartbeat interval.");
  const interval = (value as { heartbeat_interval?: unknown }).heartbeat_interval;
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new Error("Discord Gateway Hello has an invalid heartbeat interval.");
  return interval;
}

function readyUserId(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("Discord Gateway Ready has no data.");
  const userId = (value as { user?: { id?: unknown } }).user?.id;
  if (typeof userId !== "string" || userId.length === 0) throw new Error("Discord Gateway Ready has no bot user ID.");
  return userId;
}

async function resolveUniqueVoiceTarget(token: string): Promise<DiscordVoiceTarget> {
  const gateway = await fetch("https://discord.com/api/v10/users/@me/guilds", {
    headers: { authorization: `Bot ${token}` },
  });
  if (!gateway.ok) throw new Error("Discord guild discovery failed.");
  const guilds = await gateway.json() as Array<{ id?: unknown }>;
  const targets: DiscordVoiceTarget[] = [];
  for (const guild of guilds) {
    if (typeof guild.id !== "string" || !/^\d{17,20}$/.test(guild.id)) continue;
    const response = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/channels`, {
      headers: { authorization: `Bot ${token}` },
    });
    if (!response.ok) throw new Error("Discord voice-channel discovery failed.");
    const channels = await response.json() as Array<{ id?: unknown; type?: unknown }>;
    for (const channel of channels) {
      if ((channel.type === 2 || channel.type === 13) && typeof channel.id === "string" && /^\d{17,20}$/.test(channel.id)) {
        targets.push({ guildId: guild.id, channelId: channel.id });
      }
    }
  }
  if (targets.length === 1) return targets[0]!;
  if (targets.length > 1) return await resolveOccupiedVoiceTarget(token, targets);
  throw new Error("Discord has no accessible voice target.");
}

function voiceEndpoint(endpoint: string): string {
  const host = endpoint.replace(/^wss?:\/\//, "").replace(/\?.*$/, "").replace(/\/$/, "");
  if (!host || /[^a-zA-Z0-9.:-]/.test(host)) throw new Error("Discord Voice Gateway endpoint is invalid.");
  return `wss://${host}/?v=8`;
}

function parseVoiceReady(value: unknown): { ip: string; port: number; ssrc: number; modes: string[] } {
  if (!value || typeof value !== "object") throw new Error("Discord Voice Ready has no data.");
  const { ip, port, ssrc, modes } = value as { ip?: unknown; port?: unknown; ssrc?: unknown; modes?: unknown };
  if (typeof ip !== "string" || !Number.isInteger(port) || !Number.isInteger(ssrc) || !Array.isArray(modes) || modes.some((mode) => typeof mode !== "string")) {
    throw new Error("Discord Voice Ready has an invalid UDP endpoint.");
  }
  return { ip, port: port as number, ssrc: ssrc as number, modes: modes as string[] };
}

export async function discoverUdpAddress(ip: string, port: number, ssrc: number, timeoutMs: number): Promise<DiscoveredUdpAddress> {
  if (!ip || !Number.isInteger(port) || port <= 0 || port > 65_535 || !Number.isInteger(ssrc) || ssrc <= 0) {
    throw new Error("Discord UDP discovery input is invalid.");
  }
  return new Promise<DiscoveredUdpAddress>((resolve, reject) => {
    const socket = createSocket("udp4");
    const packet = Buffer.alloc(74);
    packet.writeUInt16BE(1, 0);
    packet.writeUInt16BE(70, 2);
    packet.writeUInt32BE(ssrc, 4);
    let settled = false;
    const finish = (error?: Error, result?: DiscoveredUdpAddress): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error || !result) socket.close();
      error ? reject(error) : result ? resolve(result) : reject(new Error("Discord UDP discovery produced no result."));
    };
    const timer = setTimeout(() => finish(new Error("Discord UDP discovery timed out.")), timeoutMs);
    socket.once("error", () => finish(new Error("Discord UDP discovery transport failed.")));
    socket.once("message", (response) => {
      try {
        if (response.length !== 74 || response.readUInt16BE(0) !== 2 || response.readUInt16BE(2) !== 70 || response.readUInt32BE(4) !== ssrc) {
          throw new Error("Discord UDP discovery response is invalid.");
        }
        const addressEnd = response.indexOf(0, 8);
        const address = response.subarray(8, addressEnd < 0 ? 72 : addressEnd).toString("utf8");
        const discoveredPort = response.readUInt16BE(72);
        if (!address || discoveredPort <= 0) throw new Error("Discord UDP discovery response is incomplete.");
        finish(undefined, {
          address,
          port: discoveredPort,
          media: {
            send: (mediaPacket) => new Promise<void>((resolveSend, rejectSend) =>
              socket.send(mediaPacket, port, ip, (error) => error ? rejectSend(error) : resolveSend())),
            inject: (mediaPacket) => new Promise<void>((resolveInject, rejectInject) => {
              const local = socket.address();
              if (typeof local === "string") return rejectInject(new Error("Discord UDP receive socket has no IPv4 injection address."));
              const injector = createSocket("udp4");
              injector.send(mediaPacket, local.port, "127.0.0.1", (error) => {
                injector.close();
                error ? rejectInject(error) : resolveInject();
              });
            }),
            onFrame: (listener) => { socket.on("message", (message) => listener(Uint8Array.from(message))); },
            close: () => socket.close(),
          },
        });
      } catch (error) { finish(error as Error); }
    });
    socket.send(packet, port, ip, (error) => { if (error) finish(new Error("Discord UDP discovery send failed.")); });
  });
}

function parseSessionDescription(value: unknown): { mode: string; secret_key: number[]; dave_protocol_version: number } {
  if (!value || typeof value !== "object") throw new Error("Discord Session Description has no data.");
  const { mode, secret_key, dave_protocol_version } = value as { mode?: unknown; secret_key?: unknown; dave_protocol_version?: unknown };
  if (typeof mode !== "string" || !Array.isArray(secret_key) || secret_key.length !== 32 ||
      secret_key.some((byte) => !Number.isInteger(byte) || Number(byte) < 0 || Number(byte) > 255) ||
      !Number.isInteger(dave_protocol_version) || Number(dave_protocol_version) <= 0) {
    throw new Error("Discord Session Description is invalid or attempted plaintext fallback.");
  }
  return { mode, secret_key: secret_key as number[], dave_protocol_version: Number(dave_protocol_version) };
}

function parsePrepareEpoch(value: unknown): { epoch: string; protocolVersion: number } {
  if (!value || typeof value !== "object") throw new Error("DAVE Prepare Epoch has no data.");
  const { epoch, protocol_version } = value as { epoch?: unknown; protocol_version?: unknown };
  if ((typeof epoch !== "string" && !Number.isSafeInteger(epoch)) || !Number.isSafeInteger(protocol_version) || Number(protocol_version) <= 0) {
    throw new Error("DAVE Prepare Epoch payload is invalid.");
  }
  const normalizedEpoch = String(epoch);
  if (!/^\d+$/.test(normalizedEpoch) || BigInt(normalizedEpoch) <= 0n) throw new Error("DAVE Prepare Epoch payload is invalid.");
  return { epoch: normalizedEpoch, protocolVersion: Number(protocol_version) };
}

export function prepareDaveEpoch(
  session: Pick<OfficialLibdaveNativeReadySession, "maxProtocolVersion" | "configure" | "setProtocolVersion" | "setExternalSender" | "createKeyPackage">,
  prepare: { readonly epoch: string; readonly protocolVersion: number },
  groupId: string,
  selfUserId: string,
  externalSender?: Uint8Array,
): Uint8Array | null {
  if (!/^\d+$/.test(prepare.epoch) || BigInt(prepare.epoch) <= 0n ||
      !Number.isSafeInteger(prepare.protocolVersion) || prepare.protocolVersion <= 0 ||
      prepare.protocolVersion > session.maxProtocolVersion) {
    throw new Error("DAVE Prepare Epoch requests an invalid epoch or protocol version.");
  }
  if (prepare.epoch === "1") {
    session.configure(groupId, selfUserId);
    session.setProtocolVersion(prepare.protocolVersion);
    if (externalSender) session.setExternalSender(externalSender);
    return session.createKeyPackage();
  }
  session.setProtocolVersion(prepare.protocolVersion);
  return null;
}

function decodeTransitionBinaryPayload(payload: Uint8Array): { transitionId: number; message: Uint8Array } {
  if (payload.length < 3) throw new Error("DAVE transition binary payload is truncated.");
  return { transitionId: (payload[0]! << 8) | payload[1]!, message: payload.slice(2) };
}

function parseTransitionId(value: unknown): number {
  const transitionId = value && typeof value === "object" ? (value as { transition_id?: unknown }).transition_id : undefined;
  if (!Number.isSafeInteger(transitionId) || Number(transitionId) < 0 || Number(transitionId) > 65_535) throw new Error("DAVE transition ID is invalid.");
  return Number(transitionId);
}

/**
 * Opens the real Discord main Gateway and proves only the authenticated Ready
 * phase. It deliberately does not request voice state or send media; those are
 * the following product requirements. The credential is leased and never returned or
 * written to output.
 */
export async function runGatewayReadySmoke(options: GatewayReadySmokeOptions = {}): Promise<{ phase: "gateway-ready"; state: "pass" }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer.");
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const credentialProvider = options.credentialProvider ?? createDiscordBotCredentialProvider();

  return useCredential(credentialProvider, async (token) => new Promise((resolve, reject) => {
    const session = new DiscordGatewaySession();
    let socket: GatewaySocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket?.close(); } catch { /* socket is best-effort during teardown */ }
      session.close();
      if (error) reject(error);
      else resolve({ phase: "gateway-ready", state: "pass" });
    };

    try {
      socket = socketFactory(DISCORD_GATEWAY_URL);
      timer = setTimeout(() => finish(new Error("Timed out before Discord Gateway Ready.")), timeoutMs);
      socket.addEventListener("error", () => finish(new Error("Discord Gateway connection failed.")));
      socket.addEventListener("close", () => {
        if (!settled) finish(new Error("Discord Gateway closed before Ready."));
      });
      socket.addEventListener("message", (event) => {
        try {
          const payload = parseEnvelope(event.data);
          if (payload.op === 10) {
            heartbeatInterval(payload.d);
            session.receiveHello();
            socket?.send(JSON.stringify(session.identify(token)));
            return;
          }
          if (payload.op === 0 && payload.t === "READY") {
            session.receiveReady(readyUserId(payload.d));
            finish();
            return;
          }
          if (payload.op === 9) finish(new Error("Discord Gateway rejected the Identify payload."));
        } catch (error) {
          finish(error as Error);
        }
      });
    } catch (error) {
      finish(error as Error);
    }
  }));
}

export async function runVoiceLeave(options: VoiceLeaveOptions = {}): Promise<{ phase: "voice-leave"; state: "pass" }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const settleMs = options.settleMs ?? 750;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer.");
  if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 5_000) throw new Error("settleMs is invalid.");
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const credentialProvider = options.credentialProvider ?? createDiscordBotCredentialProvider();
  const target = options.target ?? loadDiscordVoiceTarget();

  return useCredential(credentialProvider, async (token) => new Promise((resolve, reject) => {
    const session = new DiscordGatewaySession();
    let socket: GatewaySocket | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (settle) clearTimeout(settle);
      try { socket?.close(); } catch { /* best-effort */ }
      session.close();
      error ? reject(error) : resolve({ phase: "voice-leave", state: "pass" });
    };
    try {
      socket = socketFactory(DISCORD_GATEWAY_URL);
      timeout = setTimeout(() => finish(new Error("Timed out before Discord voice-state reset.")), timeoutMs);
      socket.addEventListener("error", () => finish(new Error("Discord Gateway connection failed during voice-state reset.")));
      socket.addEventListener("close", () => { if (!settled) finish(new Error("Discord Gateway closed before voice-state reset.")); });
      socket.addEventListener("message", (event) => {
        try {
          const payload = parseEnvelope(event.data);
          if (payload.op === 10) {
            heartbeatInterval(payload.d);
            session.receiveHello();
            socket?.send(JSON.stringify(session.identify(token)));
          } else if (payload.op === 0 && payload.t === "READY") {
            session.receiveReady(readyUserId(payload.d));
            socket?.send(JSON.stringify({ op: 4, d: { guild_id: target.guildId, channel_id: null, self_mute: false, self_deaf: false } }));
            settle = setTimeout(() => finish(), settleMs);
          } else if (payload.op === 9) finish(new Error("Discord Gateway rejected voice-state reset Identify."));
        } catch (error) { finish(error as Error); }
      });
    } catch (error) { finish(error as Error); }
  }));
}

export async function runUdpDiscoverySmoke(options: UdpDiscoverySmokeOptions = {}): Promise<{ phase: "udp-discovery"; state: "pass" }> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer.");
  const holdAfterDiscoveryMs = options.holdAfterDiscoveryMs ?? 0;
  if (!Number.isSafeInteger(holdAfterDiscoveryMs) || holdAfterDiscoveryMs < 0 || holdAfterDiscoveryMs > 60_000) {
    throw new Error("holdAfterDiscoveryMs must be an integer between 0 and 60000.");
  }
  const socketFactory = options.socketFactory ?? defaultSocketFactory;
  const udpDiscovery = options.udpDiscovery ?? discoverUdpAddress;
  if (options.signal?.aborted) throw new Error("Discord live-call was stopped explicitly before start.");
  if (options.liveCallWait && options.audioRoundTripProbe && !options.meetronDirectAudio && !options.codexVoiceBrain) {
    throw new Error("Product live-call requires one exact-session audio route before credential or network activity.");
  }

  return useCredential(options.credentialProvider ?? createDiscordBotCredentialProvider(), async (token) => {
    let target = options.target;
    if (!target) {
      const hasGuild = Boolean(process.env.CODEX_BRIDGE_DISCORD_GUILD_ID);
      const hasChannel = Boolean(process.env.CODEX_BRIDGE_DISCORD_VOICE_CHANNEL_ID);
      if (hasGuild || hasChannel) target = loadDiscordVoiceTarget();
      else target = await (options.targetResolver ?? resolveUniqueVoiceTarget)(token);
    }

    return new Promise((resolve, reject) => {
      const session = new DiscordGatewaySession();
      let mainSocket: GatewaySocket | undefined;
      let voiceSocket: GatewaySocket | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let mainHeartbeat: ReturnType<typeof setInterval> | undefined;
      let voiceHeartbeat: ReturnType<typeof setInterval> | undefined;
      let voiceSequence = -1;
      let sequence: number | null = null;
      let mainSessionId: string | undefined;
      let mainResumeGatewayUrl: string | undefined;
      let mainResumeAttempted = false;
      let mainResuming = false;
      const mainHeartbeatAck = new DiscordHeartbeatAckGate();
      let selfUserId: string | undefined;
      let settled = false;
      let protocolSelected = false;
      let nativeDave: OfficialLibdaveNativeReadySession | undefined;
      let externalSender: Uint8Array | undefined;
      let pendingTransitionId: number | undefined;
      let preparedEpoch: string | undefined;
      let keyPackageSent = false;
      let udpMedia: DiscoveredUdpAddress["media"];
      let voiceReady: ReturnType<typeof parseVoiceReady> | undefined;
      let sessionDescription: ReturnType<typeof parseSessionDescription> | undefined;
      const recognizedUserIds = new Set<string>();
      const speakerUserIds = new Map<number, string>();
      const microphoneSpeakingSsrcs = new Set<number>();
      const pendingSpeakingCycleSsrcs = new Set<number>();
      const lastSpeakerSsrcByUser = new Map<string, number>();
      const selectedReceiveRatchets = new Map<number, string>();
      let mediaTransport: DiscordAesRtpTransport | undefined;
      let unsubscribeCodexOutput: (() => void) | undefined;
      let unsubscribeBargeIn: (() => void) | undefined;
      let outputEpoch = 0;
      let outputPcmRemainder = new Int16Array();
      let outputSendChain = Promise.resolve();
      let codecQualityObserved = false;
      let rtpSendEvidenceObserved = false;
      let previousOutboundSequence: number | undefined;
      let previousOutboundTimestamp: number | undefined;
      let responseNormalizationGain = 1;
      const liveTurnGate = new LiveAudioTurnGate();
      const outputSpeechGate = new LiveOutputSpeechGate();
      let liveInputSequence = 0;
      let liveInputEndTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingOpusFlushTimer: ReturnType<typeof setTimeout> | undefined;
      let liveMediaStarted = false;
      let abortListener: (() => void) | undefined;
      let voiceResumeAttempted = false;
      let voiceResuming = false;
      const voiceHeartbeatAck = new DiscordHeartbeatAckGate();
      const outboundCodec = options.opusCodec ?? new DiscordJsOpusCodec();
      const inboundCodecs = new Map<number, OpusCodec>();

      const ensureMediaRatchet = (userId: string, ssrc: number): void => {
        if (!nativeDave) throw new Error("Discord DAVE session is not active.");
        if (selectMediaRatchetOnce(selectedReceiveRatchets, (id, mediaSsrc) => nativeDave!.selectMediaRatchet(id, mediaSsrc), userId, ssrc)) {
          options.onLiveStage?.("dave-ratchet-selected");
        }
      };

      const sendPipelinePcm = async (responsePcm: PcmAudioFrame): Promise<void> => {
        if (!voiceReady || !udpMedia || !nativeDave || !mediaTransport) throw new Error("Audio output has no active Discord DAVE media transport.");
        const configuredGain = typeof options.outputGainLinear === "function" ? options.outputGainLinear() : options.outputGainLinear;
        const baselineOutput = applyDiscordOutputGain(responsePcm.samples, configuredGain ?? DEFAULT_OUTPUT_GAIN_LINEAR);
        const baselineLevel = measurePcmLevel(baselineOutput.samples);
        const speechDetected = isConversationPcm(baselineLevel);
        const turnDecision = liveTurnGate.observeOutput(speechDetected);
        const mediaDecision = outputSpeechGate.observe(speechDetected);
        if (mediaDecision.ended) {
          responseNormalizationGain = 1;
          options.onLiveOutputLevel?.(baselineLevel);
          options.onLiveOutputQuality?.({ ...baselineLevel, ...measurePcmQuality(baselineOutput.samples), accepted: false, normalizationGain: 1 });
          await sendDiscordSpeakingEnd(mediaTransport, udpMedia, voiceSocket!, voiceReady.ssrc);
          options.onLiveStage?.("silence-tail-sent");
          options.onLiveStage?.("speaking-stopped");
          return;
        }
        if (!mediaDecision.accept) {
          options.onLiveOutputLevel?.(baselineLevel);
          options.onLiveOutputQuality?.({ ...baselineLevel, ...measurePcmQuality(baselineOutput.samples), accepted: false, normalizationGain: 1 });
          return;
        }
        if (mediaDecision.started) responseNormalizationGain = calculateResponseNormalizationGain(responsePcm.samples);
        const normalized = applyResponseNormalization(responsePcm.samples, responseNormalizationGain);
        const safeOutput = applyDiscordOutputGain(normalized, configuredGain ?? DEFAULT_OUTPUT_GAIN_LINEAR);
        const outputLevel = measurePcmLevel(safeOutput.samples);
        options.onLiveOutputLevel?.(outputLevel);
        options.onLiveOutputQuality?.({
          ...outputLevel,
          ...measurePcmQuality(safeOutput.samples),
          accepted: true,
          normalizationGain: responseNormalizationGain,
        });
        if (turnDecision.responseStarted && turnDecision.sequence !== undefined) {
          options.onLiveTurnGateEvidence?.({ state: "response-started", inputSequence: turnDecision.sequence });
        }
        // Response-scoped normalization is stable for the whole utterance;
        // output gain and the true-peak limiter remain the final amplitude
        // stage. Never normalize individual Opus packets.
        const outputPcm = { ...responsePcm, samples: safeOutput.samples };
        const epoch = outputEpoch;
        const codec = outboundCodec;
        if (mediaDecision.started) {
          voiceSocket?.send(JSON.stringify({ op: 5, d: { speaking: 1, delay: 0, ssrc: voiceReady.ssrc } }));
        }
        ensureMediaRatchet(selfUserId!, voiceReady.ssrc);
        const samplesPerPacket = 960 * 2;
        let packetCount = 0;
        let lastOpus = new Uint8Array();
        let lastPacket = new Uint8Array();
        for (let offset = 0; offset < outputPcm.samples.length; offset += samplesPerPacket) {
          if (epoch !== outputEpoch) break;
          const samples = new Int16Array(samplesPerPacket);
          samples.set(outputPcm.samples.subarray(offset, Math.min(offset + samplesPerPacket, outputPcm.samples.length)));
          lastOpus = codec.encode({ samples, sampleRate: 48_000, channels: 2 });
          if (!codecQualityObserved) {
            codecQualityObserved = true;
            const decoded = codec.decode(lastOpus);
            options.onLiveCodecQuality?.({
              opusBytes: lastOpus.length,
              inputLevel: measurePcmLevel(samples),
              outputLevel: measurePcmLevel(decoded.samples),
              inputQuality: measurePcmQuality(samples),
              outputQuality: measurePcmQuality(decoded.samples),
            });
          }
          lastPacket = mediaTransport.encode(lastOpus);
          await udpMedia.send(lastPacket);
          const packet = Buffer.from(lastPacket);
          const packetSequence = packet.readUInt16BE(2);
          const packetTimestamp = packet.readUInt32BE(4);
          if (!rtpSendEvidenceObserved && previousOutboundSequence !== undefined && previousOutboundTimestamp !== undefined) {
            rtpSendEvidenceObserved = true;
            options.onLiveRtpSendEvidence?.({
              speakingActive: true,
              daveEncrypted: lastPacket.length > lastOpus.length,
              destinationConfigured: true,
              selfSsrcMatched: packet.readUInt32BE(8) === voiceReady.ssrc,
              sequenceAdvancedByOne: packetSequence === ((previousOutboundSequence + 1) & 0xffff),
              timestampAdvancedBy960: packetTimestamp === ((previousOutboundTimestamp + 960) >>> 0),
            });
          }
          previousOutboundSequence = packetSequence;
          previousOutboundTimestamp = packetTimestamp;
          packetCount += 1;
          if (offset + samplesPerPacket < outputPcm.samples.length) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
        }
        if (packetCount > 0) options.onLiveResponse?.({ pcmSamples: outputPcm.samples.length, responseOpusBytes: lastOpus.length, packetBytes: lastPacket.length, packets: packetCount, inputSequence: turnDecision.sequence ?? liveInputSequence });
      };
      const queuePipelinePcm = (frame: PcmAudioFrame): Promise<void> => {
        const packetized = packetizeDiscordPcm(outputPcmRemainder, frame.samples);
        outputPcmRemainder = packetized.remainder;
        for (const samples of packetized.packets) {
          outputSendChain = outputSendChain.then(() => sendPipelinePcm({ samples, sampleRate: 48_000, channels: 2 }));
        }
        outputSendChain.catch(finish);
        return outputSendChain;
      };
      options.meetronDirectAudio?.setConferencePcmSink(async (frame) => {
        options.onLiveStage?.("meetron-chatgpt-output");
        void queuePipelinePcm(frame);
      });

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (liveInputEndTimer) clearTimeout(liveInputEndTimer);
        if (pendingOpusFlushTimer) clearTimeout(pendingOpusFlushTimer);
        if (mainHeartbeat) clearInterval(mainHeartbeat);
        if (voiceHeartbeat) clearInterval(voiceHeartbeat);
        if (abortListener) options.signal?.removeEventListener("abort", abortListener);
        try { mainSocket?.close(); } catch { /* best-effort teardown */ }
        try { voiceSocket?.close(); } catch { /* best-effort teardown */ }
        try { nativeDave?.close(); } catch { /* best-effort teardown */ }
        try { udpMedia?.close(); } catch { /* best-effort teardown */ }
        unsubscribeCodexOutput?.();
        unsubscribeBargeIn?.();
        void options.meetronDirectAudio?.close().catch(() => {});
        session.close();
        error ? reject(error) : resolve({ phase: "udp-discovery", state: "pass" });
      };
      abortListener = () => finish(new Error("Discord live-call was stopped explicitly."));
      options.signal?.addEventListener("abort", abortListener, { once: true });

      const openVoiceGateway = (handoff: VoiceGatewayHandoff, resume = false): void => {
        try {
          // Opening a websocket is not Discord Voice Ready. Only a resumed
          // session or Opcode 2 below may publish a joined state.
          if (resume) options.onLiveStage?.("voice-resume-attempt");
          const socket = socketFactory(voiceEndpoint(handoff.endpoint));
          voiceSocket = socket;
          voiceHeartbeatAck.reset();
          socket.binaryType = "arraybuffer";
          socket.addEventListener("error", () => finish(new Error("Discord Voice Gateway connection failed.")));
          socket.addEventListener("close", (event) => {
            if (voiceSocket !== socket) return;
            if (!settled) {
              if (liveMediaStarted && !voiceResumeAttempted) {
                voiceResumeAttempted = true;
                voiceResuming = true;
                if (voiceHeartbeat) clearInterval(voiceHeartbeat);
                voiceHeartbeat = undefined;
                openVoiceGateway(handoff, true);
                return;
              }
              const code = Number.isInteger(event.code) ? ` (code ${event.code})` : "";
              finish(new Error(`Discord Voice Gateway resume failed closed${code}.`));
            }
          });
          socket.addEventListener("message", (event) => {
            try {
              if (typeof event.data !== "string") {
                if (!options.sessionDescriptionProbe || !nativeDave) {
                  throw new Error("Discord sent a binary Voice payload before native DAVE initialization.");
                }
                if (!(event.data instanceof ArrayBuffer) && !(event.data instanceof Uint8Array)) {
                  throw new Error("Discord sent an unsupported binary Voice payload type.");
                }
                const binary = decodeServerBinaryVoiceEnvelope(event.data);
                voiceSequence = binary.sequence;
                if (binary.op === 25) {
                  externalSender = binary.payload.slice();
                  nativeDave.setExternalSender(binary.payload);
                  options.onLiveStage?.("dave-external-sender-received");
                } else if (binary.op === 27) {
                  options.onLiveStage?.("dave-proposals-received");
                  const commitWelcome = nativeDave.processProposals(binary.payload, [...recognizedUserIds]);
                  if (commitWelcome) {
                    voiceSocket?.send(encodeClientBinaryVoiceEnvelope(28, commitWelcome));
                    options.onLiveStage?.("dave-commit-welcome-sent");
                  }
                } else if (binary.op === 29 || binary.op === 30) {
                  options.onLiveStage?.(binary.op === 29 ? "dave-commit-received" : "dave-welcome-received");
                  const transition = decodeTransitionBinaryPayload(binary.payload);
                  const result = binary.op === 29
                    ? nativeDave.processCommit(transition.message)
                    : nativeDave.processWelcome(transition.message, [...recognizedUserIds]);
                  if (result === "accepted") {
                    // libdave media-ratchet selections are scoped to the
                    // accepted MLS epoch. Re-select each SSRC once on demand.
                    selectedReceiveRatchets.clear();
                    options.onLiveStage?.("dave-epoch-active");
                    if (transition.transitionId === 0 && !liveMediaStarted) {
                      liveMediaStarted = true;
                      options.onDaveActive?.({ transitionId: transition.transitionId });
                      if (options.liveCallWait && options.meetronDirectAudio) {
                        void options.meetronDirectAudio.start()
                          .then(() => options.onLiveCallReady?.())
                          .catch(finish);
                      } else if (options.liveCallWait) {
                        const brain = options.codexVoiceBrain!;
                        const codec = outboundCodec;
                        unsubscribeCodexOutput = brain.onOutputAudio(async (responsePcm) => {
                          if (!voiceReady || !udpMedia || !nativeDave || !mediaTransport) throw new Error("Codex output has no active Discord DAVE media transport.");
                          options.onLiveStage?.("codex-realtime-output");
                          const outputLevel = measurePcmLevel(responsePcm.samples);
                          options.onLiveOutputLevel?.(outputLevel);
                          if (outputLevel.nonSilentSamples === 0) return;
                          const epoch = outputEpoch;
                          voiceSocket?.send(JSON.stringify({ op: 5, d: { speaking: 1, delay: 0, ssrc: voiceReady.ssrc } }));
                          ensureMediaRatchet(selfUserId!, voiceReady.ssrc);
                          const samplesPerPacket = 960 * 2;
                          let packetCount = 0;
                          let lastOpus = new Uint8Array();
                          let lastPacket = new Uint8Array();
                          for (let offset = 0; offset < responsePcm.samples.length; offset += samplesPerPacket) {
                            if (epoch !== outputEpoch) break;
                            const samples = new Int16Array(samplesPerPacket);
                            samples.set(responsePcm.samples.subarray(offset, Math.min(offset + samplesPerPacket, responsePcm.samples.length)));
                            lastOpus = codec.encode({ samples, sampleRate: 48_000, channels: 2 });
                            lastPacket = mediaTransport.encode(lastOpus);
                            await udpMedia.send(lastPacket);
                            packetCount += 1;
                            if (offset + samplesPerPacket < responsePcm.samples.length) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
                          }
                          if (packetCount > 0) {
                            options.onLiveResponse?.({ pcmSamples: responsePcm.samples.length, responseOpusBytes: lastOpus.length, packetBytes: lastPacket.length, packets: packetCount });
                          }
                        });
                        unsubscribeBargeIn = brain.onBargeIn(async () => {
                          outputEpoch += 1;
                          options.onLiveStage?.("speech-started");
                          if (mediaTransport && udpMedia && voiceReady) {
                            outputSendChain = outputSendChain.then(async () => {
                              await sendDiscordSpeakingEnd(mediaTransport!, udpMedia!, voiceSocket!, voiceReady!.ssrc);
                              options.onLiveStage?.("silence-tail-sent");
                              options.onLiveStage?.("speaking-stopped");
                            });
                          }
                        });
                        const activate = brain.state === "active"
                          ? Promise.resolve()
                          : brain.state === "failed"
                          ? brain.reconnect().then(() => brain.waitUntilActive())
                          : brain.start().then(() => brain.waitUntilActive());
                        void activate.then(() => options.onLiveCallReady?.()).catch(finish);
                      }
                      if (options.sendToneProbe) {
                        if (!voiceReady || !sessionDescription || !udpMedia) return finish(new Error("DAVE tone send has no live UDP transport."));
                        nativeDave.selectMediaRatchet(selfUserId!, voiceReady.ssrc);
                        voiceSocket?.send(JSON.stringify({ op: 5, d: { speaking: 1, delay: 0, ssrc: voiceReady.ssrc } }));
                        const transport = mediaTransport = new DiscordAesRtpTransport({
                          secretKey: Uint8Array.from(sessionDescription.secret_key),
                          ssrc: voiceReady.ssrc,
                          mode: sessionDescription.mode,
                          dave: nativeDave as DaveSession,
                        });
                        const tone = Uint8Array.from(Buffer.from("7881a75d6c7e40e600000a3f644cfde7b45933264f56f15dbdc8a3ee57a565cb7563ae7dbef27d9e7c6c7232420d1fbcd53719a897a71830f205bd757d24b4c81e3926d5a1aa751ed003", "hex"));
                        const packet = transport.encode(tone);
                        void udpMedia.send(packet).then(() => { options.onToneSent?.({ packetBytes: packet.length }); finish(); }, finish);
                      } else if (options.receiveOpusProbe || options.audioRoundTripProbe) {
                        if (!voiceReady || !sessionDescription || !udpMedia) return finish(new Error("DAVE Opus receive has no live UDP transport."));
                        if (!udpMedia.inject) return finish(new Error("DAVE Opus receive transport cannot inject an authenticated probe."));
                        const transport = mediaTransport = new DiscordAesRtpTransport({
                          secretKey: Uint8Array.from(sessionDescription.secret_key), ssrc: voiceReady.ssrc,
                          mode: sessionDescription.mode, dave: nativeDave as DaveSession,
                        });
                        const fallbackCodec = options.audioRoundTripProbe ? options.opusCodec : undefined;
                        let decodeInFlight = false;
                        let inputRouteEvidenceObserved = false;
                        const codexInputRoute = new SingleFlightCodexInputRoute();
                        const pendingOpus: Uint8Array[] = [];
                        udpMedia.onFrame((packet) => {
                          void (async () => {
                          try {
                            if (packet.length < 12) return;
                            const ssrc = Buffer.from(packet).readUInt32BE(8);
                            const speaker = resolveIncomingSpeaker(speakerUserIds, selectedReceiveRatchets, recognizedUserIds, selfUserId!, voiceReady!.ssrc, ssrc, Boolean(options.liveCallWait));
                            if (!speaker) return;
                            const userId = speaker.userId;
                            if (speaker.inferred && options.liveCallWait) {
                              options.onLiveStage?.(observeSpeakerSsrc(lastSpeakerSsrcByUser, userId, ssrc));
                            } else {
                              lastSpeakerSsrcByUser.set(userId, ssrc);
                            }
                            if (options.liveCallWait) options.onLiveStage?.("udp-received");
                            if (selectedReceiveRatchets.get(ssrc) !== userId) {
                              nativeDave!.selectMediaRatchet(userId, ssrc);
                              selectedReceiveRatchets.set(ssrc, userId);
                            }
                            const frame = transport.decode(packet);
                            if (options.liveCallWait) options.onLiveStage?.("dave-decrypted");
                            if (options.audioRoundTripProbe) {
                              const codec = fallbackCodec ?? (() => {
                                const existing = inboundCodecs.get(ssrc);
                                if (existing) return existing;
                                const created = new DiscordJsOpusCodec();
                                inboundCodecs.set(ssrc, created);
                                return created;
                              })();
                              if (options.liveCallWait && codec.decodeBatchAsync) {
                                pendingOpus.push(frame.opus.slice());
                                if (pendingOpusFlushTimer) clearTimeout(pendingOpusFlushTimer);
                                pendingOpusFlushTimer = setTimeout(() => pendingOpus.splice(0), 300);
                                pendingOpusFlushTimer.unref?.();
                                if (decodeInFlight || pendingOpus.length < 10) return;
                              } else if (options.liveCallWait && decodeInFlight) return;
                              decodeInFlight = true;
                              try {
                                const inputPcm = options.liveCallWait && codec.decodeBatchAsync
                                  ? await codec.decodeBatchAsync(pendingOpus.splice(0, 10))
                                  : codec.decodeAsync ? await codec.decodeAsync(frame.opus) : codec.decode(frame.opus);
                                const inputLevel = measurePcmLevel(inputPcm.samples);
                                const conversationInput = microphoneSpeakingSsrcs.has(ssrc);
                                if (options.liveCallWait) options.onLiveInputLevel?.(inputLevel);
                                if (options.liveCallWait && conversationInput) {
                                  const gateInput = liveTurnGate.inputStarted(pendingSpeakingCycleSsrcs.delete(ssrc));
                                  liveInputSequence = gateInput.sequence;
                                  if (gateInput.started || gateInput.resumed) {
                                    outputEpoch += 1;
                                    outputPcmRemainder = new Int16Array();
                                    options.onLiveTurnGateEvidence?.({
                                      state: gateInput.started ? "input-started" : "input-resumed",
                                      inputSequence: liveInputSequence,
                                    });
                                    if (gateInput.started) options.liveInputConfirmation?.begin(liveInputSequence);
                                  }
                                  if (liveInputEndTimer) clearTimeout(liveInputEndTimer);
                                  liveInputEndTimer = setTimeout(() => {
                                    const endingSequence = liveInputSequence;
                                    liveTurnGate.inputEnded();
                                    options.onLiveTurnGateEvidence?.({ state: "input-ended", inputSequence: endingSequence });
                                    const confirmation = options.liveInputConfirmation?.confirm(endingSequence) ?? Promise.resolve(true);
                                    void confirmation.then((confirmed) => {
                                      if (!confirmed) return;
                                      const decision = liveTurnGate.confirmInput(endingSequence);
                                      if (decision.confirmed) options.onLiveTurnGateEvidence?.({ state: "input-confirmed", inputSequence: decision.sequence });
                                    }).catch(() => undefined);
                                  }, 700);
                                  liveInputEndTimer.unref?.();
                                }
                                if (options.liveCallWait) options.onLiveStage?.("pcm-generated");
                                if (options.liveCallWait) {
                                  if (options.meetronDirectAudio) {
                                    const normalized = conversationInput && isConversationInputPcm(inputLevel);
                                    const routedPcm = normalized
                                      ? { ...inputPcm, samples: normalizeConversationPcm(inputPcm.samples, inputLevel) }
                                      : conversationInput
                                      ? inputPcm
                                      : { ...inputPcm, samples: new Int16Array(inputPcm.samples.length) };
                                    await options.meetronDirectAudio.sendConferencePcm(routedPcm);
                                    if (!inputRouteEvidenceObserved && conversationInput) {
                                      inputRouteEvidenceObserved = true;
                                      const routedLevel = measurePcmLevel(routedPcm.samples);
                                      options.onLiveInputRouteEvidence?.({
                                        pcmSamples: routedPcm.samples.length,
                                        pcmBytes: routedPcm.samples.byteLength,
                                        normalized,
                                        routedRms: routedLevel.rms,
                                        routedPeak: routedLevel.peak,
                                      });
                                    }
                                    options.onLiveStage?.("meetron-chatgpt-input");
                                    return;
                                  }
                                  if (options.codexVoiceBrain!.state !== "active") {
                                    options.onLiveStage?.("reconnecting");
                                    await options.codexVoiceBrain!.reconnect();
                                    await options.codexVoiceBrain!.waitUntilActive();
                                  }
                                  const appended = await codexInputRoute.append(options.codexVoiceBrain!, inputPcm, options.onLiveStage, options.onCodexInputFailure);
                                  if (!appended) throw new Error("Current Codex realtime input append overlapped.");
                                  return;
                                }
                                const adapter = options.codexAudioAdapter ?? new BoundedCodexPcmAdapter();
                                const responsePcm = await adapter.respond(inputPcm);
                                const responseOpus = codec.encode(responsePcm);
                                voiceSocket?.send(JSON.stringify({ op: 5, d: { speaking: 1, delay: 0, ssrc: voiceReady!.ssrc } }));
                                ensureMediaRatchet(selfUserId!, voiceReady!.ssrc);
                                const packetCount = options.liveCallWait ? 25 : 1;
                                let responsePacket: Uint8Array = new Uint8Array();
                                for (let index = 0; index < packetCount; index += 1) {
                                  responsePacket = transport.encode(responseOpus);
                                  await udpMedia!.send(responsePacket);
                                }
                                const evidence = { pcmSamples: inputPcm.samples.length, responseOpusBytes: responseOpus.length, packetBytes: responsePacket.length };
                                options.onAudioRoundTrip?.(evidence);
                              } finally {
                                // Keep decode and exact-task append as one serialized critical section.
                                decodeInFlight = false;
                              }
                            } else options.onOpusReceived?.({ opusBytes: frame.opus.length });
                            if (!options.liveCallWait) finish();
                          } catch (error) {
                            if (options.liveCallWait && options.codexVoiceBrain) {
                              const sanitized = error instanceof Error && /^Current Codex realtime input append failed \[[a-z-]+\]\.$/.test(error.message)
                                ? error
                                : new Error("Current Codex realtime input route failed [unknown].");
                              return finish(sanitized);
                            }
                            if (packet.length >= 12 && Buffer.from(packet).readUInt32BE(8) === voiceReady!.ssrc) finish(error as Error);
                          }
                          })();
                        });
                        ensureMediaRatchet(selfUserId!, voiceReady.ssrc);
                        const probeOpus = Uint8Array.from(Buffer.from("7881a75d6c7e40e600000a3f644cfde7b45933264f56f15dbdc8a3ee57a565cb7563ae7dbef27d9e7c6c7232420d1fbcd53719a897a71830f205bd757d24b4c81e3926d5a1aa751ed003", "hex"));
                        if (!options.liveCallWait) {
                          const probePacket = transport.encode(probeOpus);
                          void udpMedia.inject(probePacket).catch(finish);
                        }
                      } else finish();
                      return;
                    }
                    pendingTransitionId = transition.transitionId;
                    voiceSocket?.send(JSON.stringify({ op: 23, d: { transition_id: transition.transitionId } }));
                    options.onLiveStage?.("dave-transition-ready-sent");
                  } else if (result === "failed") {
                    voiceSocket?.send(JSON.stringify({ op: 31, d: { transition_id: transition.transitionId } }));
                    nativeDave.reset();
                    selectedReceiveRatchets.clear();
                    nativeDave.configure(handoff.channelId, selfUserId!);
                    nativeDave.setProtocolVersion(nativeDave.maxProtocolVersion);
                    if (externalSender) nativeDave.setExternalSender(externalSender);
                    voiceSocket?.send(encodeClientBinaryVoiceEnvelope(26, nativeDave.createKeyPackage()));
                  }
                }
                return;
              }
              const payload = parseEnvelope(event.data);
              if (Number.isInteger(payload.seq)) voiceSequence = Number(payload.seq);
              if (payload.op === 8) {
                const interval = heartbeatInterval(payload.d);
                socket.send(JSON.stringify(resume
                  ? buildVoiceResumePayload(handoff, Math.max(0, voiceSequence))
                  : { op: 0, d: {
                    server_id: handoff.guildId,
                    user_id: handoff.userId,
                    session_id: handoff.sessionId,
                    token: handoff.token,
                    max_dave_protocol_version: 1,
                  } }));
                voiceHeartbeat = setInterval(() => {
                  const nonce = Date.now();
                  if (!voiceHeartbeatAck.begin(nonce)) {
                    socket.close();
                    return;
                  }
                  socket.send(JSON.stringify({ op: 3, d: { t: nonce, seq_ack: voiceSequence } }));
                }, interval);
                return;
              }
              if (payload.op === 6) {
                const nonce = Number(payload.d?.t);
                if (!Number.isSafeInteger(nonce) || !voiceHeartbeatAck.acknowledge(nonce)) {
                  return finish(new Error("Discord Voice Gateway Heartbeat ACK did not match the outstanding nonce."));
                }
                return;
              }
              if (payload.op === 9) {
                if (!voiceResuming) return finish(new Error("Discord Voice Gateway sent an unexpected Resumed event."));
                voiceResuming = false;
                options.onLiveStage?.("voice-resumed");
                return;
              }
              if (payload.op === 2) {
                const ready = parseVoiceReady(payload.d);
                voiceReady = ready;
                options.onLiveStage?.("discord-voice-joined");
                if (selfUserId) speakerUserIds.set(ready.ssrc, selfUserId);
                void udpDiscovery(ready.ip, ready.port, ready.ssrc, timeoutMs).then((discovered) => {
                  udpMedia = discovered.media;
                  if (options.liveCallWait) options.onLiveStage?.("udp-discovered");
                  if (options.sessionDescriptionProbe) {
                    const mode = ["aead_aes256_gcm_rtpsize", "aead_xchacha20_poly1305_rtpsize"]
                      .find((candidate) => ready.modes.includes(candidate));
                    if (!mode) return finish(new Error("Discord Voice Ready offered no supported AEAD RTP transport mode."));
                    protocolSelected = true;
                    voiceSocket?.send(JSON.stringify({ op: 1, d: { protocol: "udp", data: { address: discovered.address, port: discovered.port, mode } } }));
                    return;
                  }
                  if (timer) clearTimeout(timer);
                  if (holdAfterDiscoveryMs > 0) timer = setTimeout(() => finish(), holdAfterDiscoveryMs);
                  else finish();
                }, finish);
                return;
              }
              if (payload.op === 4 && options.sessionDescriptionProbe) {
                if (!protocolSelected) return finish(new Error("Discord Session Description arrived before Select Protocol."));
                const description = parseSessionDescription(payload.d);
                sessionDescription = description;
                options.onLiveStage?.("dave-session-described");
                options.onSessionDescription?.({
                  daveProtocolVersion: description.dave_protocol_version,
                  transportMode: description.mode,
                });
                const addonPath = options.addonPath ?? resolvePath("work/node-native-binding-probe/build/libdave_node_probe.node");
                nativeDave = openOfficialLibdaveNativeReadySession(addonPath, options.addonLoader);
                nativeDave.configure(handoff.channelId, selfUserId!);
                nativeDave.setProtocolVersion(description.dave_protocol_version);
                voiceSocket?.send(encodeClientBinaryVoiceEnvelope(26, nativeDave.createKeyPackage()));
                keyPackageSent = true;
                options.onLiveStage?.("dave-key-package-sent");
                return;
              }
              if (payload.op === 24 && options.sessionDescriptionProbe) {
                if (!nativeDave || !selfUserId) return finish(new Error("DAVE Prepare Epoch arrived before native session initialization."));
                const prepare = parsePrepareEpoch(payload.d);
                options.onLiveStage?.("dave-prepare-epoch-received");
                const keyPackage = prepareDaveEpoch(nativeDave, prepare, handoff.channelId, selfUserId, externalSender);
                preparedEpoch = prepare.epoch;
                if (keyPackage) {
                  voiceSocket?.send(encodeClientBinaryVoiceEnvelope(26, keyPackage));
                  keyPackageSent = true;
                  options.onLiveStage?.("dave-key-package-sent");
                }
                return;
              }
              if (payload.op === 11 && payload.d && typeof payload.d === "object") {
                const ids = (payload.d as { user_ids?: unknown }).user_ids;
                if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !/^\d{1,20}$/.test(id))) {
                  return finish(new Error("Discord Clients Connect contains invalid user IDs."));
                }
                for (const id of ids) recognizedUserIds.add(id);
                if (ids.some((id) => id !== selfUserId)) options.onLiveStage?.("discord-clients-connected");
                return;
              }
              if (payload.op === 13 && payload.d && typeof payload.d === "object") {
                const id = (payload.d as { user_id?: unknown }).user_id;
                if (typeof id === "string") {
                  recognizedUserIds.delete(id);
                  for (const [ssrc, userId] of speakerUserIds) if (userId === id) {
                    microphoneSpeakingSsrcs.delete(ssrc);
                    pendingSpeakingCycleSsrcs.delete(ssrc);
                  }
                  resetParticipantMediaState(speakerUserIds, selectedReceiveRatchets, id);
                  if (id !== selfUserId) options.onLiveStage?.("discord-client-disconnected");
                }
                return;
              }
              if (payload.op === 5 && payload.d && typeof payload.d === "object") {
                const { user_id, ssrc, speaking } = payload.d as { user_id?: unknown; ssrc?: unknown; speaking?: unknown };
                if (typeof user_id === "string" && Number.isSafeInteger(ssrc) && Number(ssrc) > 0 && Number.isSafeInteger(speaking)) {
                  const mediaSsrc = Number(ssrc);
                  const remapped = [...speakerUserIds].some(([previousSsrc, previousUserId]) =>
                    previousUserId === user_id && previousSsrc !== mediaSsrc);
                  if (remapped) {
                    for (const [previousSsrc, previousUserId] of speakerUserIds) if (previousUserId === user_id) {
                      microphoneSpeakingSsrcs.delete(previousSsrc);
                      pendingSpeakingCycleSsrcs.delete(previousSsrc);
                    }
                    resetParticipantMediaState(speakerUserIds, selectedReceiveRatchets, user_id);
                  }
                  speakerUserIds.set(mediaSsrc, user_id);
                  if (isDiscordMicrophoneSpeaking(speaking)) {
                    if (!microphoneSpeakingSsrcs.has(mediaSsrc)) pendingSpeakingCycleSsrcs.add(mediaSsrc);
                    microphoneSpeakingSsrcs.add(mediaSsrc);
                  } else {
                    microphoneSpeakingSsrcs.delete(mediaSsrc);
                    pendingSpeakingCycleSsrcs.delete(mediaSsrc);
                  }
                  if (options.liveCallWait && user_id !== selfUserId) {
                    const observed = observeSpeakerSsrc(lastSpeakerSsrcByUser, user_id, mediaSsrc);
                    options.onLiveStage?.(remapped ? "speaker-ssrc-remapped" : observed);
                  } else {
                    lastSpeakerSsrcByUser.set(user_id, mediaSsrc);
                  }
                }
                return;
              }
              if (payload.op === 22 && options.sessionDescriptionProbe) {
                options.onLiveStage?.("dave-execute-transition-received");
                const transitionId = parseTransitionId(payload.d);
                if (transitionId !== pendingTransitionId) return finish(new Error("DAVE Execute Transition ID does not match the prepared MLS transition."));
                if (!preparedEpoch) return finish(new Error("DAVE Execute Transition has no prepared epoch."));
                preparedEpoch = undefined;
                pendingTransitionId = undefined;
                options.onDaveActive?.({ transitionId });
                if (options.liveCallWait) {
                  if (!liveMediaStarted && options.meetronDirectAudio) {
                    liveMediaStarted = true;
                    void options.meetronDirectAudio.start()
                      .then(() => options.onLiveCallReady?.())
                      .catch(finish);
                  }
                  // Epoch changes are part of a long-lived voice session; an
                  // Execute acknowledgement must not tear down the runner.
                  return;
                }
                finish();
              }
            } catch (error) { finish(error as Error); }
          });
        } catch (error) { finish(error as Error); }
      };

      const openMainGateway = (resume = false): void => {
        try {
          if (mainHeartbeat) clearInterval(mainHeartbeat);
          mainHeartbeat = undefined;
          mainHeartbeatAck.reset();
          const endpoint = resume && mainResumeGatewayUrl
            ? `${mainResumeGatewayUrl.replace(/\/$/, "")}/?v=10&encoding=json`
            : DISCORD_GATEWAY_URL;
          const socket = socketFactory(endpoint);
          mainSocket = socket;
          const recover = (): void => {
            if (settled || mainSocket !== socket) return;
            if (!mainResumeAttempted && mainSessionId && mainResumeGatewayUrl && sequence !== null) {
              mainResumeAttempted = true;
              mainResuming = true;
              try { socket.close(); } catch { /* best-effort transport replacement */ }
              openMainGateway(true);
              return;
            }
            finish(new Error("Discord Gateway Resume failed before voice handoff."));
          };
          socket.addEventListener("error", recover);
          socket.addEventListener("close", () => recover());
          socket.addEventListener("message", (event) => {
            try {
              const payload = parseEnvelope(event.data);
              if (typeof payload.s === "number") sequence = payload.s;
              if (payload.op === 11) {
                if (!mainHeartbeatAck.acknowledge()) return finish(new Error("Discord Gateway sent an unexpected Heartbeat ACK."));
                return;
              }
              if (payload.op === 1) {
                if (!mainHeartbeatAck.begin(null)) return recover();
                socket.send(JSON.stringify({ op: 1, d: sequence }));
                return;
              }
              if (payload.op === 7) return recover();
              if (payload.op === 9) {
                if (payload.d === true) return recover();
                return finish(new Error("Discord Gateway invalidated the session before voice handoff."));
              }
              if (payload.op === 10) {
                const interval = heartbeatInterval(payload.d);
                if (!resume) session.receiveHello();
                socket.send(JSON.stringify(resume
                  ? buildGatewayResumePayload(token, mainSessionId!, sequence!)
                  : session.identify(token)));
                mainHeartbeat = setInterval(() => {
                  if (!mainHeartbeatAck.begin(null)) return recover();
                  socket.send(JSON.stringify({ op: 1, d: sequence }));
                }, interval);
                return;
              }
              if (payload.op === 0 && payload.t === "READY") {
                if (!payload.d || typeof payload.d !== "object") return finish(new Error("Discord Gateway Ready has no resumable session state."));
                const ready = payload.d as { session_id?: unknown; resume_gateway_url?: unknown };
                if (typeof ready.session_id !== "string" || typeof ready.resume_gateway_url !== "string" || !ready.resume_gateway_url.startsWith("wss://")) {
                  return finish(new Error("Discord Gateway Ready has no resumable session state."));
                }
                mainSessionId = ready.session_id;
                mainResumeGatewayUrl = ready.resume_gateway_url;
                selfUserId = readyUserId(payload.d);
                recognizedUserIds.add(selfUserId);
                session.receiveReady(selfUserId);
                socket.send(JSON.stringify(session.requestVoiceState(target!.guildId, target!.channelId)));
                return;
              }
              if (payload.op === 0 && payload.t === "RESUMED") {
                if (!mainResuming) return finish(new Error("Discord Gateway sent an unexpected Resumed event."));
                mainResuming = false;
                return;
              }
              if (payload.op === 0 && payload.t === "VOICE_STATE_UPDATE" && payload.d && typeof payload.d === "object") {
                const d = payload.d as { guild_id?: unknown; channel_id?: unknown; user_id?: unknown; session_id?: unknown };
                if (d.guild_id === target!.guildId && d.channel_id === target!.channelId && d.user_id !== selfUserId && typeof d.session_id === "string") {
                  options.onLiveStage?.("discord-participant-voice-state");
                  return;
                }
                if (d.guild_id !== target!.guildId || d.channel_id !== target!.channelId || d.user_id !== selfUserId || typeof d.session_id !== "string") return;
                options.onLiveStage?.("discord-voice-state-matched");
                if (session.state === "voice-handoff-ready") return;
                const handoff = session.receiveVoiceStateUpdate({ guildId: d.guild_id, channelId: d.channel_id, userId: d.user_id, sessionId: d.session_id });
                if (handoff) openVoiceGateway(handoff);
                return;
              }
              if (payload.op === 0 && payload.t === "VOICE_SERVER_UPDATE" && payload.d && typeof payload.d === "object") {
                const d = payload.d as { guild_id?: unknown; endpoint?: unknown; token?: unknown };
                if (d.guild_id !== target!.guildId || typeof d.token !== "string") return;
                if (session.state === "voice-handoff-ready") return;
                const endpoint = d.endpoint === null || typeof d.endpoint === "string" ? d.endpoint : null;
                const handoff = session.receiveVoiceServerUpdate({ guildId: d.guild_id, endpoint, token: d.token });
                if (handoff) openVoiceGateway(handoff);
              }
            } catch (error) { finish(error as Error); }
          });
        } catch (error) { finish(error as Error); }
      };

      try {
        timer = setTimeout(() => finish(new Error(options.receiveOpusProbe || options.audioRoundTripProbe
          ? "Timed out before a DAVE-decrypted Opus frame was received."
          : "Timed out before Discord UDP discovery.")), timeoutMs);
        openMainGateway();
      } catch (error) { finish(error as Error); }
    });
  });
}

/** Attach Discord audio to the already-owned foreground Codex realtime call. */
export async function runCurrentTaskLiveCall(options: CurrentTaskLiveCallOptions = {}): Promise<{ phase: "udp-discovery"; state: "pass" }> {
  if (options.signal?.aborted) throw new Error("Discord live-call was stopped explicitly before start.");
  const threadId = options.threadId?.trim() || process.env.CODEX_THREAD_ID?.trim();
  if (!threadId || !/^[0-9a-f-]{20,}$/i.test(threadId)) throw new Error("A concrete current Codex thread ID is required before credential or network activity.");
  const attachment = options.existingTaskAudio;
  if (!attachment) throw new Error("A verified non-owning Codex realtime audio attachment is required before credential or network activity.");
  return runWithBoundedRecovery(async () => {
    const preflight = await attachment.verifyExistingSession({
      existingGptLiveProcessId: attachment.desktopProcessId,
      expectedSessionIdentity: attachment.expectedSessionIdentity,
    });
    if (preflight.matches !== true || preflight.voiceActive !== true
      || preflight.processId !== attachment.desktopProcessId
      || preflight.sessionIdentity.toLowerCase() !== attachment.expectedSessionIdentity.toLowerCase()) {
      throw new Error(`Existing Codex realtime attachment preflight failed: ${preflight.reason || "identity-or-voice-state"}.`);
    }
    const input = attachment.platform === "darwin"
      ? new MacosExistingGptLiveAudio({
        existingGptLiveProcessId: attachment.desktopProcessId,
        virtualAudioDeviceName: attachment.virtualAudioDeviceName,
        expectedSessionIdentity: attachment.expectedSessionIdentity,
        verifyExistingSession: attachment.verifyExistingSession,
      })
      : new WindowsExistingGptLiveAudio({
        existingGptLiveProcessId: attachment.desktopProcessId,
        virtualCableRenderEndpointId: attachment.virtualCableRenderEndpointId,
        expectedSessionIdentity: attachment.expectedSessionIdentity,
        verifyExistingSession: attachment.verifyExistingSession,
      });
    const transport = options.appServerTransport;
    if (!transport) throw new Error("A read-only current-task transcript observer is required before network activity.");
    if (!(transport instanceof DesktopOwnedCodexAppServerTransport)) throw new Error("Direct existing-task WebRTC audio requires the identity-pinned Desktop transport.");
    const voice = new DesktopExistingTaskAudio({ input, transport, threadId });
    const directAudio = new MeetronDirectAudioBridge({
      voice,
      onStage: (stage: string) => {
        if (stage === "conference-audio-to-chatgpt") options.onLiveStage?.("meetron-chatgpt-input");
        if (stage === "chatgpt-audio-to-conference") options.onLiveStage?.("meetron-chatgpt-output");
      },
    });
    await transport.connect?.();
    let observedUserTranscriptGeneration = 0;
    const unsubscribeTranscript = transport.subscribe((notification) => {
      if (notification.method !== "thread/realtime/transcript/done") return;
      const params = notification.params as { threadId?: unknown; role?: unknown } | undefined;
      if (params?.threadId === threadId && params.role === "user") observedUserTranscriptGeneration += 1;
    });
    const confirmationBaselines = new Map<number, number>();
    const liveInputConfirmation = {
      begin(inputSequence: number): void {
        confirmationBaselines.set(inputSequence, observedUserTranscriptGeneration);
      },
      async confirm(inputSequence: number): Promise<boolean> {
        const baseline = confirmationBaselines.get(inputSequence);
        // The production preflight has already replaced the foreground sender
        // with the isolated OS-scoped virtual-audio graph. Desktop transcript notifications
        // strengthen evidence but are not a writer or join dependency.
        const notificationObserved = baseline !== undefined && observedUserTranscriptGeneration > baseline;
        confirmationBaselines.delete(inputSequence);
        return notificationObserved || baseline !== undefined;
      },
    };
    try {
      return await runUdpDiscoverySmoke({
        ...options,
        liveCallWait: true,
        audioRoundTripProbe: true,
        meetronDirectAudio: directAudio,
        liveInputConfirmation,
      });
    } finally {
      unsubscribeTranscript();
      await directAudio.close().catch(() => undefined);
      transport.close?.();
    }
  }, {
    maxReconnectAttempts: options.maxReconnectAttempts,
    onRetry: () => options.onLiveStage?.("reconnecting"),
  });
}

class NativePrejoinDaveSession implements DaveSession {
  readonly #native: OfficialLibdaveNativeReadySession;
  #destroyed = false;

  constructor(native: OfficialLibdaveNativeReadySession) { this.#native = native; }
  maxProtocolVersion(): number { return this.#native.maxProtocolVersion; }
  setProtocolVersion(version: number): void {
    if (this.#destroyed || version <= 0 || version > this.maxProtocolVersion()) throw new Error("DAVE protocol version is invalid for the native session.");
    this.#native.setProtocolVersion(version);
  }
  setExternalSender(payload: Uint8Array): void { this.#native.setExternalSender(payload); }
  processProposals(payload: Uint8Array, recognizedUserIds: readonly string[]): Uint8Array | null {
    if (this.#destroyed || recognizedUserIds.length === 0) throw new Error("DAVE proposal transition has no recognized users.");
    return this.#native.processProposals(payload, recognizedUserIds);
  }
  processCommit(payload: Uint8Array): "accepted" | "ignored" | "failed" {
    if (this.#destroyed) throw new Error("DAVE commit transition is closed.");
    return this.#native.processCommit(payload);
  }
  processWelcome(payload: Uint8Array, recognizedUserIds: readonly string[]): "accepted" | "failed" {
    if (this.#destroyed || recognizedUserIds.length === 0) throw new Error("DAVE welcome transition has no recognized users.");
    return this.#native.processWelcome(payload, recognizedUserIds);
  }
  createKeyPackage(): Uint8Array { return this.#native.createKeyPackage(); }
  encryptOpus(ssrc: number, opusFrame: Uint8Array): Uint8Array {
    if (this.#destroyed) throw new Error("Audio encryption is closed.");
    return this.#native.encryptOpus(ssrc, opusFrame);
  }
  decryptOpus(ssrc: number, encryptedFrame: Uint8Array): Uint8Array {
    if (this.#destroyed) throw new Error("Audio decryption is closed.");
    return this.#native.decryptOpus(ssrc, encryptedFrame);
  }
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#native.close();
  }
}

/**
 * Initializes the official native DAVE session and the product Voice Gateway
 * state machine without acquiring a credential or opening any network path.
 * The returned handle intentionally keeps the native session alive until the
 * caller explicitly releases the ready-to-join wait state.
 */
export function prepareDaveReady(options: DaveReadyOptions = {}): DaveReadyHandle {
  options.target ?? loadDiscordVoiceTarget();
  const provider = options.credentialProvider ?? createDiscordBotCredentialProvider();
  if (provider.storage !== "windows-dpapi-current-user" && provider.storage !== "macos-keychain") throw new Error("DAVE live preparation requires a production OS-secret provider.");
  const addonPath = options.addonPath ?? process.env.CODEX_BRIDGE_LIBDAVE_ADDON_PATH ?? resolvePath("work/node-native-binding-probe/build/libdave_node_probe.node");
  const native = openOfficialLibdaveNativeReadySession(addonPath, options.addonLoader);
  const voice = new DiscordVoiceGatewaySession(new NativePrejoinDaveSession(native));
  if (voice.state !== "idle" || !native.isOpen()) {
    voice.close();
    throw new Error("DAVE ready-to-join initialization failed closed.");
  }
  let closed = false;
  return Object.freeze({
    report: Object.freeze({
      phase: "dave-ready" as const,
      state: "ready-to-join" as const,
      nativeSession: "initialized" as const,
      externalConnectionOpened: false as const,
      credentialAcquired: false as const,
    }),
    isOpen(): boolean { return !closed && native.isOpen(); },
    close(): void {
      if (closed) return;
      closed = true;
      voice.close();
    },
  });
}

function parseArguments(argv: string[]): "gateway-ready" | "voice-leave" | "udp-discovery" | "dave-ready" | "dave-live" | "send-tone" | "receive-opus" | "pcm-route" | "live-call" {
  if (argv.length !== 2 || argv[0] !== "--phase" || !["gateway-ready", "voice-leave", "udp-discovery", "dave-ready", "dave-live", "send-tone", "receive-opus", "pcm-route", "live-call"].includes(argv[1]!)) {
    throw new Error("Usage: smoke:voice --phase gateway-ready|voice-leave|udp-discovery|dave-ready|dave-live|send-tone|receive-opus|pcm-route|live-call");
  }
  return argv[1] as "gateway-ready" | "voice-leave" | "udp-discovery" | "dave-ready" | "dave-live" | "send-tone" | "receive-opus" | "pcm-route" | "live-call";
}

export function acquireLiveCallProcessLock(lockPath = resolvePath("runtime/live-call.lock")): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx");
      writeFileSync(descriptor, String(process.pid), "utf8");
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        try { closeSync(descriptor); } catch { /* best-effort shutdown */ }
        try { if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) unlinkSync(lockPath); } catch { /* forced shutdown */ }
      };
      process.once("exit", release);
      return () => { process.off("exit", release); release(); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = 0;
      try { owner = Number(readFileSync(lockPath, "utf8").trim()); } catch { /* unreadable is stale */ }
      let ownerAlive = false;
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); ownerAlive = true; } catch { /* stale PID */ }
      }
      if (ownerAlive) throw new Error("A final Discord live-call runner is already active.");
      try { unlinkSync(lockPath); } catch { /* another contender may remove it */ }
    }
  }
  throw new Error("The final Discord live-call lock could not be acquired.");
}

export function resolveLiveCallTimeoutMs(value = process.env.CODEX_BRIDGE_LIVE_CALL_TIMEOUT_MS): number {
  if (value === undefined || value === "") return 60 * 60_000;
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 * 60_000 || timeoutMs > 24 * 60 * 60_000) {
    throw new Error("CODEX_BRIDGE_LIVE_CALL_TIMEOUT_MS must be an integer from 600000 through 86400000.");
  }
  return timeoutMs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let releaseLiveCallLock: (() => void) | undefined;
  let removeLiveCallSignals: (() => void) | undefined;
  try {
    const phase = parseArguments(process.argv.slice(2));
    if (phase === "live-call") releaseLiveCallLock = acquireLiveCallProcessLock();
    if (phase === "dave-ready") {
      const handle = prepareDaveReady();
      process.stdout.write(`${JSON.stringify(handle.report)}\n`);
      let wait: ReturnType<typeof setInterval>;
      const release = (): void => { clearInterval(wait); handle.close(); process.exitCode = 0; };
      process.once("SIGINT", release);
      process.once("SIGTERM", release);
      wait = setInterval(() => { if (!handle.isOpen()) release(); }, 1_000);
    } else {
      let negotiatedEvidence: { daveProtocolVersion: number; transportMode: string } | undefined;
      let activeEvidence: { transitionId: number } | undefined;
      let toneEvidence: { packetBytes: number } | undefined;
      let receiveEvidence: { opusBytes: number } | undefined;
      let audioEvidence: { pcmSamples: number; responseOpusBytes: number; packetBytes: number } | undefined;
      const emittedLiveStages = new Set<string>();
      let emittedInputLevel = false;
      let emittedOutputLevel = false;
      let currentCodexState: CodexVoiceBrainState = "idle";
      let liveReady = false;
      let lastLiveStage = "starting";
      let responseSent = false;
      let speechStarted = false;
      let currentCodexTurn = 0;
      let completedCodexTurns = 0;
      let outputAfterCompletedTurn = 0;
      let responseAfterCompletedTurn = 0;
      let lastInputLevel: PcmLevelEvidence | undefined;
      let lastInputAt = 0;
      let lastOutputLevel: PcmLevelEvidence | undefined;
      let lastOutputAt = 0;
      let liveHealthInterval: ReturnType<typeof setInterval> | undefined;
      const liveAbortController = phase === "live-call" ? new AbortController() : undefined;
      if (liveAbortController) {
        const stop = (): void => liveAbortController.abort();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        removeLiveCallSignals = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); };
      }
      if (phase === "live-call") {
        liveHealthInterval = setInterval(() => {
          const now = Date.now();
          const waitingAt = !lastInputLevel
            ? "discord-non-silent-input"
            : !emittedLiveStages.has("dave-decrypted")
            ? "discord-dave-decode"
            : !emittedLiveStages.has("codex-realtime-input")
            ? "exact-task-realtime-input"
            : !emittedLiveStages.has("codex-realtime-output") || !lastOutputLevel
            ? "exact-task-realtime-output"
            : lastOutputLevel.nonSilentSamples === 0
            ? "same-task-output-non-silent"
            : !responseSent ? "discord-output-send" : "complete";
          process.stdout.write(`${JSON.stringify({
            phase: "live-call", state: "health", codexState: currentCodexState,
            ready: liveReady, lastStage: lastLiveStage, inputObserved: emittedInputLevel,
            speechStarted, outputObserved: emittedOutputLevel, responseSent,
            inputAgeMs: lastInputAt ? now - lastInputAt : null,
            inputLevel: lastInputLevel ? { rms: lastInputLevel.rms, peak: lastInputLevel.peak, nonSilentSamples: lastInputLevel.nonSilentSamples } : null,
            outputAgeMs: lastOutputAt ? now - lastOutputAt : null,
            outputLevel: lastOutputLevel ? { rms: lastOutputLevel.rms, peak: lastOutputLevel.peak, nonSilentSamples: lastOutputLevel.nonSilentSamples } : null,
            waitingAt,
            secretOutput: false, identifierOutput: false,
          })}\n`);
        }, 30_000);
      }
      const run = phase === "gateway-ready"
        ? runGatewayReadySmoke()
        : phase === "voice-leave"
        ? runVoiceLeave()
        : phase === "live-call"
        ? runCurrentTaskLiveCall({
            timeoutMs: resolveLiveCallTimeoutMs(),
            signal: liveAbortController?.signal,
            sessionDescriptionProbe: true,
            onSessionDescription: (evidence) => { negotiatedEvidence = evidence; },
            onDaveActive: (evidence) => { activeEvidence = evidence; },
            onCodexState: (state) => { currentCodexState = state; process.stdout.write(`${JSON.stringify({ phase: "live-call", state: `codex-${state}`, sameCodexThread: true, secretOutput: false, identifierOutput: false })}\n`); },
            onLiveCallReady: () => { liveReady = true; process.stdout.write(`${JSON.stringify({ phase: "live-call", state: "ready", sameCodexThread: true, daveActive: true, secretOutput: false, identifierOutput: false })}\n`); },
            onLiveStage: (stage) => {
              lastLiveStage = stage;
              if (stage === "speech-started") speechStarted = true;
              if (stage === "codex-turn-submitting") currentCodexTurn += 1;
              if (stage === "codex-turn-completed") completedCodexTurns = currentCodexTurn;
              const perTurn = new Set(["codex-turn-submitting", "codex-first-delta", "codex-turn-completed", "codex-turn-failed"]);
              const stageKey = perTurn.has(stage) ? `${stage}:${currentCodexTurn}:${completedCodexTurns}` : stage;
              if (stage !== "reconnecting" && emittedLiveStages.has(stageKey)) return;
              emittedLiveStages.add(stageKey);
              emittedLiveStages.add(stage);
              process.stdout.write(`${JSON.stringify({ phase: "live-call", state: stage, codexTurn: currentCodexTurn, completedCodexTurns, secretOutput: false, identifierOutput: false })}\n`);
            },
            onLiveInputLevel: (evidence) => {
              lastInputLevel = evidence;
              lastInputAt = Date.now();
              if (emittedInputLevel || evidence.nonSilentSamples === 0) return;
              emittedInputLevel = true;
              process.stdout.write(`${JSON.stringify({ phase: "live-call", state: "input-level", ...evidence, secretOutput: false, identifierOutput: false })}\n`);
            },
            onLiveOutputLevel: (evidence) => {
              lastOutputLevel = evidence;
              lastOutputAt = Date.now();
              if (evidence.nonSilentSamples === 0) return;
              if (completedCodexTurns > 0) outputAfterCompletedTurn = completedCodexTurns;
              if (emittedOutputLevel && outputAfterCompletedTurn === 0) return;
              emittedOutputLevel = true;
              process.stdout.write(`${JSON.stringify({ phase: "live-call", state: "output-level", ...evidence, codexTurn: currentCodexTurn, completedCodexTurns, secretOutput: false, identifierOutput: false })}\n`);
            },
            onLiveResponse: (evidence) => {
              responseSent = true;
              if (completedCodexTurns > 0) responseAfterCompletedTurn = completedCodexTurns;
              process.stdout.write(`${JSON.stringify({ phase: "live-call", state: "response-sent", ...evidence, codexTurn: currentCodexTurn, completedCodexTurns, secretOutput: false, identifierOutput: false })}\n`);
            },
          })
        : runUdpDiscoverySmoke(["dave-live", "send-tone", "receive-opus", "pcm-route"].includes(phase) ? {
            sessionDescriptionProbe: true,
            sendToneProbe: phase === "send-tone",
            receiveOpusProbe: phase === "receive-opus",
            audioRoundTripProbe: phase === "pcm-route",
            onSessionDescription: (evidence) => { negotiatedEvidence = evidence; },
            onDaveActive: (evidence) => { activeEvidence = evidence; },
            onToneSent: (evidence) => { toneEvidence = evidence; },
            onOpusReceived: (evidence) => { receiveEvidence = evidence; },
            onAudioRoundTrip: (evidence) => { audioEvidence = evidence; },
          } : { holdAfterDiscoveryMs: Number(process.env.CODEX_BRIDGE_OBSERVABLE_HOLD_MS ?? 0) });
      run
      .then((report) => process.stdout.write(`${JSON.stringify(audioEvidence
        ? { phase: "pcm-route", state: "response-sent", ...audioEvidence, secretOutput: false, identifierOutput: false }
        : receiveEvidence
        ? { phase: "receive-opus", state: "received", opusBytes: receiveEvidence.opusBytes, secretOutput: false, identifierOutput: false }
        : toneEvidence ? { phase: "send-tone", state: "sent", packetBytes: toneEvidence.packetBytes, secretOutput: false, identifierOutput: false }
        : activeEvidence ? { phase: "dave-live", state: "dave-active", transitionId: activeEvidence.transitionId, secretOutput: false, identifierOutput: false }
        : report)}\n`))
      .catch((error) => {
        if (phase === "live-call") {
          process.stdout.write(`${JSON.stringify({ phase: "live-call", state: "error", message: redact((error as Error).message), secretOutput: false, identifierOutput: false })}\n`);
        } else if (phase === "receive-opus" && activeEvidence) {
          process.stdout.write(`${JSON.stringify({ phase: "receive-opus", state: "dave-active-awaiting-media", transitionId: activeEvidence.transitionId, secretOutput: false, identifierOutput: false })}\n`);
        } else if (negotiatedEvidence) {
          process.stdout.write(`${JSON.stringify({ phase: "dave-live", state: "session-described", ...negotiatedEvidence, secretOutput: false, identifierOutput: false })}\n`);
        }
        process.stderr.write(`${redact((error as Error).message)}\n`);
        process.exitCode = 1;
      })
      .finally(() => { if (liveHealthInterval) clearInterval(liveHealthInterval); removeLiveCallSignals?.(); releaseLiveCallLock?.(); });
    }
  } catch (error) {
    releaseLiveCallLock?.();
    removeLiveCallSignals?.();
    process.stderr.write(`${redact((error as Error).message)}\n`);
    process.exitCode = 1;
  }
}
