import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { selectIdentityScopedTargets } from "../scripts/route-target-scope.mjs";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/inspect-codex-realtime-audio-route.mjs");

test("route scope fails closed without task identity and does not open unrelated targets", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/json/list") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ type: "page", id: `unrelated-${i}`, url: `app://other/${i}`, webSocketDebuggerUrl: `ws://127.0.0.1:9/${i}` }))));
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const child = spawn(process.execPath, [script], { env: { ...process.env, CODEX_DESKTOP_DEBUGGER_ENDPOINT: `http://127.0.0.1:${port}`, CODEX_THREAD_ID: "" } });
  let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  await new Promise((resolve) => server.close(resolve));
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).candidateTargets, 0);
  assert.equal(JSON.parse(stdout).liveAudioSenders, 0);
});

test("identity scope selects the owned main and optional voice overlay without assuming thread ID metadata", () => {
  const targets = Array.from({ length: 7 }, (_, i) => ({ type: "page", id: `target-${i}`, url: i === 3 ? "app://-/index.html" : `app://other/${i}`, webSocketDebuggerUrl: `ws://fixture/${i}` }));
  const selected = selectIdentityScopedTargets(targets, "REDACTED_CODEX_TASK_ID_3");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "target-3");
  const withOverlay = selectIdentityScopedTargets([...targets, { type: "page", id: "voice-overlay", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://fixture/voice" }], "REDACTED_CODEX_TASK_ID_3");
  assert.deepEqual(withOverlay.map((target) => target.id), ["voice-overlay"]);
  assert.equal(selectIdentityScopedTargets(targets, "" ).length, 0);
  assert.equal(selectIdentityScopedTargets([...targets, { type: "page", id: "duplicate", url: "app://-/index.html", webSocketDebuggerUrl: "ws://fixture/duplicate" }], "REDACTED_CODEX_TASK_ID_3").length, 0);
  assert.equal(selectIdentityScopedTargets([...targets, { type: "page", id: "overlay-a", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://fixture/a" }, { type: "page", id: "overlay-b", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://fixture/b" }], "REDACTED_CODEX_TASK_ID_3").length, 0);
});

test("route source contains identity-first scope and bounded restore retry", async () => {
  const source = await (await import("node:fs/promises")).readFile(script, "utf8");
  assert.match(source, /const scopedTargets = taskIdentity \? identityCandidates : \[\];/);
  const runtime = await (await import("node:fs/promises")).readFile(resolve(dirname(script), "../src/adapters/discord/production-control-runtime.ts"), "utf8");
  assert.match(runtime, /restoreAttempts = 1/);
});
