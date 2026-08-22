import type {
  AuditSink,
  AuthorizationDecision,
  SessionState,
} from "./contracts.ts";

export interface StartRequest {
  explicit: boolean;
  authorization: AuthorizationDecision;
}

export class SessionLifecycle {
  #state: SessionState = "idle";
  readonly #audit: AuditSink;

  constructor(audit: AuditSink) {
    this.#audit = audit;
  }

  get state(): SessionState {
    return this.#state;
  }

  markReady(): void {
    if (this.#state !== "idle") throw new Error(`Cannot become ready from ${this.#state}.`);
    this.#state = "ready";
  }

  start(request: StartRequest): void {
    this.#audit.record({
      type: "start-requested",
      state: this.#state,
      outcome: "accepted",
      actorClass: request.authorization.allowed ? "allowlisted-user" : "untrusted-user",
    });

    if (this.#state !== "ready") {
      this.#rejectStart("session-not-ready", request.authorization.allowed);
    }
    if (!request.explicit) {
      this.#rejectStart("explicit-start-required", request.authorization.allowed);
    }
    if (!request.authorization.allowed) {
      this.#rejectStart(request.authorization.reason, false);
    }

    this.#state = "starting";
    this.#state = "active";
    this.#audit.record({
      type: "session-started",
      state: this.#state,
      outcome: "completed",
      actorClass: "allowlisted-user",
    });
  }

  stop(explicit: boolean): void {
    this.#audit.record({
      type: "stop-requested",
      state: this.#state,
      outcome: explicit ? "accepted" : "rejected",
      actorClass: "local-user",
      reasonCode: explicit ? undefined : "explicit-stop-required",
    });
    if (!explicit) throw new Error("Explicit stop is required.");
    if (this.#state === "stopped") return;
    if (this.#state !== "active" && this.#state !== "ready" && this.#state !== "blocked") {
      throw new Error(`Cannot stop from ${this.#state}.`);
    }
    this.#state = "stopping";
    this.#state = "stopped";
    this.#audit.record({
      type: "session-stopped",
      state: this.#state,
      outcome: "completed",
      actorClass: "local-user",
    });
  }

  #rejectStart(reasonCode: string, trusted: boolean): never {
    this.#audit.record({
      type: "start-rejected",
      state: this.#state,
      outcome: "rejected",
      actorClass: trusted ? "allowlisted-user" : "untrusted-user",
      reasonCode,
    });
    throw new Error(`Session start rejected: ${reasonCode}`);
  }
}
