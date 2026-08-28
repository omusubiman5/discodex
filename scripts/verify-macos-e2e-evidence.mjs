#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) throw new Error("Pass the sanitized macOS JSONL evidence path.");
const records = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); } catch { throw new Error(`Evidence line ${index + 1} is not JSON.`); }
});
const live = records.filter((record) => record.phase === "meetron-macos-live");
if (live.length === 0) throw new Error("No macOS live-runner evidence was found.");
if (live.some((record) => record.secretOutput !== false || record.identifierOutput !== false)) {
  throw new Error("Evidence sanitation markers are missing or unsafe.");
}
const states = new Set(live.map((record) => record.state));
for (const required of ["joined-ready", "discord-input-observed", "codex-realtime-output-observed", "discord-output-sent", "turn-roundtrip-completed"]) {
  if (!states.has(required)) throw new Error(`Required macOS E2E state is missing: ${required}`);
}
const stages = new Set(live.filter((record) => record.state === "stage").map((record) => record.stage));
for (const required of ["udp-received", "dave-decrypted", "pcm-generated", "dave-epoch-active", "dave-ratchet-selected", "response-encoded"]) {
  if (!stages.has(required)) throw new Error(`Required encrypted-media stage is missing: ${required}`);
}
const health = live.filter((record) => record.state === "health").at(-1);
if (!health) throw new Error("Final macOS health record is missing.");
const counts = health.counts || {};
for (const field of ["udpReceived", "daveDecrypted", "pcmGenerated", "codexRealtimeInput", "codexRealtimeOutput", "discordOutputSent", "daveEpochs", "daveRatchets"]) {
  if (!Number.isSafeInteger(counts[field]) || counts[field] <= 0) throw new Error(`Final macOS counter did not pass: ${field}`);
}
if (counts.codexInputFailed !== 0) throw new Error("Codex input failures were recorded.");
if (!Number.isSafeInteger(health.completedTurns) || health.completedTurns < 2) throw new Error("At least two completed causal turns are required.");
process.stdout.write(`${JSON.stringify({ platform: "macos", state: "automated-evidence-pass", completedTurns: health.completedTurns, secretOutput: false, identifierOutput: false })}\n`);
