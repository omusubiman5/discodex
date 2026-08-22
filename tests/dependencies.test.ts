import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { loadDependencyManifest, runDependencyPreflight, versionAtLeast } from "../src/dependencies/preflight.ts";

const projectRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));

test("version comparison enforces the project Node floor", () => {
  assert.equal(versionAtLeast("v24.15.0", "24.0.0"), true);
  assert.equal(versionAtLeast("v23.9.0", "24.0.0"), false);
});

test("dependency manifest pins only official libdave crypto", () => {
  const manifest = loadDependencyManifest(projectRoot);
  assert.equal(manifest.libdave.cryptoProvider, "discord/libdave");
  assert.equal(manifest.libdave.commit, "52cd56dc550f447fb354b3a06c9e2d2e2a4309c6");
  assert.equal(manifest.libdave.persistentKeys, false);
  assert.equal(manifest.discordVoiceSdk.daveProvider, "@snazzah/davey");
  assert.equal(manifest.discordVoiceSdk.decision, "connection-layer-reference-only");
});

test("token-free preflight reports guarantees and does not claim Discord readiness", () => {
  const report = runDependencyPreflight(projectRoot);
  assert.equal(report.mode, "token-free-preflight");
  assert.equal(report.state, "blocked");
  assert.ok(report.guarantees.some((item) => item.includes("No Discord bot token")));
  assert.ok(report.checks.some((item) => item.id === "discordjs-voice-fit" && item.status === "blocked"));
});
