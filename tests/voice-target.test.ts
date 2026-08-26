import assert from "node:assert/strict";
import test from "node:test";
import { loadDiscordVoiceTarget } from "../src/adapters/discord/voice-target.ts";

test("voice target accepts only explicit non-secret Discord snowflakes", () => {
  assert.deepEqual(loadDiscordVoiceTarget({
    CODEX_BRIDGE_DISCORD_GUILD_ID: "REDACTED_DISCORD_ID_7",
    CODEX_BRIDGE_DISCORD_VOICE_CHANNEL_ID: "REDACTED_DISCORD_ID_8",
  }), { guildId: "REDACTED_DISCORD_ID_7", channelId: "REDACTED_DISCORD_ID_8" });
  assert.throws(() => loadDiscordVoiceTarget({}), /GUILD_ID/);
  assert.throws(() => loadDiscordVoiceTarget({ CODEX_BRIDGE_DISCORD_GUILD_ID: "bad", CODEX_BRIDGE_DISCORD_VOICE_CHANNEL_ID: "REDACTED_DISCORD_ID_8" }), /snowflake/);
});
