import type { DiscordBridgeLifecyclePort } from "./ui-controls.ts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface BridgeLifecycleOptions {
  readonly owner: string;
  readonly inspect?: () => BridgeRuntimeSnapshot;
  readonly onConnect?: () => "connected" | "connecting";
  readonly onDisconnect?: () => void;
}

export type BridgeFailureCode =
  | "codex-debugger-unavailable"
  | "codex-voice-inactive"
  | "codex-sender-unavailable"
  | "codex-route-attachment-failed"
  | "discord-voice-ready-failed";

export interface BridgeRuntimeSnapshot {
  readonly lock: "absent" | "stale" | "non-runner" | "runner-owned";
  readonly voiceJoined: boolean;
  readonly targetMatched: boolean;
}

export interface DiscordVoiceJoinSnapshot {
  readonly joined: boolean;
  readonly targetMatched: boolean;
}

/** Read-only production snapshot provider for the existing live-call runner. */
export function createLiveCallRuntimeSnapshotProvider(options: {
  readonly lockPath?: string;
  readonly voice: () => DiscordVoiceJoinSnapshot;
  readonly runnerPid?: number;
}): () => BridgeRuntimeSnapshot {
  const lockPath = options.lockPath ?? resolve("runtime/live-call.lock");
  return () => {
    if (!existsSync(lockPath)) return { lock: "absent", voiceJoined: false, targetMatched: false };
    let pid = 0;
    try { pid = Number(readFileSync(lockPath, "utf8").trim()); } catch { return { lock: "stale", voiceJoined: false, targetMatched: false }; }
    if (!Number.isSafeInteger(pid) || pid <= 0) return { lock: "stale", voiceJoined: false, targetMatched: false };
    try { process.kill(pid, 0); } catch { return { lock: "stale", voiceJoined: false, targetMatched: false }; }
    const runnerPid = options.runnerPid ?? process.pid;
    if (pid !== runnerPid) return { lock: "non-runner", voiceJoined: false, targetMatched: false };
    const voice = options.voice();
    return { lock: "runner-owned", voiceJoined: voice.joined, targetMatched: voice.targetMatched };
  };
}

export function createDiscordBridgeLifecycle(options: BridgeLifecycleOptions & {
  readonly runtimeSnapshot: () => BridgeRuntimeSnapshot;
}): DiscordBridgeLifecycle {
  return new DiscordBridgeLifecycle({ ...options, inspect: options.runtimeSnapshot });
}

export class DiscordBridgeLifecycle implements DiscordBridgeLifecyclePort {
  #current: DiscordBridgeLifecyclePort["state"] = "disconnected";
  #failure?: BridgeFailureCode;
  #participant?: { user: string; session: string; ssrc: number };
  #participantTransition: "none" | "initial" | "rejoin-remap" = "none";
  readonly owner: string;
  readonly #onConnect?: () => void;
  readonly #onDisconnect?: () => void;
  readonly #inspect?: () => BridgeRuntimeSnapshot;

  constructor(options: BridgeLifecycleOptions) {
    if (!options.owner) throw new Error("Bridge owner is required.");
    this.owner = options.owner;
    this.#inspect = options.inspect;
    this.#onConnect = options.onConnect;
    this.#onDisconnect = options.onDisconnect;
  }
  get state(): DiscordBridgeLifecyclePort["state"] { return this.#current; }
  failureCode(): BridgeFailureCode | undefined { return this.#failure; }
  markFailed(code: BridgeFailureCode): void { this.#failure = code; this.#current = "degraded"; }
  connect(): void {
    if (this.#current === "connected" || this.#current === "connecting") return;
    this.#failure = undefined;
    this.#current = "connecting";
    try { this.#current = this.#onConnect?.() ?? "connecting"; }
    catch { this.#current = "degraded"; throw new Error("Discord bridge connection failed."); }
  }
  async waitUntilReady(timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#failure) throw new Error(`Discord bridge failed before Ready [${this.#failure}].`);
      const snapshot = this.#inspect?.();
      if (snapshot?.lock === "runner-owned" && snapshot.voiceJoined && snapshot.targetMatched) {
        this.#current = "connected";
        return;
      }
      if (this.#current === "disconnected") throw new Error("Discord bridge disconnected before Ready.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.#current = "degraded";
    throw new Error("Discord bridge did not reach voice Ready before the bounded timeout.");
  }
  disconnect(): void {
    if (this.#current === "disconnected") return;
    try { this.#onDisconnect?.(); } finally { this.#participant = undefined; this.#participantTransition = "none"; this.#current = "disconnected"; }
  }
  observeParticipant(user: string, session: string, ssrc: number): void {
    if (!user || !session || !Number.isSafeInteger(ssrc) || ssrc <= 0) throw new Error("Discord participant state is invalid.");
    this.#participantTransition = this.#participant === undefined ? "initial" : (this.#participant.session !== session || this.#participant.ssrc !== ssrc ? "rejoin-remap" : "none");
    this.#participant = { user, session, ssrc };
  }
  participantState(): { readonly connected: boolean; readonly transition: "none" | "initial" | "rejoin-remap" } {
    return { connected: this.#participant !== undefined, transition: this.#participantTransition };
  }
  status(): { readonly state: DiscordBridgeLifecyclePort["state"]; readonly owner: string; readonly channel: "configured-target-matched" | "configured-target-mismatch" | "configured-target-idle" | "unknown" } {
    const snapshot = this.#inspect?.() ?? { lock: "absent", voiceJoined: false, targetMatched: false };
    const healthy = snapshot.lock === "runner-owned" && snapshot.voiceJoined && snapshot.targetMatched;
    const state = healthy ? "connected" : (this.#current === "disconnected" ? "disconnected" : "degraded");
    if (state === "disconnected" && snapshot.lock === "absent") {
      return { state, owner: "none", channel: "configured-target-idle" };
    }
    return { state, owner: snapshot.lock === "runner-owned" ? `${this.owner}:runner-owned` : `${this.owner}:runner-unverified`, channel: snapshot.targetMatched ? "configured-target-matched" : snapshot.lock === "absent" ? "unknown" : "configured-target-mismatch" };
  }
}
