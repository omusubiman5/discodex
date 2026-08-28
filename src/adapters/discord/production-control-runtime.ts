import type { BridgeConfig } from "../../core/contracts.ts";
import { acquireLiveCallProcessLock } from "../../discord-gateway-smoke.ts";
import { runMeetronWindowsLive } from "../../../scripts/run-meetron-windows-live.mjs";
import { runMeetronMacosLive } from "../../../scripts/run-meetron-macos-live.mjs";
import { createDiscordBridgeLifecycle, createLiveCallRuntimeSnapshotProvider, type BridgeRuntimeSnapshot } from "./bridge-lifecycle.ts";
import { DiscordUiControlSurface } from "./ui-controls.ts";
import { DiscordOutputGainPersistence } from "./output-gain-safety.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DesktopOwnedCodexAppServerTransport } from "../../core/codex-app-server-rpc.ts";

export interface ProductionRunner {
  (options: { readonly signal: AbortSignal; readonly observer: (event: { readonly state: string; readonly joined: boolean; readonly targetMatched: boolean }) => void; readonly gainProvider?: () => number }): Promise<unknown>;
}

export interface CodexCallInputRoute {
  attach(): Promise<void>;
  restore(): Promise<void>;
}

const execFileAsync = promisify(execFile);
const routeScript = fileURLToPath(new URL("../../../scripts/inspect-codex-realtime-audio-route.mjs", import.meta.url));
// Real renderer object queries and graph attachment have measured up to 19 s
// on the supported Windows host. Keep the operation bounded without killing a
// healthy graph transaction at the former 15 s threshold.
const routeOperationTimeoutMs = 45_000;
const restoreAttempts = 1;

function parseRouteReport(stdout: string): Record<string, unknown> {
  const report = JSON.parse(stdout.trim());
  if (!report || typeof report !== "object") throw new Error("Codex call input route report is invalid.");
  return report;
}

/** Uses the already-audited non-owning sender seam and always retains rollback. */
export function createCodexCallInputRoute(
  injectedInspect?: (...args: string[]) => Promise<Record<string, unknown>>,
  injectedVerify?: () => Promise<unknown>,
): CodexCallInputRoute {
  const inspect = injectedInspect ?? (async (...args: string[]) => {
    try {
      const { stdout } = await execFileAsync(process.execPath, [routeScript, ...args], {
        windowsHide: true,
        timeout: routeOperationTimeoutMs,
      });
      return parseRouteReport(stdout);
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { killed?: boolean }).code === "ETIMEDOUT") {
        throw new Error(`Codex call input route operation timed out after ${routeOperationTimeoutMs}ms.`);
      }
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === "string" && stdout.trim().startsWith("{")) {
        return parseRouteReport(stdout);
      }
      throw error;
    }
  });
  const verify = injectedVerify ?? (injectedInspect ? async () => undefined : async () => {
    const threadId = process.env.CODEX_THREAD_ID?.trim();
    const debuggerEndpoint = process.env.CODEX_DESKTOP_DEBUGGER_ENDPOINT?.trim();
    if (!threadId || !/^[0-9a-f-]{20,}$/i.test(threadId) || !debuggerEndpoint) {
      throw new Error("The exact current Codex task route is not configured.");
    }
    const transport = new DesktopOwnedCodexAppServerTransport({ threadId, debuggerEndpoint });
    try {
      await transport.connect();
      return await transport.ensureForegroundRealtimeVoiceActive();
    } finally {
      transport.close();
    }
  });
  return {
    async attach() {
      // `/connect` owns the same native Voice Talk activation as the physical
      // M18 key. Identity is verified before that command can run.
      const activation = await verify();
      let before = await inspect();
      // The native Voice Talk surface becomes active slightly before its
      // WebRTC sender is published. This is a readiness handoff, not a
      // transport reconnect: permit exactly one additional readback only for
      // a voice session started by this `/connect` operation.
      if (activation === "started" && before.liveAudioSenders === 0) before = await inspect();
      // A prior renderer reload can orphan the CABLE track after losing the
      // in-renderer rollback object. `/connect` must reconcile that bridge-
      // owned residue before attempting a new attachment, not merely reject
      // it and leave the user's microphone unusable.
      if (before.liveAudioSenders === 1 && before.cableSenders === 1) {
        if (before.rollbackAvailable === true || before.graphAttached === true) {
          await inspect("--apply-physical-input").catch(() => undefined);
          before = await inspect();
        }
        if (before.liveAudioSenders === 1 && before.cableSenders === 1) {
          const reconciled = await inspect("--reconcile-physical-input");
          if (reconciled.applied !== true || reconciled.cableSenders !== 0) {
            throw new Error("A stale Codex CABLE input could not be reconciled to the physical input.");
          }
          before = await inspect();
        }
      }
      if (before.liveAudioSenders === 0) {
        throw new Error("The current Codex task has no live audio sender exposed for non-owning attachment.");
      }
      if (before.liveAudioSenders !== 1 || before.cableSenders !== 0 || typeof before.currentTrackLabel !== "string") {
        throw new Error("Exactly one reversible current Codex call input is required.");
      }
      const direct = await inspect("--apply-cable-input");
      if (direct.applied !== true || direct.cableSenders !== 1 || direct.previousTrackLabel !== before.currentTrackLabel) {
        throw new Error("The current Codex call input could not be attached reversibly.");
      }
      const graph = await inspect("--apply-cable-graph-input");
      // When Codex already owns the MediaStreamAudioDestinationNode, the
      // bridge reuses that destination and deliberately owns no AudioContext.
      // In that official existing-destination path there is no context state
      // to report; liveness is proven by both tracks and the exact sender.
      const contextHealthy = graph.graphMode === "existing-destination"
        ? graph.graphContextState === undefined
        : graph.graphContextState === "running";
      const graphHealthy = contextHealthy
        && graph.graphSourceTrackState === "live"
        && graph.graphDestinationTrackState === "live"
        && graph.graphSenderMatched === true;
      if (graph.applied !== true || graph.graphAttached !== true || graph.cableSenders !== 0 || !graphHealthy) {
        await inspect("--apply-physical-input").catch(() => undefined);
        throw new Error("The isolated virtual input could not be attached to a healthy current Codex audio graph.");
      }
    },
    async restore() {
      // Restoration is a bounded transaction.  A renderer can briefly lose
      // its sender while a target reloads; keep the original track in the
      // renderer rollback marker and retry the read/apply pair once, without
      // extending the host's overall shutdown deadline.
      let last: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < restoreAttempts; attempt += 1) {
        const current = await inspect();
        if (current.graphAttached !== true && current.cableSenders !== 1) return;
        try {
          const restored = await inspect("--apply-physical-input");
          last = restored;
          if (restored.applied === true && restored.cableSenders === 0 && restored.graphAttached !== true) return;
        } catch {
          // A transient target close/reload is retryable; the next inspect
          // re-selects the identity-scoped renderer.
        }
      }
      if (last) {
        throw new Error("The original Codex call input could not be restored.");
      } else {
        throw new Error("The Codex call input disappeared before bounded restore completed.");
      }
    },
  };
}

/** Composition used by the production control entrypoint; runner ownership stays bridge-local. */
export function createProductionDiscordControlRuntime(
  config: BridgeConfig["discord"],
  runner: ProductionRunner = (process.platform === "darwin" ? runMeetronMacosLive : runMeetronWindowsLive) as unknown as ProductionRunner,
  inputRoute: CodexCallInputRoute = createCodexCallInputRoute(),
  options: { readonly lockPath?: string } = {},
) {
  let controller: AbortController | undefined;
  let release: (() => void) | undefined;
  let task: Promise<unknown> | undefined;
  let voice = { joined: false, targetMatched: false };
  const gainStore = new DiscordOutputGainPersistence(process.env.CODEX_BRIDGE_GAIN_STORE_PATH || resolve("runtime/discord-output-gain.json"), config.guildId, config.voiceChannelId);
  const initialGain = gainStore.load();
  if (gainStore.degraded) gainStore.save(initialGain);
  const observer = (event: { readonly joined: boolean; readonly targetMatched: boolean }) => { voice = { joined: event.joined, targetMatched: event.targetMatched }; };
  const emit = (state: string) => process.stdout.write(`${JSON.stringify({ state, secretOutput: false, identifierOutput: false })}\n`);
  const classifyFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("route is not configured") || message.includes("debugger endpoint") || message.includes("Loopback Codex debugger")) return "codex-debugger-unavailable" as const;
    if (message.includes("Voice Talk") || message.includes("foreground voice")) return "codex-voice-inactive" as const;
    if (message.includes("no live audio sender") || message.includes("Exactly one reversible")) return "codex-sender-unavailable" as const;
    if (message.includes("attached reversibly") || message.includes("audio graph") || message.includes("could not be reconciled")
        || message.includes("Core Audio") || message.includes("virtual input")) return "codex-route-attachment-failed" as const;
    return "discord-voice-ready-failed" as const;
  };
  const lifecycle = createDiscordBridgeLifecycle({
    owner: process.platform === "darwin" ? "meetron-macos-live" : "meetron-windows-live",
    onConnect: () => {
      if (task) return "connecting";
      controller = new AbortController(); release = acquireLiveCallProcessLock(options.lockPath);
      const signal = controller.signal;
      task = (async () => {
        try {
          emit("codex-input-route-attaching");
          await inputRoute.attach();
          emit("codex-input-route-attached");
          if (signal.aborted) return;
          emit("discord-runner-starting");
          await runner({ signal, observer, gainProvider: () => gainStore.load() });
        } finally {
          emit("codex-input-route-restoring");
          await inputRoute.restore();
          emit("codex-input-route-restored");
        }
      })().catch((error) => {
        // An explicit `/disconnect` (and the bounded internal lifecycle
        // probe) aborts only the bridge-owned runner. That is successful
        // cleanup, not a failure-before-Ready condition.
        if (signal.aborted) return;
        const failure = classifyFailure(error);
        lifecycle.markFailed(failure);
        emit(`discord-runner-failed-before-ready:${failure}`);
      }).finally(() => { release?.(); release = undefined; task = undefined; controller = undefined; voice = { joined: false, targetMatched: false }; });
      return "connecting";
    },
    onDisconnect: () => { controller?.abort(); },
    runtimeSnapshot: createLiveCallRuntimeSnapshotProvider({ lockPath: options.lockPath, voice: () => voice }),
  });
  return { controls: new DiscordUiControlSurface(config, { lifecycle, gainStore }), lifecycle, gainStore };
}
