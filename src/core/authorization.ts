import type {
  AuthorizationDecision,
  CommandContext,
  DiscordConfig,
  AuditSink,
  SessionState,
} from "./contracts.ts";

export const REQUIRED_DISCORD_PERMISSIONS = [
  "VIEW_CHANNEL",
  "SEND_MESSAGES",
  "READ_MESSAGE_HISTORY",
  "USE_APPLICATION_COMMANDS",
  "CONNECT",
  "SPEAK",
] as const;

const FORBIDDEN_ELEVATED_PERMISSIONS = new Set([
  "ADMINISTRATOR",
  "MANAGE_GUILD",
  "MANAGE_CHANNELS",
  "MANAGE_ROLES",
  "MANAGE_WEBHOOKS",
  "MOVE_MEMBERS",
  "MUTE_MEMBERS",
  "DEAFEN_MEMBERS",
]);

export interface PermissionDecision {
  allowed: boolean;
  missing: string[];
  forbidden: string[];
}

export function evaluateDiscordPermissions(granted: readonly string[]): PermissionDecision {
  const grantedSet = new Set(granted);
  const missing = REQUIRED_DISCORD_PERMISSIONS.filter((permission) => !grantedSet.has(permission));
  const forbidden = granted.filter((permission) => FORBIDDEN_ELEVATED_PERMISSIONS.has(permission));
  return { allowed: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

export function authorizeDiscordCommand(
  config: DiscordConfig,
  context: CommandContext,
): AuthorizationDecision {
  if (context.guildId !== config.guildId) {
    return { allowed: false, reason: "guild-not-allowed" };
  }
  if (context.channelId !== config.textChannelId) {
    return { allowed: false, reason: "channel-not-allowed" };
  }
  if (!config.allowedUserIds.includes(context.userId)) {
    return { allowed: false, reason: "user-not-allowed" };
  }
  return { allowed: true, reason: "allowlisted" };
}

export function authorizeAndAuditDiscordCommand(
  config: DiscordConfig,
  context: CommandContext,
  audit: AuditSink,
  state: SessionState,
): AuthorizationDecision {
  const decision = authorizeDiscordCommand(config, context);
  audit.record({
    type: decision.allowed ? "command-authorized" : "command-rejected",
    state,
    outcome: decision.allowed ? "accepted" : "rejected",
    actorClass: decision.allowed ? "allowlisted-user" : "untrusted-user",
    reasonCode: decision.reason,
  });
  return decision;
}
