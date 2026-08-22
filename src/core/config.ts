import { readFile } from "node:fs/promises";
import type { BridgeConfig, TransportKind } from "./contracts.ts";

const SECRET_KEY_PATTERN = /(token|secret|password|private.?key|cookie|authorization)/i;
const PLACEHOLDER_PATTERN = /^(DISCORD_[A-Z_]+|https:\/\/meet\.google\.com\/xxx-yyyy-zzz)$/;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${label} must be an object.`);
  }
}

function assertNoEmbeddedSecrets(value: unknown, path = "config"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new ConfigError(`Secret-like field is forbidden in JSON config: ${childPath}`);
    }
    assertNoEmbeddedSecrets(child, childPath);
  }
}

function stringValue(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${path}.${key} must be a non-empty string.`);
  }
  return value;
}

export function validateConfig(raw: unknown, transportOverride?: TransportKind): BridgeConfig {
  assertObject(raw, "config");
  assertNoEmbeddedSecrets(raw);

  if (raw.mode !== "dry-run") {
    throw new ConfigError("Only mode=dry-run is implemented. Live connections are intentionally blocked.");
  }

  const transport = transportOverride ?? raw.transport;
  if (transport !== "discord" && transport !== "meet") {
    throw new ConfigError("transport must be discord or meet.");
  }

  assertObject(raw.session, "config.session");
  assertObject(raw.codex, "config.codex");
  assertObject(raw.discord, "config.discord");
  assertObject(raw.meet, "config.meet");
  assertObject(raw.discord.dave, "config.discord.dave");
  assertObject(raw.discord.textCommands, "config.discord.textCommands");

  const maxDurationMinutes = raw.session.maxDurationMinutes;
  if (!Number.isInteger(maxDurationMinutes) || Number(maxDurationMinutes) < 1 || Number(maxDurationMinutes) > 120) {
    throw new ConfigError("config.session.maxDurationMinutes must be an integer from 1 to 120.");
  }
  if (raw.session.requireExplicitStart !== true) {
    throw new ConfigError("config.session.requireExplicitStart must be true.");
  }
  if (raw.codex.target !== "current-task" || raw.codex.cdpHost !== "127.0.0.1") {
    throw new ConfigError("Codex must target current-task over 127.0.0.1 in this phase.");
  }
  if (raw.discord.gatewayVersion !== 8) {
    throw new ConfigError("Discord Voice Gateway version 8 is required.");
  }
  if (raw.discord.dave.required !== true || raw.discord.dave.provider !== "discord/libdave") {
    throw new ConfigError("Discord DAVE must be required and provided by discord/libdave.");
  }
  if (raw.discord.textCommands.mode !== "application-commands") {
    throw new ConfigError("Discord text input must use application commands in the minimal PoC.");
  }
  if (raw.discord.textCommands.persistUserPromptContent !== false) {
    throw new ConfigError("User prompt content persistence must be disabled in the minimal PoC.");
  }
  if (raw.meet.enabled !== false) {
    throw new ConfigError("The future Meet adapter must remain disabled in the Discord MVP.");
  }

  const allowedUserIds = raw.discord.allowedUserIds;
  if (!Array.isArray(allowedUserIds) || allowedUserIds.some((item) => typeof item !== "string")) {
    throw new ConfigError("config.discord.allowedUserIds must be an array of strings.");
  }

  const config: BridgeConfig = {
    mode: "dry-run",
    transport,
    session: {
      maxDurationMinutes: Number(maxDurationMinutes),
      wakePhrase: stringValue(raw.session, "wakePhrase", "config.session"),
      requireExplicitStart: true,
    },
    codex: {
      target: "current-task",
      cdpHost: "127.0.0.1",
    },
    discord: {
      guildId: stringValue(raw.discord, "guildId", "config.discord"),
      voiceChannelId: stringValue(raw.discord, "voiceChannelId", "config.discord"),
      textChannelId: stringValue(raw.discord, "textChannelId", "config.discord"),
      allowedUserIds: [...allowedUserIds],
      gatewayVersion: 8,
      dave: { required: true, provider: "discord/libdave" },
      textCommands: {
        mode: "application-commands",
        commandName: stringValue(raw.discord.textCommands, "commandName", "config.discord.textCommands"),
        persistUserPromptContent: false,
      },
    },
    meet: {
      enabled: false,
      meetingUrl: stringValue(raw.meet, "meetingUrl", "config.meet"),
      dedicatedProfile: raw.meet.dedicatedProfile === true,
    },
  };

  return config;
}

export async function loadConfig(path: string, transportOverride?: TransportKind): Promise<BridgeConfig> {
  const text = await readFile(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
  return validateConfig(raw, transportOverride);
}

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value);
}
