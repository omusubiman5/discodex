import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateConfig } from "../src/core/config.ts";
import {
  authorizeAndAuditDiscordCommand,
  authorizeDiscordCommand,
  evaluateDiscordPermissions,
  REQUIRED_DISCORD_PERMISSIONS,
} from "../src/core/authorization.ts";
import { MemoryAuditLog } from "../src/core/audit.ts";

async function discordConfig() {
  const raw = JSON.parse(await readFile(new URL("../config/bridge.example.json", import.meta.url), "utf8"));
  return validateConfig(raw).discord;
}

test("Discord command requires exact guild, channel, and user allowlist matches", async () => {
  const config = await discordConfig();
  const allowed = authorizeDiscordCommand(config, {
    guildId: config.guildId,
    channelId: config.textChannelId,
    userId: config.allowedUserIds[0],
    command: "status",
  });
  assert.deepEqual(allowed, { allowed: true, reason: "allowlisted" });

  const rejected = authorizeDiscordCommand(config, {
    guildId: config.guildId,
    channelId: config.textChannelId,
    userId: "UNLISTED_USER",
    command: "ask",
  });
  assert.deepEqual(rejected, { allowed: false, reason: "user-not-allowed" });
});

test("permission boundary rejects missing and elevated Discord permissions", () => {
  assert.equal(evaluateDiscordPermissions(REQUIRED_DISCORD_PERMISSIONS).allowed, true);
  const decision = evaluateDiscordPermissions(["VIEW_CHANNEL", "ADMINISTRATOR"]);
  assert.equal(decision.allowed, false);
  assert.ok(decision.missing.includes("CONNECT"));
  assert.deepEqual(decision.forbidden, ["ADMINISTRATOR"]);
});

test("authorization audit contains a class and reason but no Discord IDs", async () => {
  const config = await discordConfig();
  const audit = new MemoryAuditLog(() => new Date("2026-08-22T00:00:00.000Z"));
  authorizeAndAuditDiscordCommand(config, {
    guildId: config.guildId,
    channelId: config.textChannelId,
    userId: "UNLISTED_USER",
    command: "stop",
  }, audit, "active");
  const serialized = JSON.stringify(audit.snapshot());
  assert.match(serialized, /user-not-allowed/);
  assert.doesNotMatch(serialized, /UNLISTED_USER|DISCORD_GUILD_ID|DISCORD_TEXT_CHANNEL_ID/);
});
