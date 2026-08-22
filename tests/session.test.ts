import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateConfig } from "../src/core/config.ts";
import { SessionPlanner } from "../src/core/session.ts";
import { DiscordAdapter } from "../src/adapters/discord/discord-adapter.ts";
import { MemoryAuditLog } from "../src/core/audit.ts";

async function config() {
  const raw = JSON.parse(await readFile(new URL("../config/bridge.example.json", import.meta.url), "utf8"));
  return validateConfig(raw);
}

test("Discord dry-run is blocked without any live side effect", async () => {
  const audit = new MemoryAuditLog(() => new Date("2026-08-22T00:00:00.000Z"));
  const planner = new SessionPlanner(audit);
  const report = await planner.dryRun(await config(), new DiscordAdapter());
  assert.equal(report.mode, "dry-run");
  assert.equal(report.state, "blocked");
  assert.ok(report.plan.blockers.length >= 3);
  assert.ok(report.guarantees.some((item) => item.includes("No UDP socket")));
  assert.deepEqual(audit.snapshot().map((event) => event.type), ["plan-requested", "plan-completed"]);
});

test("invalid state transition is rejected", () => {
  const planner = new SessionPlanner();
  assert.throws(() => planner.transition("ready"), /Invalid session transition/);
});

test("live Discord connect is hard blocked", async () => {
  const adapter = new DiscordAdapter();
  await assert.rejects(adapter.connect(), /intentionally disabled/);
});
