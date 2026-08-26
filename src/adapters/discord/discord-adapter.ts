import type {
  BridgeConfig,
  TransportAdapter,
  TransportPlan,
} from "../../core/contracts.ts";
import { isPlaceholder } from "../../core/config.ts";
import { assertDaveConfig, DAVE_POLICY } from "./dave-policy.ts";
import { REQUIRED_DISCORD_PERMISSIONS } from "../../core/authorization.ts";

export class DiscordAdapter implements TransportAdapter {
  readonly kind = "discord" as const;

  async plan(config: BridgeConfig): Promise<TransportPlan> {
    assertDaveConfig(config.discord.dave.provider, config.discord.gatewayVersion);
    const placeholders = [
      config.discord.guildId,
      config.discord.voiceChannelId,
      config.discord.textChannelId,
      ...config.discord.allowedUserIds,
    ].filter(isPlaceholder);

    const blockers = [
      "Live Discord networking is not implemented in this phase.",
      "discord/libdave has not been built or linked into the Node adapter.",
      "Bot application, token, guild, and channels require explicit user setup.",
    ];
    if (placeholders.length > 0) {
      blockers.push("Discord IDs are placeholders in the example configuration.");
    }

    return {
      transport: "discord",
      dryRun: true,
      capabilities: [
        {
          id: "gateway-control",
          status: "planned",
          detail: "Gateway events and application commands will use a bot identity with an allowlist.",
        },
        {
          id: "voice-udp",
          status: "planned",
          detail: "Voice uses a separate Voice Gateway WebSocket plus bidirectional UDP with NAT discovery; no port forwarding is planned.",
        },
        {
          id: "dave-e2ee",
          status: "blocked",
          detail: `${DAVE_POLICY.preferredProvider} is mandatory; custom crypto and unencrypted fallback are forbidden.`,
        },
        {
          id: "text-history",
          status: "planned",
          detail: "Use only bounded transport controls without message-content collection or development-work routing.",
        },
        {
          id: "token-storage",
          status: "not-configured",
          detail: "Future live mode must use Windows Credential Manager/DPAPI or macOS Keychain; JSON and tracked .env files are forbidden.",
        },
      ],
      requiredPermissions: [...REQUIRED_DISCORD_PERMISSIONS],
      steps: [
        {
          id: "discord.validate-allowlist",
          description: "Validate guild, voice channel, text channel, and allowed user IDs.",
          risk: "warning",
          network: "none",
          mutation: "none",
        },
        {
          id: "discord.gateway-identify",
          description: "Would identify the bot on the main Gateway with only required intents.",
          risk: "blocked",
          network: "would-connect",
          mutation: "none",
        },
        {
          id: "discord.voice-negotiate",
          description: "Would negotiate Voice Gateway v8, UDP discovery, Opus RTP, and DAVE MLS epochs.",
          risk: "blocked",
          network: "would-connect",
          mutation: "none",
        },
        {
          id: "discord.bridge-audio",
          description: "Would bridge decoded participant PCM to Codex input and Codex PCM/Opus output to Discord.",
          risk: "blocked",
          network: "would-connect",
          mutation: "would-change-local",
        },
        {
          id: "discord.transport-controls",
          description: "Would accept only allowlisted connect, disconnect, status, and gain controls.",
          risk: "blocked",
          network: "would-connect",
          mutation: "would-change-external",
        },
      ],
      blockers,
    };
  }

  async connect(): Promise<never> {
    throw new Error("Discord live connections are intentionally disabled. Use dry-run only.");
  }
}
