import { existsSync, readFileSync } from "node:fs";

export function isDiscordIdentifier(value) {
  return typeof value === "string" && /^\d{16,22}$/.test(value);
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
    return /^[0-9a-f-]{20,}$/i.test(readFile(taskFile, "utf8").trim());
  } catch {
    return false;
  }
}

export function inspectMacosRelaySetup({
  runtimeConfigFile,
  taskFile,
  exists = existsSync,
  readFile = readFileSync,
  keychainTokenConfigured,
  blackHoleDetected,
}) {
  const missing = [];
  if (!runtimeTargetConfigured({ runtimeConfigFile, exists, readFile })) missing.push("runtime-config");
  try {
    if (!keychainTokenConfigured()) missing.push("discord-token");
  } catch {
    missing.push("discord-token");
  }
  if (!exactTaskConfigured({ taskFile, exists, readFile })) missing.push("codex-task");
  try {
    if (!blackHoleDetected()) missing.push("blackhole-device");
  } catch {
    missing.push("blackhole-device");
  }
  return {
    ready: missing.length === 0,
    missing,
    audioFormatVerificationRequired: true,
  };
}

export function requireMacosRelaySetup(options) {
  const setup = inspectMacosRelaySetup(options);
  if (!setup.ready) throw new Error("Relay setup is incomplete. Review the setup checklist in Discodex Relay.");
  return setup;
}
