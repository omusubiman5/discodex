#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { acquireLiveCallProcessLock, isConversationInputPcm, resolveLiveCallTimeoutMs, runCurrentTaskLiveCall } from "../src/discord-gateway-smoke.ts";
import { DesktopOwnedCodexAppServerTransport } from "../src/core/codex-app-server-rpc.ts";

function requiredEnvironment(name, environment = process.env) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Required pre-existing-session setting is missing: ${name}.`);
  return value;
}

export function loadMeetronWindowsLiveEnvironment(environment = process.env) {
  const path = environment.CODEX_BRIDGE_MEETRON_RUNTIME_CONFIG || resolve("runtime/meetron-windows-live.json");
  if (!existsSync(path)) return environment;
  const stored = JSON.parse(readFileSync(path, "utf8"));
  return {
    CODEX_BRIDGE_DISCORD_GUILD_ID: stored.discordGuildId,
    CODEX_BRIDGE_DISCORD_VOICE_CHANNEL_ID: stored.discordVoiceChannelId,
    ...environment,
  };
}

export function loadMeetronWindowsLiveConfiguration(environment = process.env) {
  const threadId = requiredEnvironment("CODEX_THREAD_ID", environment);
  if (!/^[0-9a-f-]{20,}$/i.test(threadId)) throw new Error("CODEX_THREAD_ID must identify the exact current Codex task.");
  const debuggerEndpoint = requiredEnvironment("CODEX_DESKTOP_DEBUGGER_ENDPOINT", environment);
  const desktopProcessId = Number(requiredEnvironment("CODEX_BRIDGE_CODEX_DESKTOP_PID", environment));
  if (!Number.isSafeInteger(desktopProcessId) || desktopProcessId <= 0) throw new Error("CODEX_BRIDGE_CODEX_DESKTOP_PID must identify the existing Codex Desktop root process.");
  const virtualCableRenderEndpointId = requiredEnvironment("CODEX_BRIDGE_VB_CABLE_RENDER_ENDPOINT_ID", environment);
  const debuggerUrl = new URL(debuggerEndpoint);
  if (debuggerUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(debuggerUrl.hostname)) {
    throw new Error("CODEX_DESKTOP_DEBUGGER_ENDPOINT must be an HTTP loopback endpoint.");
  }
  // Fail closed instead of auto-discovering another guild/channel.
  const guildId = requiredEnvironment("CODEX_BRIDGE_DISCORD_GUILD_ID", environment);
  const channelId = requiredEnvironment("CODEX_BRIDGE_DISCORD_VOICE_CHANNEL_ID", environment);
  if (!/^\d{16,22}$/.test(guildId) || !/^\d{16,22}$/.test(channelId)) {
    throw new Error("The explicit Discord guild/channel target is invalid.");
  }
  return { threadId, debuggerEndpoint: debuggerUrl.href.replace(/\/$/, ""), desktopProcessId, virtualCableRenderEndpointId, target: { guildId, channelId } };
}

export function expectedSessionIdentityForThread(threadId) {
  if (!/^[0-9a-f-]{20,}$/i.test(threadId || "")) throw new Error("A concrete Codex task identity is required.");
  return createHash("sha256").update(threadId).digest("hex");
}

export class LiveTurnCausalTracker {
  constructor() {
    this.ordinal = 0;
    this.inputActive = false;
    this.awaitingResponse = 0;
    this.pendingSend = 0;
    this.completedTurns = 0;
  }
  inputStarted() {
    if (this.inputActive) return [];
    if (this.awaitingResponse || this.pendingSend) {
      // VAD can split one utterance into several non-silent bursts. Until the
      // response is sent those bursts remain causally part of the same turn.
      this.inputActive = true;
      return [];
    }
    this.ordinal += 1;
    this.inputActive = true;
    return [{ state: "turn-input-started", turnOrdinal: this.ordinal }];
  }
  inputEnded() {
    if (!this.inputActive) return [];
    this.inputActive = false;
    if (this.awaitingResponse || this.pendingSend) return [];
    this.awaitingResponse = this.ordinal;
    return [{ state: "turn-input-ended", turnOrdinal: this.ordinal }];
  }
  outputStarted() {
    if (!this.awaitingResponse || this.pendingSend) return [];
    this.pendingSend = this.awaitingResponse;
    return [{ state: "turn-response-started", turnOrdinal: this.pendingSend }];
  }
  outputSent() {
    if (!this.pendingSend) return [];
    const turnOrdinal = this.pendingSend;
    this.completedTurns = Math.max(this.completedTurns, turnOrdinal);
    this.pendingSend = 0;
    this.awaitingResponse = 0;
    // Any VAD burst that arrived while the response was already streaming is
    // closed at this causal boundary. A later burst starts the next ordinal;
    // it must not complete the just-sent ordinal a second time.
    this.inputActive = false;
    return [{ state: "turn-roundtrip-completed", turnOrdinal }];
  }
}

export function createSupportedStopWatcher({
  stopPath = resolve("runtime/live-call.stop"),
  controller = new AbortController(),
  intervalMs = 250,
} = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 5_000) throw new Error("Supported stop poll interval is invalid.");
  try { rmSync(stopPath, { force: true }); } catch { /* fail closed on the live preflight instead */ }
  let requested = false;
  const timer = setInterval(() => {
    if (!existsSync(stopPath) || requested) return;
    requested = true;
    controller.abort();
  }, intervalMs);
  timer.unref?.();
  return {
    controller,
    get requested() { return requested; },
    close() {
      clearInterval(timer);
      try { rmSync(stopPath, { force: true }); } catch { /* best-effort control-file cleanup */ }
    },
  };
}

export async function runMeetronWindowsLive({ environment = process.env, signal, observer, gainProvider } = {}) {
  environment = loadMeetronWindowsLiveEnvironment(environment);
  const configuration = loadMeetronWindowsLiveConfiguration(environment);
  const createTransport = () => new DesktopOwnedCodexAppServerTransport({
    threadId: configuration.threadId,
    debuggerEndpoint: configuration.debuggerEndpoint,
    // The foreground realtime call already owns the task writer. The bridge
    // observes its notifications but must never gate Discord join on a
    // thread/read request that can wait behind that active writer.
    verifyThreadOnConnect: false,
  });
  const transport = createTransport();
  const expectedSessionIdentity = expectedSessionIdentityForThread(configuration.threadId);
  const verifyExistingSession = async ({ existingGptLiveProcessId, expectedSessionIdentity: expected }) => {
    const verifier = createTransport();
    try {
      await verifier.connect();
      const voiceActive = await verifier.isForegroundRealtimeVoiceActive();
      return {
        matches: expected === expectedSessionIdentity,
        voiceActive,
        processId: existingGptLiveProcessId,
        sessionIdentity: expectedSessionIdentity,
        reason: voiceActive ? undefined : "foreground-realtime-not-active",
      };
    } catch {
      return { matches: false, voiceActive: false, processId: existingGptLiveProcessId, sessionIdentity: expectedSessionIdentity, reason: "desktop-task-verification-failed" };
    } finally {
      verifier.close();
    }
  };
  let inputObserved = false;
  let outputObserved = false;
  let outputFloorObserved = false;
  let outputSpeechObserved = false;
  let inputEndTimer;
  const turns = new LiveTurnCausalTracker();
  const counts = {
    udpReceived: 0, daveDecrypted: 0, pcmGenerated: 0,
    codexRealtimeInput: 0, codexInputFailed: 0, codexRealtimeOutput: 0,
    discordOutputSent: 0, responses: 0, participantConnects: 0, participantDisconnects: 0,
    speakerSsrcMappings: 0, speakerSsrcRemaps: 0, daveEpochs: 0, daveRatchets: 0,
  };
  const gates = {
    targetChannelMatched: false,
    selfMute: false,
    selfDeaf: false,
    speakerSsrcMapped: false,
  };
  const emittedStages = new Set();
  const liveStartedAt = performance.now();
  const repeatableStages = new Set([
    "discord-participant-voice-state", "discord-clients-connected", "discord-client-disconnected",
    "speaker-ssrc-mapped", "speaker-ssrc-remapped", "dave-session-described", "dave-key-package-sent",
    "dave-external-sender-received", "dave-prepare-epoch-received", "dave-proposals-received",
    "dave-commit-welcome-sent", "dave-commit-received", "dave-welcome-received",
    "dave-transition-ready-sent", "dave-execute-transition-received", "dave-epoch-active",
    "dave-ratchet-selected", "reconnecting",
  ]);
  const emit = (record) => process.stdout.write(`${JSON.stringify({
    phase: "meetron-windows-live",
    timestamp: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - liveStartedAt),
    ...record,
    exactCurrentCodexTask: true,
    secretOutput: false,
    identifierOutput: false,
  })}\n`);
  const emitTurnRecords = (records) => records.forEach((record) => emit(record));
  const emitHealth = () => emit({ state: "health", gates: { ...gates }, counts: { ...counts }, completedTurns: turns.completedTurns, inputObserved, outputObserved });
  const healthTimer = setInterval(emitHealth, 15_000);
  healthTimer.unref?.();
  try {
    const result = await runCurrentTaskLiveCall({
      // Voice Gateway owns its protocol Resume. Never rerun the full product
      // session outside that state machine, which duplicates joins/routes.
      maxReconnectAttempts: 0,
      threadId: configuration.threadId,
      appServerTransport: transport,
      existingTaskAudio: {
        desktopProcessId: configuration.desktopProcessId,
        virtualCableRenderEndpointId: configuration.virtualCableRenderEndpointId,
        expectedSessionIdentity,
        verifyExistingSession,
      },
      target: configuration.target,
      timeoutMs: resolveLiveCallTimeoutMs(environment.CODEX_BRIDGE_LIVE_CALL_TIMEOUT_MS),
      sessionDescriptionProbe: true,
      signal,
      outputGainLinear: gainProvider,
      onCodexState: (state) => emit({ state: `codex-${state}` }),
      onLiveCallReady: () => { observer?.({ state: "joined-ready", joined: true, targetMatched: gates.targetChannelMatched }); emit({ state: "joined-ready", taskIdentityVerified: true }); },
      onLiveStage: (stage) => {
        if (stage === "discord-voice-state-matched") gates.targetChannelMatched = true;
        // Main Gateway voice-state confirmation identifies the configured
        // channel, but it is not Voice Gateway Ready and it precedes UDP and
        // DAVE setup. Keep `joined` false until onLiveCallReady fires after
        // the DAVE Execute transition and direct-audio startup complete.
        if (stage === "discord-voice-state-matched") observer?.({ state: "voice-state-matched", joined: false, targetMatched: true });
        // Voice Opcode 2 Ready only supplies SSRC/UDP parameters. It is not
        // media-ready while the required DAVE transition and direct-audio
        // endpoint startup are still pending. Publish joined only from
        // onLiveCallReady after those gates complete.
        if (stage === "discord-voice-joined") observer?.({ state: "voice-ready", joined: false, targetMatched: gates.targetChannelMatched });
        if (stage === "reconnecting") observer?.({ state: "reconnecting", joined: false, targetMatched: gates.targetChannelMatched });
        if (stage === "discord-client-disconnected") observer?.({ state: "disconnected", joined: false, targetMatched: false });
        if (stage === "speaker-ssrc-mapped") gates.speakerSsrcMapped = true;
        if (stage === "discord-clients-connected") counts.participantConnects += 1;
        if (stage === "discord-client-disconnected") counts.participantDisconnects += 1;
        if (stage === "speaker-ssrc-mapped") counts.speakerSsrcMappings += 1;
        if (stage === "speaker-ssrc-remapped") { counts.speakerSsrcRemaps += 1; gates.speakerSsrcMapped = true; }
        if (stage === "dave-epoch-active") counts.daveEpochs += 1;
        if (stage === "dave-ratchet-selected") counts.daveRatchets += 1;
        if (stage === "udp-received") counts.udpReceived += 1;
        if (stage === "dave-decrypted") counts.daveDecrypted += 1;
        if (stage === "pcm-generated") counts.pcmGenerated += 1;
        if (stage === "codex-realtime-input" || stage === "meetron-chatgpt-input") counts.codexRealtimeInput += 1;
        if (stage === "codex-input-failed") counts.codexInputFailed += 1;
        if (stage === "codex-realtime-output" || stage === "meetron-chatgpt-output") counts.codexRealtimeOutput += 1;
        if (stage === "speaking-stopped") emitTurnRecords(turns.outputSent());
        if (!emittedStages.has(stage) || stage === "codex-input-failed" || repeatableStages.has(stage)) {
          emittedStages.add(stage);
          emit({ state: "stage", stage });
        }
      },
      onLiveInputLevel: (level) => {
        if (isConversationInputPcm(level)) {
          emitTurnRecords(turns.inputStarted());
          clearTimeout(inputEndTimer);
          inputEndTimer = setTimeout(() => emitTurnRecords(turns.inputEnded()), 700);
          inputEndTimer.unref?.();
        }
        if (!inputObserved && level.nonSilentSamples > 0) {
          inputObserved = true;
          emit({ state: "discord-input-observed", level: { rms: level.rms, peak: level.peak } });
        }
      },
      onLiveInputRouteEvidence: (evidence) => emit({ state: "vb-cable-render-evidence", evidence }),
      onLiveTurnGateEvidence: (evidence) => emit({ state: "turn-gate-evidence", evidence }),
      onLiveOutputLevel: (level) => {
        if (!outputObserved && level.nonSilentSamples > 0) {
          outputObserved = true;
          emit({ state: "codex-realtime-output-observed", level: { rms: level.rms, peak: level.peak } });
        }
      },
      onLiveOutputQuality: (quality) => {
        if (quality.accepted) emitTurnRecords(turns.outputStarted());
        if ((!quality.accepted && outputFloorObserved) || (quality.accepted && outputSpeechObserved)) return;
        if (quality.accepted) outputSpeechObserved = true;
        else outputFloorObserved = true;
        emit({
          state: quality.accepted ? "codex-output-speech-quality" : "codex-output-floor-rejected",
          quality: {
            rms: quality.rms, peak: quality.peak, dcOffset: quality.dcOffset,
            clippedSamples: quality.clippedSamples, zeroCrossingPermille: quality.zeroCrossingPermille,
            differenceRms: quality.differenceRms, normalizationGain: quality.normalizationGain,
          },
        });
      },
      onLiveCodecQuality: (quality) => emit({
        state: "opus-roundtrip-quality",
        quality: {
          opusBytes: quality.opusBytes,
          input: { rms: quality.inputLevel.rms, peak: quality.inputLevel.peak, ...quality.inputQuality },
          output: { rms: quality.outputLevel.rms, peak: quality.outputLevel.peak, ...quality.outputQuality },
        },
      }),
      onLiveRtpSendEvidence: (evidence) => emit({ state: "discord-rtp-send-evidence", evidence }),
      onCodexInputFailure: (failure) => emit({ state: "codex-input-failure", failure }),
      onLiveResponse: (evidence) => {
        counts.discordOutputSent += evidence.packets;
        counts.responses += 1;
        emit({ state: "discord-output-sent", packets: evidence.packets, pcmSamples: evidence.pcmSamples, inputSequence: evidence.inputSequence });
      },
    });
    observer?.({ state: "final", joined: false, targetMatched: false });
    emit({ state: result.state, inputObserved, outputObserved });
    return result;
  } finally {
    clearTimeout(inputEndTimer);
    clearInterval(healthTimer);
    emitHealth();
    transport.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = acquireLiveCallProcessLock();
  const stop = createSupportedStopWatcher();
  runMeetronWindowsLive({ signal: stop.controller.signal })
    .catch((error) => {
      if (stop.requested && /stopped explicitly/i.test(error.message)) {
        process.stdout.write(`${JSON.stringify({ phase: "meetron-windows-live", state: "supported-stop-complete", exactCurrentCodexTask: true, secretOutput: false, identifierOutput: false })}\n`);
      } else {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      }
    })
    .finally(() => { stop.close(); release(); });
}
