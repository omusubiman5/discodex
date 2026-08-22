import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateConfig } from "../src/core/config.ts";

async function example(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL("../config/bridge.example.json", import.meta.url), "utf8"));
}

test("example config is valid and dry-run only", async () => {
  const config = validateConfig(await example());
  assert.equal(config.mode, "dry-run");
  assert.equal(config.transport, "discord");
  assert.equal(config.codex.cdpHost, "127.0.0.1");
  assert.equal(config.meet.enabled, false);
});

test("future Meet adapter cannot be enabled in the Discord MVP", async () => {
  const raw = await example();
  (raw.meet as Record<string, unknown>).enabled = true;
  assert.throws(() => validateConfig(raw), /Meet adapter must remain disabled/);
});

test("embedded token fields are rejected", async () => {
  const raw = await example();
  (raw.discord as Record<string, unknown>).botToken = "not-a-real-token";
  assert.throws(() => validateConfig(raw), /Secret-like field is forbidden/);
});

test("live mode is rejected", async () => {
  const raw = await example();
  raw.mode = "live";
  assert.throws(() => validateConfig(raw), /Only mode=dry-run/);
});

test("DAVE cannot be disabled or replaced", async () => {
  const raw = await example();
  const discord = raw.discord as Record<string, unknown>;
  discord.dave = { required: false, provider: "custom" };
  assert.throws(() => validateConfig(raw), /Discord DAVE must be required/);
});
