import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateConfig } from "../src/core/config.ts";
import { DISCORD_UI_CONTROLS, DiscordUiControlSurface } from "../src/adapters/discord/ui-controls.ts";
import { DiscordBridgeLifecycle } from "../src/adapters/discord/bridge-lifecycle.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function config() {
  const raw = JSON.parse(await readFile(new URL("../config/bridge.example.json", import.meta.url), "utf8"));
  return validateConfig(raw).discord;
}
const interaction = (command: "connect" | "disconnect" | "status" | "gain", config: Awaited<ReturnType<typeof config>>, id = command, options?: { linear?: number }) => ({
  id, command, options, createdAt: 1_000, context: { guildId: config.guildId, channelId: config.textChannelId, userId: config.allowedUserIds[0], command: "status" as const },
});

test("Discord UI registers four bounded controls and handles lifecycle/status/gain", async () => {
  const cfg = await config();
  assert.deepEqual(DISCORD_UI_CONTROLS.map((item) => item.name), ["connect", "disconnect", "status", "gain"]);
  const surface = new DiscordUiControlSurface(cfg, { now: () => 1_000 });
  assert.equal(surface.handle(interaction("connect", cfg)).ok, true);
  assert.equal(surface.handle(interaction("connect", cfg, "connect-again")).message, "Already connected.");
  assert.equal(surface.handle(interaction("status", cfg, "status-1")).message, "Status: active; output gain 0.5 linear.");
  assert.equal(surface.handle(interaction("gain", cfg, "gain-1", { linear: 0.75 })).ok, true);
  assert.equal(surface.handle(interaction("disconnect", cfg, "disconnect-1")).ok, true);
  assert.equal(surface.handle(interaction("disconnect", cfg, "disconnect-again")).message, "Already disconnected.");
});

test("Discord UI connect/disconnect/status delegates to the bridge lifecycle", async () => {
  const cfg = await config();
  const lifecycle = new DiscordBridgeLifecycle({ owner: "bridge-owner", onConnect: () => "connected", inspect: () => ({ lock: "runner-owned", voiceJoined: true, targetMatched: true }) });
  const surface = new DiscordUiControlSurface(cfg, { now: () => 1_000, lifecycle });
  assert.equal(surface.handle(interaction("connect", cfg, "connect-life")).ok, true);
  assert.match(surface.handle(interaction("status", cfg, "status-life")).message, /Status: connected; channel configured-target-matched; owner bridge-owner:runner-owned/);
  assert.equal(surface.handle(interaction("disconnect", cfg, "disconnect-life")).ok, true);
  assert.equal(lifecycle.state, "disconnected");
});

test("Discord UI async connect waits for the lifecycle Ready gate before acknowledging", async () => {
  const cfg = await config();
  let ready = false;
  const events: string[] = [];
  const lifecycle = {
    state: "connecting" as const,
    owner: "bridge-owner",
    connect() { events.push("connect"); },
    async waitUntilReady() { events.push("ready"); await new Promise((resolve) => setTimeout(resolve, 1)); ready = true; },
    disconnect() {},
    async disconnectAndWait() { events.push("disconnect-complete"); },
  };
  const surface = new DiscordUiControlSurface(cfg, { now: () => 1_000, lifecycle });
  const result = await surface.handleAsync(interaction("connect", cfg, "connect-ready"));
  assert.equal(ready, true);
  assert.equal(result.ok, true);
  assert.equal(result.message, "Connected.");
  assert.equal((await surface.handleAsync(interaction("connect", cfg, "connect-ready-again"))).message, "Connected.");
  assert.deepEqual(events, ["connect", "ready", "disconnect-complete", "connect", "ready"]);
});

test("Discord UI identifies a paused or completed Codex voice overlay", async () => {
  const cfg = await config();
  const lifecycle = {
    state: "degraded" as const,
    owner: "bridge-owner",
    connect() {},
    async waitUntilReady() { throw new Error("not ready"); },
    failureCode: () => "codex-inactive-overlay" as const,
    disconnect() {},
  };
  const surface = new DiscordUiControlSurface(cfg, { now: () => 1_000, lifecycle });
  const result = await surface.handleAsync(interaction("connect", cfg, "connect-inactive-overlay"));
  assert.equal(result.ok, false);
  assert.equal(result.message, "Connection blocked: a paused or completed Codex voice overlay is still open. Close it, then run /connect again; no runner was started.");
});

test("Discord UI fails closed for unauthorized, stale, replayed, malformed, and out-of-range interactions", async () => {
  const cfg = await config();
  const surface = new DiscordUiControlSurface(cfg, { now: () => 10_000 });
  const base = interaction("connect", cfg, "same");
  assert.equal(surface.handle({ ...base, context: { ...base.context, userId: "unlisted" } }).ok, false);
  assert.equal(surface.handle({ ...base, id: "stale", createdAt: -1_000_000 }).ok, false);
  assert.equal(surface.handle(base).ok, true);
  assert.equal(surface.handle(base).ok, false);
  assert.equal(surface.handle(interaction("gain", cfg, "bad-gain", { linear: 1.01 })).ok, false);
  assert.equal(surface.handle({ ...base, id: "bad-command", command: "status", context: { ...base.context, guildId: "other" } }).ok, false);
});
