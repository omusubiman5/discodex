import type { AuditEvent, AuditSink } from "./contracts.ts";

export class MemoryAuditLog implements AuditSink {
  readonly #events: AuditEvent[] = [];
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  record(event: Omit<AuditEvent, "sequence" | "timestamp">): AuditEvent {
    const recorded: AuditEvent = Object.freeze({
      sequence: this.#events.length + 1,
      timestamp: this.#now().toISOString(),
      ...event,
    });
    this.#events.push(recorded);
    return recorded;
  }

  snapshot(): readonly AuditEvent[] {
    return Object.freeze([...this.#events]);
  }
}
