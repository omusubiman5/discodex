import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface MeetmateSession {
  readonly id: string;
  readonly config: {
    readonly prompt?: string;
    readonly greeting?: string;
    readonly model?: string;
    readonly wakeMode?: string;
  };
  readonly conversationLog: unknown[];
  readonly conversationLogs?: Record<string, unknown[]>;
  gatewayDelegationState?: Record<string, unknown>;
  delegationResults?: unknown[];
}

export interface MeetmateTurnState {
  isAgentSpeaking: boolean;
  inputCooldownUntil: number;
  droppedEchoFrames: number;
  gateState?: string;
}

export interface MeetmatePipeline {
  sendAudio(buffer: Buffer): void;
  close(): void;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  handleGatewaySubagentSpawn?(event: unknown): boolean;
  handleGatewaySubagentCompletion?(event: unknown): boolean;
  handleGatewaySessionReply?(event: unknown): boolean;
  handleGatewayAnnounceInjected?(event: unknown): boolean;
  getDelegationResults?(): readonly unknown[];
  getSessionUsers?(): { readonly parent: string; readonly delegate: string };
}

export interface MeetmatePipelineConfig {
  readonly stt?: { readonly sampleRate?: number };
  readonly tts?: { readonly sampleRate?: number };
  readonly [key: string]: unknown;
}

export interface MeetmatePipelineOptions {
  readonly agents?: Readonly<Record<string, unknown>>;
  readonly selectedAgentIds?: readonly string[];
  readonly defaultAgentId?: string;
  readonly agentProfile?: unknown;
  readonly onAgentSwitch?: (from: string | undefined, to: string) => void;
  readonly onChatMessage?: (text: string) => boolean;
  readonly llmProvider?: {
    readonly name: string;
    readonly managesHistory?: boolean;
    streamChat(messages: readonly unknown[], options?: { readonly signal?: AbortSignal }): AsyncIterable<string>;
  };
  readonly sttProvider?: {
    send(buffer: Buffer): void;
    close(): void;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  };
  readonly synthesize?: (text: string, options?: {
    readonly sampleRate?: number;
    readonly signal?: AbortSignal;
    readonly onAudio?: (chunk: Buffer) => void;
  }) => Promise<void>;
}

type UpstreamCreatePipeline = (
  session: MeetmateSession,
  turnState: MeetmateTurnState,
  onAudio: (buffer: Buffer, metadata?: unknown) => void,
  config: MeetmatePipelineConfig,
  options?: MeetmatePipelineOptions,
) => MeetmatePipeline;

interface PcmFrame {
  readonly samples: Int16Array;
  readonly sampleRate: number;
  readonly channels: number;
}

function resamplePcm(frame: PcmFrame, outputRate: number, outputChannels: number): Buffer {
  if (!Number.isSafeInteger(outputRate) || outputRate <= 0 || ![1, 2].includes(outputChannels)) {
    throw new Error("Discord Meetmate PCM format is invalid.");
  }
  const inputFrames = Math.floor(frame.samples.length / frame.channels);
  if (inputFrames === 0) return Buffer.alloc(0);
  const outputFrames = Math.max(1, Math.floor(inputFrames * outputRate / frame.sampleRate));
  const output = new Int16Array(outputFrames * outputChannels);
  for (let index = 0; index < outputFrames; index += 1) {
    const sourceFrame = Math.min(inputFrames - 1, Math.floor(index * frame.sampleRate / outputRate));
    let mono = 0;
    for (let channel = 0; channel < frame.channels; channel += 1) mono += frame.samples[sourceFrame * frame.channels + channel] ?? 0;
    mono = Math.max(-32768, Math.min(32767, Math.round(mono / frame.channels)));
    for (let channel = 0; channel < outputChannels; channel += 1) output[index * outputChannels + channel] = mono;
  }
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
}

/**
 * Adds Discord as a Meetmate transport. Meetmate remains the implementation
 * basis: its createPipeline owns STT, gateway/session, conversation,
 * delegation, barge-in, and TTS. The reviewed provider seam binds the current
 * Codex task; this adapter only changes PCM transport.
 */
export class MeetmateDiscordTransport {
  readonly #pipeline: MeetmatePipeline;
  readonly #sttSampleRate: number;
  #onDiscordPcm: (frame: PcmFrame, metadata?: unknown) => void;

  constructor(options: {
    readonly session: MeetmateSession;
    readonly turnState: MeetmateTurnState;
    readonly config: MeetmatePipelineConfig;
    readonly pipelineOptions?: MeetmatePipelineOptions;
    readonly onDiscordPcm?: (frame: PcmFrame, metadata?: unknown) => void;
  }) {
    const upstream = require("meetmate/src/pipeline.js") as { createPipeline?: UpstreamCreatePipeline };
    if (typeof upstream.createPipeline !== "function") throw new Error("Pinned Meetmate pipeline is unavailable.");
    this.#sttSampleRate = options.config.stt?.sampleRate ?? 16_000;
    this.#onDiscordPcm = options.onDiscordPcm ?? (() => undefined);
    this.#pipeline = upstream.createPipeline(
      options.session,
      options.turnState,
      (pcm, metadata) => {
        const sourceRate = options.config.tts?.sampleRate ?? 44_100;
        const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
        const discordPcm = resamplePcm({ samples, sampleRate: sourceRate, channels: 1 }, 48_000, 2);
        this.#onDiscordPcm({
          samples: new Int16Array(discordPcm.buffer, discordPcm.byteOffset, discordPcm.byteLength / 2),
          sampleRate: 48_000,
          channels: 2,
        }, metadata);
      },
      options.config,
      options.pipelineOptions,
    );
  }

  sendDiscordPcm(frame: PcmFrame): void {
    this.#pipeline.sendAudio(resamplePcm(frame, this.#sttSampleRate, 1));
  }

  setDiscordPcmSink(sink: (frame: PcmFrame, metadata?: unknown) => void): void {
    this.#onDiscordPcm = sink;
  }

  close(): void { this.#pipeline.close(); }
  on(event: string, listener: (...args: unknown[]) => void): unknown { return this.#pipeline.on?.(event, listener); }
  get pipeline(): MeetmatePipeline { return this.#pipeline; }
}

export function getMeetmatePipelineConfig(overrides: Record<string, unknown> = {}): MeetmatePipelineConfig {
  const upstream = require("meetmate/src/config.js") as { getPipelineConfig?: (value: Record<string, unknown>) => MeetmatePipelineConfig };
  if (typeof upstream.getPipelineConfig !== "function") throw new Error("Pinned Meetmate configuration is unavailable.");
  return upstream.getPipelineConfig(overrides);
}
