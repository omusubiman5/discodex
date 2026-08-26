export interface DiscordVoiceTarget {
  guildId: string;
  channelId: string;
}

function snowflake(value: string | undefined, name: string): string {
  if (!value || !/^\d{17,20}$/.test(value)) throw new Error(`${name} must be configured as a Discord snowflake.`);
  return value;
}

/** Non-secret runtime configuration. Bot credentials remain in DPAPI. */
export function loadDiscordVoiceTarget(env = process.env): DiscordVoiceTarget {
  return {
    guildId: snowflake(env.CODEX_BRIDGE_DISCORD_GUILD_ID, "CODEX_BRIDGE_DISCORD_GUILD_ID"),
    channelId: snowflake(env.CODEX_BRIDGE_DISCORD_VOICE_CHANNEL_ID, "CODEX_BRIDGE_DISCORD_VOICE_CHANNEL_ID"),
  };
}
