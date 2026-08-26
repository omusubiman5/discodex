#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateConfig } from "../src/core/config.ts";
import { createProductionDiscordControlRuntime } from "../src/adapters/discord/production-control-runtime.ts";

const configPath = process.env.CODEX_BRIDGE_CONFIG || resolve("config/bridge.example.json");
const lockPath = resolve("runtime/live-call.lock");
const readyTimeoutMs = 90_000;
const cleanupTimeoutMs = 30_000;
const holdArgument = process.argv.find((argument) => argument.startsWith("--hold-ms="));
const holdMs = holdArgument ? Number(holdArgument.slice("--hold-ms=".length)) : 0;
if (!Number.isSafeInteger(holdMs) || holdMs < 0 || holdMs > 120_000) {
  throw new Error("Fail-closed: --hold-ms must be an integer from 0 through 120000.");
}

const emit = (state, extra = {}) => process.stdout.write(`${JSON.stringify({
  phase: "production-lifecycle-probe",
  timestamp: new Date().toISOString(),
  state,
  ...extra,
  secretOutput: false,
  identifierOutput: false,
})}\n`);

async function waitForCleanup() {
  const deadline = Date.now() + cleanupTimeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(lockPath)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

if (existsSync(lockPath)) throw new Error("Fail-closed: a live-call lock already exists.");

const raw = JSON.parse(await readFile(configPath, "utf8"));
const config = validateConfig(raw).discord;
const runtime = createProductionDiscordControlRuntime(config, undefined, undefined, { lockPath });
let outcome = "failed-before-ready";
try {
  emit("connecting");
  runtime.lifecycle.connect();
  await runtime.lifecycle.waitUntilReady(readyTimeoutMs);
  outcome = "voice-ready";
  emit("voice-ready", { status: runtime.lifecycle.status() });
  if (holdMs > 0) {
    emit("holding-for-media-evidence", { holdMs });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, holdMs));
  }
} catch (error) {
  emit("failed-before-ready", {
    failureCode: runtime.lifecycle.failureCode() || "bounded-timeout-or-unclassified",
    message: error instanceof Error ? error.message : "Unknown lifecycle failure.",
  });
} finally {
  runtime.lifecycle.disconnect();
  emit("disconnect-requested");
  const cleaned = await waitForCleanup();
  emit(cleaned ? "cleanup-complete" : "cleanup-timeout", { lockPresent: existsSync(lockPath) });
  if (!cleaned) process.exitCode = 2;
  else if (outcome !== "voice-ready") process.exitCode = 1;
}
