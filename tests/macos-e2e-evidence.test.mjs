import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const verifier = resolve("scripts/verify-macos-e2e-evidence.mjs");
const safe = { phase: "meetron-macos-live", secretOutput: false, identifierOutput: false };

test("macOS evidence verifier requires two sanitized encrypted causal round trips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discodex-macos-evidence-"));
  const path = join(directory, "evidence.jsonl");
  const records = [
    { ...safe, state: "joined-ready" },
    { ...safe, state: "discord-input-observed" },
    { ...safe, state: "codex-realtime-output-observed" },
    { ...safe, state: "discord-output-sent" },
    { ...safe, state: "turn-roundtrip-completed" },
    ...["udp-received", "dave-decrypted", "pcm-generated", "dave-epoch-active", "dave-ratchet-selected", "response-encoded"].map((stage) => ({ ...safe, state: "stage", stage })),
    { ...safe, state: "health", completedTurns: 2, counts: {
      udpReceived: 2, daveDecrypted: 2, pcmGenerated: 2, codexRealtimeInput: 2,
      codexRealtimeOutput: 2, discordOutputSent: 2, daveEpochs: 1, daveRatchets: 1, codexInputFailed: 0,
    } },
  ];
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const { stdout } = await execFileAsync(process.execPath, [verifier, path]);
  assert.equal(JSON.parse(stdout).state, "automated-evidence-pass");
});

test("macOS evidence verifier rejects a connection-only log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "discodex-macos-evidence-"));
  const path = join(directory, "evidence.jsonl");
  await writeFile(path, `${JSON.stringify({ ...safe, state: "joined-ready" })}\n`);
  await assert.rejects(execFileAsync(process.execPath, [verifier, path]), /Required macOS E2E state is missing/);
});
