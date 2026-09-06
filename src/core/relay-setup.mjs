import { existsSync, readFileSync } from "node:fs";

export function isDiscordIdentifier(value) {
  return typeof value === "string" && /^\d{16,22}$/.test(value);
}

export function isCodexTaskIdentifier(value) {
  return typeof value === "string" && /^[0-9a-f-]{20,}$/i.test(value);
}

function runtimeTargetConfigured({ runtimeConfigFile, exists, readFile }) {
  if (!exists(runtimeConfigFile)) return false;
  try {
    const stored = JSON.parse(readFile(runtimeConfigFile, "utf8"));
    return isDiscordIdentifier(stored?.discordGuildId) && isDiscordIdentifier(stored?.discordVoiceChannelId);
  } catch {
    return false;
  }
}

function exactTaskConfigured({ taskFile, exists, readFile }) {
  if (!exists(taskFile)) return false;
  try {
    return isCodexTaskIdentifier(readFile(taskFile, "utf8").trim());
  } catch {
    return false;
  }
}

function configured(check) {
  try {
    return (typeof check === "function" ? check() : check) === true;
  } catch {
    return false;
  }
}

export function inspectRelaySetup({
  runtimeConfigFile,
  taskFile,
  credentialConfigured,
  audioDeviceConfigured,
  audioDeviceMissingCode,
  audioFormatVerificationRequired = false,
  exists = existsSync,
  readFile = readFileSync,
}) {
  if (typeof audioDeviceMissingCode !== "string" || !/^[a-z-]+$/.test(audioDeviceMissingCode)) {
    throw new Error("Relay audio setup code is invalid.");
  }
  const missing = [];
  if (!runtimeTargetConfigured({ runtimeConfigFile, exists, readFile })) missing.push("runtime-config");
  if (!configured(credentialConfigured)) missing.push("discord-token");
  if (!exactTaskConfigured({ taskFile, exists, readFile })) missing.push("codex-task");
  if (!configured(audioDeviceConfigured)) missing.push(audioDeviceMissingCode);
  return {
    ready: missing.length === 0,
    missing,
    audioFormatVerificationRequired: audioFormatVerificationRequired === true,
  };
}

export function requireRelaySetup(options) {
  const setup = inspectRelaySetup(options);
  if (!setup.ready) throw new Error("Relay setup is incomplete. Review the setup checklist in Discodex Relay.");
  return setup;
}
