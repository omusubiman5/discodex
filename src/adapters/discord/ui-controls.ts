import type { BridgeConfig, CommandContext, SessionState } from "../../core/contracts.ts";
import { authorizeDiscordCommand } from "../../core/authorization.ts";
import type { BridgeFailureCode } from "./bridge-lifecycle.ts";

export type DiscordUiCommand = "connect" | "disconnect" | "status" | "gain";

export interface DiscordInteraction {
  readonly id: string;
  readonly context: CommandContext;
  readonly command: DiscordUiCommand;
  readonly createdAt: number;
  readonly options?: { readonly linear?: number };
}

export interface DiscordUiRegistration {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly string[];
}

export const DISCORD_UI_CONTROLS: readonly DiscordUiRegistration[] = [
  { name: "connect", description: "Connect the current Codex task to Discord voice." },
  { name: "disconnect", description: "Disconnect the current Codex task from Discord voice." },
  { name: "status", description: "Show redacted bridge status." },
  { name: "gain", description: "Set Codex-to-Discord output gain (linear 0.25–1.0).", options: ["linear"] },
];

export interface UiControlState {
  readonly sessionState: SessionState;
  readonly gainLinear: number;
}

export interface UiControlResult {
  readonly ok: boolean;
  readonly message: string;
  readonly state: UiControlState;
}

export interface DiscordBridgeLifecyclePort {
  readonly state: "disconnected" | "connecting" | "connected" | "degraded";
  readonly owner: string;
  connect(): void;
  waitUntilReady?(): Promise<void>;
  failureCode?(): BridgeFailureCode | undefined;
  disconnect(): void;
  status(): { readonly state: DiscordBridgeLifecyclePort["state"]; readonly owner: string; readonly channel: "configured-target-matched" | "configured-target-mismatch" | "unknown" };
}
export interface DiscordGainStore {
  readonly degraded?: boolean;
  load(): number;
  save(value: number): void;
}

const MAX_AGE_MS = 5 * 60 * 1000;
const MIN_GAIN_LINEAR = 0.25;
const MAX_GAIN_LINEAR = 1;

export class DiscordUiControlSurface {
  readonly #config: BridgeConfig["discord"];
  readonly #now: () => number;
  readonly #lifecycle?: DiscordBridgeLifecyclePort;
  readonly #gainStore?: DiscordGainStore;
  readonly #seen = new Set<string>();
  #state: UiControlState;

  constructor(config: BridgeConfig["discord"], options: { now?: () => number; initialState?: UiControlState; lifecycle?: DiscordBridgeLifecyclePort; gainStore?: DiscordGainStore } = {}) {
    this.#config = config;
    this.#now = options.now ?? (() => Date.now());
    this.#lifecycle = options.lifecycle;
    this.#gainStore = options.gainStore;
    this.#state = options.initialState ?? { sessionState: "ready", gainLinear: options.gainStore?.load() ?? 0.5 };
  }

  get state(): UiControlState { return this.#state; }

  handle(interaction: DiscordInteraction): UiControlResult {
    const reject = (message: string): UiControlResult => ({ ok: false, message, state: this.#state });
    if (!interaction.id || this.#seen.has(interaction.id)) return reject("Interaction rejected.");
    if (!Number.isSafeInteger(interaction.createdAt) || Math.abs(this.#now() - interaction.createdAt) > MAX_AGE_MS) return reject("Interaction rejected.");
    if (!DISCORD_UI_CONTROLS.some((control) => control.name === interaction.command)) return reject("Interaction rejected.");
    const decision = authorizeDiscordCommand(this.#config, { ...interaction.context, command: interaction.command });
    if (!decision.allowed) return reject("Interaction rejected.");
    this.#seen.add(interaction.id);
    if (interaction.command === "connect") {
      if (this.#state.sessionState === "active") return { ok: true, message: "Already connected.", state: this.#state };
      if (this.#state.sessionState !== "ready" && this.#state.sessionState !== "stopped") return reject("Interaction rejected.");
      this.#lifecycle?.connect();
      this.#state = { ...this.#state, sessionState: "active" };
      return { ok: true, message: "Connected.", state: this.#state };
    }
    if (interaction.command === "disconnect") {
      if (this.#state.sessionState !== "active") return reject("Interaction rejected.");
      this.#lifecycle?.disconnect();
      this.#state = { ...this.#state, sessionState: "stopped" };
      return { ok: true, message: "Disconnected.", state: this.#state };
    }
    if (interaction.command === "gain") {
      const linear = interaction.options?.linear;
      if (typeof linear !== "number" || !Number.isFinite(linear) || linear < MIN_GAIN_LINEAR || linear > MAX_GAIN_LINEAR) return reject("Interaction rejected.");
      try { this.#gainStore?.save(linear); } catch { return reject("Interaction rejected."); }
      this.#state = { ...this.#state, gainLinear: linear };
      return { ok: true, message: `Output gain set to ${linear} linear.`, state: this.#state };
    }
    if (this.#lifecycle) {
      const status = this.#lifecycle.status();
      return { ok: true, message: `Status: ${status.state}; channel ${status.channel}; owner ${status.owner}; output gain ${this.#state.gainLinear} linear (default 0.5, range 0.25–1.0, persistence scoped).${this.#gainStore?.degraded ? " degraded" : ""}`, state: this.#state };
    }
    return { ok: true, message: `Status: ${this.#state.sessionState}; output gain ${this.#state.gainLinear} linear.`, state: this.#state };
  }

  async handleAsync(interaction: DiscordInteraction): Promise<UiControlResult> {
    const reject = (message: string): UiControlResult => ({ ok: false, message, state: this.#state });
    if (interaction.command !== "connect") return this.handle(interaction);
    if (!interaction.id || this.#seen.has(interaction.id)) return reject("Interaction rejected.");
    if (!Number.isSafeInteger(interaction.createdAt) || Math.abs(this.#now() - interaction.createdAt) > MAX_AGE_MS) return reject("Interaction rejected.");
    const decision = authorizeDiscordCommand(this.#config, { ...interaction.context, command: "connect" });
    if (!decision.allowed) return reject("Interaction rejected.");
    if (this.#state.sessionState === "active") {
      this.#seen.add(interaction.id);
      return { ok: true, message: "Already connected.", state: this.#state };
    }
    if (this.#state.sessionState !== "ready" && this.#state.sessionState !== "stopped") return reject("Interaction rejected.");
    this.#seen.add(interaction.id);
    try {
      this.#lifecycle?.connect();
      await this.#lifecycle?.waitUntilReady?.();
    } catch {
      const failure = this.#lifecycle?.failureCode?.();
      this.#lifecycle?.disconnect();
      const messages: Partial<Record<BridgeFailureCode, string>> = {
        "codex-debugger-unavailable": "Connection blocked: current Codex Desktop has no local audio attachment endpoint; no runner was started.",
        "codex-voice-inactive": "Connection blocked: the exact Codex task has no active voice call; no runner was started.",
        "codex-sender-unavailable": "Connection blocked: start the Codex voice call in this task first; no runner was started.",
        "codex-route-attachment-failed": "Connection blocked: the Codex call input route could not be attached and was restored; no runner was started.",
        "discord-voice-ready-failed": "Connection failed before Discord voice Ready; the bridge was cleaned up.",
      };
      return reject(failure ? messages[failure]! : "Connection failed before Discord voice Ready; the bridge was cleaned up.");
    }
    this.#state = { ...this.#state, sessionState: "active" };
    return { ok: true, message: "Connected.", state: this.#state };
  }
}
