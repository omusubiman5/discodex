import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { MacosExistingGptLiveAudio } from "../src/adapters/macos/existing-gpt-live-audio.mjs";
import { loadMeetronMacosLiveEnvironment } from "../scripts/run-meetron-macos-live.mjs";
import { loadMeetronDesktopLiveConfiguration } from "../scripts/run-meetron-windows-live.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test("macOS live environment selects one exact Core Audio virtual device", () => {
  const environment = loadMeetronMacosLiveEnvironment({ CODEX_BRIDGE_VIRTUAL_AUDIO_DEVICE_NAME: "BlackHole 2ch" });
  assert.equal(environment.CODEX_BRIDGE_VIRTUAL_AUDIO_DEVICE_NAME, "BlackHole 2ch");
  assert.equal(environment.CODEX_BRIDGE_VIRTUAL_AUDIO_INPUT_LABEL, "BlackHole 2ch");
  assert.equal(environment.CODEX_BRIDGE_VB_CABLE_RENDER_ENDPOINT_ID, undefined);
  assert.match(environment.CODEX_BRIDGE_MEETRON_RUNTIME_CONFIG, /runtime[\\/]meetron-macos-live\.json$/);
});

test("macOS desktop configuration requires Core Audio by name and no Windows endpoint", () => {
  const environment = loadMeetronMacosLiveEnvironment({
    CODEX_THREAD_ID: "a".repeat(24),
    CODEX_DESKTOP_DEBUGGER_ENDPOINT: "http://127.0.0.1:9224",
    CODEX_BRIDGE_CODEX_DESKTOP_PID: "42",
    CODEX_BRIDGE_DISCORD_GUILD_ID: "100000000000000001",
    CODEX_BRIDGE_DISCORD_VOICE_CHANNEL_ID: "100000000000000002",
  });
  const config = loadMeetronDesktopLiveConfiguration(environment, "darwin");
  assert.equal(config.virtualAudioDeviceName, "BlackHole 2ch");
  assert.equal(config.virtualCableRenderEndpointId, undefined);
});

test("macOS Core Audio endpoint verifies identity and writes bounded PCM to the selected host", async () => {
  const child = fakeChild();
  const written = [];
  child.stdin.on("data", (chunk) => written.push(Buffer.from(chunk)));
  let spawned;
  const identity = "a".repeat(64);
  const endpoint = new MacosExistingGptLiveAudio({
    platform: "darwin",
    hostExecutable: "/synthetic/discodex-coreaudio-host",
    existingGptLiveProcessId: 42,
    virtualAudioDeviceName: "BlackHole 2ch",
    expectedSessionIdentity: identity,
    executableExists: () => true,
    processExists: () => true,
    verifyExistingSession: async () => ({ matches: true, voiceActive: true, processId: 42, sessionIdentity: identity }),
    spawnHost: (executable, args) => { spawned = { executable, args }; queueMicrotask(() => child.stdout.write("READY\n")); return child; },
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 0,
  });
  await endpoint.start();
  await endpoint.writeInput({ sampleRate: 48_000, channels: 2, samples: Int16Array.from([1, -1, 2, -2]) });
  assert.deepEqual(spawned, { executable: "/synthetic/discodex-coreaudio-host", args: ["--device-name", "BlackHole 2ch"] });
  assert.equal(Buffer.concat(written).length, 8);
  await endpoint.close();
  assert.equal(endpoint.state, "closed");
});

test("macOS Core Audio endpoint rejects non-darwin use before spawning", async () => {
  const endpoint = new MacosExistingGptLiveAudio({
    platform: "win32",
    existingGptLiveProcessId: 42,
    virtualAudioDeviceName: "BlackHole 2ch",
    expectedSessionIdentity: "b".repeat(64),
    verifyExistingSession: async () => { throw new Error("must not run"); },
  });
  await assert.rejects(endpoint.start(), /requires darwin/);
});
