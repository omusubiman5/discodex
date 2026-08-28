#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeRoot = resolve(repoRoot, "runtime");
const outputRoot = resolve(repoRoot, "outputs");
const taskFile = resolve(runtimeRoot, "discodex-relay.thread-id");
const lockFile = resolve(runtimeRoot, "live-call.lock");
const endpoint = "http://127.0.0.1:9224";
const action = process.argv[2] || "status";
const has = (flag) => process.argv.includes(flag);

if (process.platform !== "darwin" && process.env.DISCODEX_RELAY_MACOS_TEST !== "1") fail("This Relay manager requires macOS.");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function output(value) {
  process.stdout.write(`${JSON.stringify({ ...value, secretOutput: false, identifierOutput: false })}\n`);
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: repoRoot, encoding: "utf8", timeout: options.timeout || 10_000, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) throw new Error((result.stderr || `${file} failed.`).trim());
  return result;
}

function processLines() {
  const result = run("/bin/ps", ["-ax", "-o", "pid=,command="], { allowFailure: true });
  return result.stdout.split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), command: match[2] } : null;
  }).filter(Boolean);
}

function matchingProcesses(pattern) {
  return processLines().filter(({ pid, command }) => pid !== process.pid && pattern.test(command));
}

function controlProcesses() {
  return matchingProcesses(/node(?:\s+|.*\/)(?:scripts\/)?run-discord-production-control\.mjs(?:\s|$)/);
}

function codexProcesses() {
  return matchingProcesses(/\/(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)(?:\s|$)/);
}

function readLockOwner() {
  if (!existsSync(lockFile)) return null;
  try { const value = Number(readFileSync(lockFile, "utf8").trim()); return Number.isSafeInteger(value) && value > 0 ? value : 0; }
  catch { return 0; }
}

async function routePrepared() {
  try {
    const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const targets = await response.json();
    return Array.isArray(targets) && targets.filter((target) => target?.type === "page" && target?.url === "app://-/index.html").length === 1;
  } catch { return false; }
}

async function snapshot() {
  const controls = controlProcesses();
  const lockOwner = readLockOwner();
  const lockPresent = lockOwner !== null;
  const runnerCount = lockPresent && controls.some(({ pid }) => pid === lockOwner) ? 1 : 0;
  return {
    controlCount: controls.length,
    runnerCount,
    lockPresent,
    routePrepared: await routePrepared(),
    healthy: controls.length <= 1 && runnerCount <= 1 && ((runnerCount === 1) === lockPresent),
  };
}

function exactTaskId() {
  if (!existsSync(taskFile)) throw new Error("Missing runtime/discodex-relay.thread-id. Configure the same exact Codex task used by Relay before launch.");
  const value = readFileSync(taskFile, "utf8").trim();
  if (!/^[0-9a-f-]{20,}$/i.test(value)) throw new Error("The fixed Codex task configuration is invalid.");
  return value;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

async function startControl() {
  exactTaskId();
  const before = await snapshot();
  if (before.controlCount !== 0) throw new Error("Fail-closed: production control is already running.");
  if (before.runnerCount !== 0 || before.lockPresent) throw new Error("Fail-closed: a runner or live-call lock already exists.");
  mkdirSync(outputRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const stdoutPath = resolve(outputRoot, `discord-production-control-macos-${stamp}.jsonl`);
  const stderrPath = resolve(outputRoot, `discord-production-control-macos-${stamp}.stderr.txt`);
  const stdout = openSync(stdoutPath, "a"); const stderr = openSync(stderrPath, "a");
  const child = spawn("/bin/zsh", [resolve(repoRoot, "scripts/run-discodex-macos.sh"), exactTaskId()], {
    cwd: repoRoot, detached: true, stdio: ["ignore", stdout, stderr], env: { ...process.env },
  });
  child.unref(); closeSync(stdout); closeSync(stderr);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    sleep(250);
    if (existsSync(stdoutPath) && readFileSync(stdoutPath, "utf8").includes('"state":"discord-ui-ready"')) {
      output({ ready: true, controlCount: 1, runnerCount: 0, lockPresent: false, stdoutFile: stdoutPath.split("/").at(-1), stderrFile: stderrPath.split("/").at(-1) });
      return;
    }
    try { process.kill(child.pid, 0); } catch { break; }
  }
  try { process.kill(child.pid, "SIGTERM"); } catch {}
  throw new Error("Production control did not reach discord-ui-ready; no automatic restart was attempted.");
}

async function prepareCodex() {
  exactTaskId();
  const before = await snapshot();
  if (before.runnerCount !== 0 || before.lockPresent) throw new Error("Use /disconnect before preparing Codex Desktop.");
  if (before.controlCount > 1) throw new Error("Fail-closed: multiple Relay controls exist.");
  if (before.routePrepared) {
    if (before.controlCount === 0) await startControl();
    else output({ ready: true, restarted: false, ...before });
    return;
  }
  const roots = codexProcesses();
  if (roots.length > 1) throw new Error("Fail-closed: multiple Codex Desktop roots exist.");
  if (roots.length === 1 && !has("--restart-existing")) throw new Error("Codex Desktop requires one Relay-managed restart before audio routing is available.");
  if (before.controlCount === 1) await stopControl();
  if (roots.length === 1) {
    run("/usr/bin/osascript", ["-e", 'tell application "Codex" to quit'], { allowFailure: true, timeout: 8_000 });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && codexProcesses().some(({ pid }) => pid === roots[0].pid)) sleep(250);
    for (const { pid } of roots) { try { process.kill(pid, "SIGTERM"); } catch {} }
  }
  run("/usr/bin/open", ["-na", "Codex", "--args", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9224"]);
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !(await routePrepared())) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  if (!(await routePrepared())) throw new Error("Codex Desktop did not expose the verified loopback audio attachment endpoint.");
  await startControl();
}

async function stopControl() {
  const before = await snapshot();
  if (before.controlCount === 0) { output({ stopped: false, alreadyStopped: true }); return; }
  if (before.controlCount !== 1) throw new Error("Fail-closed: production control ownership is not unique.");
  if (before.runnerCount !== 0 || before.lockPresent) throw new Error("Use /disconnect in Discord before stopping Relay.");
  process.kill(controlProcesses()[0].pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && controlProcesses().length !== 0) sleep(200);
  if (controlProcesses().length !== 0) throw new Error("Production control did not stop within the bounded window.");
  output({ stopped: true, alreadyStopped: false });
}

try {
  if (action === "status") output(await snapshot());
  else if (action === "prepare") await prepareCodex();
  else if (action === "start") await startControl();
  else if (action === "stop") await stopControl();
  else if (action === "gain") {
    const value = process.argv[3];
    if (value !== "get") { const numeric = Number(value); if (!Number.isFinite(numeric) || numeric < 0.25 || numeric > 1) throw new Error("Output gain is outside the approved range."); }
    const result = run(process.execPath, [resolve(repoRoot, "scripts/manage-discord-output-gain.mjs"), value === "get" ? "get" : "set", ...(value === "get" ? [] : [value])]); process.stdout.write(result.stdout);
  } else if (action === "screen-share") {
    const mode = process.argv[3]; if (!new Set(["start", "stop"]).has(mode)) throw new Error("Screen-share action is invalid.");
    const result = run(process.execPath, [resolve(repoRoot, "scripts/manage-discord-screen-share.mjs"), mode], { timeout: 100_000 }); process.stdout.write(result.stdout);
  } else throw new Error("Unknown Relay action.");
} catch (error) { fail(error instanceof Error ? error.message : "Relay operation failed."); }
