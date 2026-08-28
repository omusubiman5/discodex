import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadDependencyManifest, runDependencyPreflight, versionAtLeast } from "../src/dependencies/preflight.ts";
import { run } from "../src/cli.ts";

const projectRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));

test("version comparison enforces the project Node floor", () => {
  assert.equal(versionAtLeast("v26.0.0", "26.0.0"), true);
  assert.equal(versionAtLeast("v25.9.0", "26.0.0"), false);
});

test("dependency manifest pins only official libdave crypto", () => {
  const manifest = loadDependencyManifest(projectRoot);
  assert.equal(manifest.libdave.cryptoProvider, "discord/libdave");
  assert.equal(manifest.libdave.commit, "52cd56dc550f447fb354b3a06c9e2d2e2a4309c6");
  assert.equal(manifest.libdave.persistentKeys, false);
  assert.equal(manifest.discordVoiceSdk.daveProvider, "@snazzah/davey");
  assert.equal(manifest.discordVoiceSdk.decision, "connection-layer-reference-only");
  assert.ok(manifest.macosNativeBuild.required.includes("swift"));
});

test("dependencies command reports the pinned official manifest as JSON", async () => {
  const output = JSON.parse(await run(["dependencies", "--json"]));
  assert.equal(output.libdave.cryptoProvider, "discord/libdave");
  assert.equal(output.libdave.commit, "52cd56dc550f447fb354b3a06c9e2d2e2a4309c6");
  assert.equal(output.libdave.persistentKeys, false);
});

test("native addon source keeps Windows and macOS/POSIX Node symbol loaders", () => {
  const source = readFileSync(join(projectRoot, "work", "node-native-binding-probe", "probe.cpp"), "utf8");
  assert.match(source, /#ifdef _WIN32/);
  assert.match(source, /GetProcAddress/);
  assert.match(source, /dlsym\(RTLD_DEFAULT/);
  assert.match(source, /__attribute__\(\(visibility\("default"\)\)\)/);
});

test("token-free preflight reports guarantees and does not claim Discord readiness", () => {
  const report = runDependencyPreflight(projectRoot);
  assert.equal(report.mode, "token-free-preflight");
  assert.equal(report.state, "blocked");
  assert.ok(report.guarantees.some((item) => item.includes("No Discord bot token")));
  assert.ok(report.checks.some((item) => item.id === "discordjs-voice-fit" && item.status === "blocked"));
});
