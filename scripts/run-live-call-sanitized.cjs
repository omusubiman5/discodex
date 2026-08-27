const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { resolve } = require("node:path");

const child = spawn(process.execPath, [resolve("src/discord-gateway-smoke.ts"), "--phase", "live-call"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

process.stdout.write(`${JSON.stringify({
  phase: "live-call",
  state: "sanitized-runner-started",
  childPid: child.pid,
  secretOutput: false,
  identifierOutput: false,
})}\n`);

let pending = "";
let stderrObserved = false;
const stderrHash = createHash("sha256");
let stderrBytes = 0;
const stderrCategories = new Set();

function classifyStderr(value) {
  const text = value.toString("utf8");
  if (/Unhandled 'error' event|ERR_UNHANDLED_ERROR/i.test(text)) stderrCategories.add("unhandled-error-event");
  if (/uncaught exception|uncaughtException/i.test(text)) stderrCategories.add("uncaught-exception");
  if (/unhandled rejection|unhandledRejection/i.test(text)) stderrCategories.add("unhandled-rejection");
  if (/already has an active|active text turn|turn.*active/i.test(text)) stderrCategories.add("active-turn-conflict");
  if (/current Codex task voice turn failed|turn\/completed|codex.*turn.*failed/i.test(text)) stderrCategories.add("codex-turn-failure");
  if (/Windows speech operation failed|speech recognition|speech synthesis/i.test(text)) stderrCategories.add("windows-speech-failure");
  if (/ECONN|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|socket hang up|network/i.test(text)) stderrCategories.add("network-failure");
  if (/MaxListenersExceededWarning|DeprecationWarning|ExperimentalWarning/i.test(text)) stderrCategories.add("runtime-warning");
}
function forwardSafeJson(line) {
  try {
    const value = JSON.parse(line);
    if (value?.secretOutput === false && value?.identifierOutput === false) {
      process.stdout.write(`${JSON.stringify(value)}\n`);
    }
  } catch {
    // Runtime diagnostics can contain transcript/response text. Drop all
    // non-contract stdout at this process boundary instead of persisting it.
  }
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf("\n");
    if (newline < 0) break;
    forwardSafeJson(pending.slice(0, newline).trim());
    pending = pending.slice(newline + 1);
  }
});
child.stderr.on("data", (chunk) => {
  stderrBytes += chunk.length;
  stderrHash.update(chunk);
  classifyStderr(chunk);
  if (stderrObserved) return;
  stderrObserved = true;
  process.stdout.write(`${JSON.stringify({
    phase: "live-call",
    state: "diagnostic-stderr-observed",
    secretOutput: false,
    identifierOutput: false,
  })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}
child.once("error", () => {
  process.stdout.write(`${JSON.stringify({
    phase: "live-call",
    state: "runner-spawn-error",
    secretOutput: false,
    identifierOutput: false,
  })}\n`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  if (pending.trim()) forwardSafeJson(pending.trim());
  process.stdout.write(`${JSON.stringify({
    phase: "live-call",
    state: "sanitized-runner-stopped",
    exitCode: code,
    signaled: Boolean(signal),
    secretOutput: false,
    identifierOutput: false,
  })}\n`);
  if (stderrObserved) {
    process.stdout.write(`${JSON.stringify({
      phase: "live-call",
      state: "diagnostic-stderr-classified",
      categories: [...stderrCategories].sort(),
      bytes: stderrBytes,
      sha256: stderrHash.digest("hex"),
      secretOutput: false,
      identifierOutput: false,
    })}\n`);
  }
  process.exitCode = code ?? 1;
});
