import type {
  BridgeConfig,
  DryRunReport,
  SessionState,
  TransportAdapter,
  AuditSink,
} from "./contracts.ts";

const ALLOWED_TRANSITIONS: Record<SessionState, SessionState[]> = {
  idle: ["planning", "stopped"],
  planning: ["ready", "blocked", "stopped"],
  ready: ["starting", "stopped"],
  blocked: ["stopped"],
  starting: ["active", "stopping"],
  active: ["stopping"],
  stopping: ["stopped"],
  stopped: [],
};

export class SessionPlanner {
  #state: SessionState = "idle";
  readonly #audit?: AuditSink;

  constructor(audit?: AuditSink) {
    this.#audit = audit;
  }

  get state(): SessionState {
    return this.#state;
  }

  transition(next: SessionState): void {
    if (!ALLOWED_TRANSITIONS[this.#state].includes(next)) {
      throw new Error(`Invalid session transition: ${this.#state} -> ${next}`);
    }
    this.#state = next;
  }

  async dryRun(config: BridgeConfig, adapter: TransportAdapter): Promise<DryRunReport> {
    this.#audit?.record({
      type: "plan-requested",
      state: this.#state,
      outcome: "accepted",
      actorClass: "local-user",
    });
    this.transition("planning");
    const plan = await adapter.plan(config);
    this.transition(plan.blockers.length === 0 ? "ready" : "blocked");
    this.#audit?.record({
      type: "plan-completed",
      state: this.#state,
      outcome: "completed",
      actorClass: "local-user",
      reasonCode: plan.blockers.length === 0 ? "ready" : "blocked-by-plan",
    });

    return {
      project: "codex-discord-voice-bridge",
      mode: "dry-run",
      state: this.state,
      generatedAt: new Date().toISOString(),
      guarantees: [
        "No Discord or Google API connection was opened.",
        "No UDP socket was opened.",
        "No bot token, OAuth credential, or cookie was read.",
        "No server, channel, application, or external resource was created.",
        "No Codex process, browser profile, audio device, or OS setting was changed.",
      ],
      plan,
    };
  }
}
