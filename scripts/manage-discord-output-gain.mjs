#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DEFAULT_OUTPUT_GAIN_LINEAR,
  DiscordOutputGainPersistence,
  MAX_OUTPUT_GAIN_LINEAR,
  MIN_OUTPUT_GAIN_LINEAR,
} from "../src/adapters/discord/output-gain-safety.ts";

const action = process.argv[2];
if (!new Set(["get", "set"]).has(action)) throw new Error("Usage: manage-discord-output-gain get|set <linear>");
const runtimePath = process.env.CODEX_BRIDGE_MEETRON_RUNTIME_CONFIG
  || resolve(process.platform === "darwin" ? "runtime/meetron-macos-live.json" : "runtime/meetron-windows-live.json");
const storePath = process.env.CODEX_BRIDGE_GAIN_STORE_PATH || resolve("runtime/discord-output-gain.json");
const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
if (!/^\d{16,22}$/.test(runtime.discordGuildId ?? "") || !/^\d{16,22}$/.test(runtime.discordVoiceChannelId ?? "")) {
  throw new Error("The approved Discord gain scope is invalid.");
}
const store = new DiscordOutputGainPersistence(storePath, runtime.discordGuildId, runtime.discordVoiceChannelId);
if (action === "set") {
  if (process.argv.length !== 4) throw new Error("One output gain value is required.");
  const value = Number(process.argv[3]);
  if (!Number.isFinite(value) || value < MIN_OUTPUT_GAIN_LINEAR || value > MAX_OUTPUT_GAIN_LINEAR) {
    throw new Error("Output gain is outside the approved linear range.");
  }
  store.save(value);
}
const gainLinear = store.load();
process.stdout.write(`${JSON.stringify({
  gainLinear,
  gainPercent: Math.round(gainLinear * 100),
  minimumPercent: Math.round(MIN_OUTPUT_GAIN_LINEAR * 100),
  maximumPercent: Math.round(MAX_OUTPUT_GAIN_LINEAR * 100),
  defaultPercent: Math.round(DEFAULT_OUTPUT_GAIN_LINEAR * 100),
  limiterDbtp: -1,
  degraded: store.degraded,
  secretOutput: false,
  identifierOutput: false,
})}\n`);
