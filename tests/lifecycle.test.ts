import assert from "node:assert/strict";
import test from "node:test";
import { MemoryAuditLog } from "../src/core/audit.ts";
import { SessionLifecycle } from "../src/core/lifecycle.ts";

test("session requires an explicit allowlisted start and explicit stop", () => {
  const audit = new MemoryAuditLog(() => new Date("2026-08-22T00:00:00.000Z"));
  const lifecycle = new SessionLifecycle(audit);
  lifecycle.markReady();
  lifecycle.start({ explicit: true, authorization: { allowed: true, reason: "allowlisted" } });
  assert.equal(lifecycle.state, "active");
  lifecycle.stop(true);
  assert.equal(lifecycle.state, "stopped");
  assert.deepEqual(audit.snapshot().map((event) => event.type), [
    "start-requested",
    "session-started",
    "stop-requested",
    "session-stopped",
  ]);
});

test("implicit or unauthorized starts fail without becoming active", () => {
  const implicit = new SessionLifecycle(new MemoryAuditLog());
  implicit.markReady();
  assert.throws(
    () => implicit.start({ explicit: false, authorization: { allowed: true, reason: "allowlisted" } }),
    /explicit-start-required/,
  );
  assert.equal(implicit.state, "ready");

  const unauthorized = new SessionLifecycle(new MemoryAuditLog());
  unauthorized.markReady();
  assert.throws(
    () => unauthorized.start({ explicit: true, authorization: { allowed: false, reason: "user-not-allowed" } }),
    /user-not-allowed/,
  );
  assert.equal(unauthorized.state, "ready");
});
