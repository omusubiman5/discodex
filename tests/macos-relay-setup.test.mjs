import assert from "node:assert/strict";
import test from "node:test";
import { inspectMacosRelaySetup, isDiscordIdentifier, requireMacosRelaySetup } from "../src/adapters/macos/relay-setup.mjs";

const runtimeConfigFile = "/synthetic/runtime/meetron-macos-live.json";
const taskFile = "/synthetic/runtime/discodex-relay.thread-id";
const validTaskId = "a".repeat(20);

function inspect({ files = {}, keychain = true, blackHole = true, keychainError, blackHoleError } = {}) {
  const readFile = (path) => {
    const value = files[path];
    if (value instanceof Error) throw value;
    return value;
  };
  return inspectMacosRelaySetup({
    runtimeConfigFile,
    taskFile,
    exists: (path) => Object.hasOwn(files, path),
    readFile,
    keychainTokenConfigured: () => {
      if (keychainError) throw keychainError;
      return keychain;
    },
    blackHoleDetected: () => {
      if (blackHoleError) throw blackHoleError;
      return blackHole;
    },
  });
}

function validFiles({ guildId = "1".repeat(16), voiceChannelId = "9".repeat(22), taskId = validTaskId } = {}) {
  return {
    [runtimeConfigFile]: JSON.stringify({ discordGuildId: guildId, discordVoiceChannelId: voiceChannelId }),
    [taskFile]: `${taskId}\n`,
  };
}

test("Discord IDs accept the inclusive 16 and 22 digit boundaries only", () => {
  assert.equal(isDiscordIdentifier("1".repeat(16)), true);
  assert.equal(isDiscordIdentifier("9".repeat(22)), true);
  assert.equal(isDiscordIdentifier("1".repeat(15)), false);
  assert.equal(isDiscordIdentifier("1".repeat(23)), false);
  assert.equal(isDiscordIdentifier("1".repeat(15) + "x"), false);
  assert.equal(isDiscordIdentifier(undefined), false);
});

test("a fully configured Relay is ready without returning credentials or identifiers", () => {
  const setup = inspect({ files: validFiles() });
  assert.deepEqual(setup, { ready: true, missing: [], audioFormatVerificationRequired: true });
  assert.equal(JSON.stringify(setup).includes(validTaskId), false);
  assert.equal(JSON.stringify(setup).includes("1".repeat(16)), false);
});

test("missing initial setup requirements are individually reported with safe codes", () => {
  const setup = inspect({ files: {}, keychain: false, blackHole: false });
  assert.deepEqual(setup, {
    ready: false,
    missing: ["runtime-config", "discord-token", "codex-task", "blackhole-device"],
    audioFormatVerificationRequired: true,
  });
});

test("invalid runtime JSON or out-of-range Discord IDs blocks only the runtime target", () => {
  for (const files of [
    { ...validFiles(), [runtimeConfigFile]: "not-json" },
    validFiles({ guildId: "1".repeat(15) }),
    validFiles({ voiceChannelId: "9".repeat(23) }),
  ]) {
    const setup = inspect({ files });
    assert.equal(setup.ready, false);
    assert.deepEqual(setup.missing, ["runtime-config"]);
  }
});

test("missing, unreadable, and malformed task files fail closed", () => {
  for (const files of [
    { [runtimeConfigFile]: validFiles()[runtimeConfigFile] },
    { ...validFiles(), [taskFile]: new Error("read failed") },
    validFiles({ taskId: "not-a-task" }),
  ]) {
    const setup = inspect({ files });
    assert.equal(setup.ready, false);
    assert.deepEqual(setup.missing, ["codex-task"]);
  }
});

test("credential and audio probe failures fail closed without exposing probe errors", () => {
  const setup = inspect({
    files: validFiles(),
    keychainError: new Error("synthetic-token-must-not-appear"),
    blackHoleError: new Error("synthetic-audio-detail-must-not-appear"),
  });
  assert.deepEqual(setup.missing, ["discord-token", "blackhole-device"]);
  assert.equal(JSON.stringify(setup).includes("synthetic-"), false);
});

test("required setup returns a safe generic error until every prerequisite is configured", () => {
  const base = {
    runtimeConfigFile,
    taskFile,
    exists: () => false,
    readFile: () => { throw new Error("must not read"); },
    keychainTokenConfigured: () => false,
    blackHoleDetected: () => false,
  };
  assert.throws(() => requireMacosRelaySetup(base), {
    message: "Relay setup is incomplete. Review the setup checklist in Discodex Relay.",
  });
  assert.deepEqual(requireMacosRelaySetup({
    ...base,
    exists: (path) => path === runtimeConfigFile || path === taskFile,
    readFile: (path) => path === runtimeConfigFile ? validFiles()[runtimeConfigFile] : validFiles()[taskFile],
    keychainTokenConfigured: () => true,
    blackHoleDetected: () => true,
  }), { ready: true, missing: [], audioFormatVerificationRequired: true });
});
