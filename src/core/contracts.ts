export type TransportKind = "discord" | "meet";
export type RunMode = "dry-run";

export type SessionState =
  | "idle"
  | "planning"
  | "ready"
  | "blocked"
  | "starting"
  | "active"
  | "stopping"
  | "stopped";

export type RiskLevel = "info" | "warning" | "blocked";

export interface PlanStep {
  id: string;
  description: string;
  risk: RiskLevel;
  network: "none" | "would-connect";
  mutation: "none" | "would-change-local" | "would-change-external";
}

export interface Capability {
  id: string;
  status: "ready" | "planned" | "blocked" | "not-configured";
  detail: string;
}

export interface TransportPlan {
  transport: TransportKind;
  dryRun: true;
  capabilities: Capability[];
  requiredPermissions: string[];
  steps: PlanStep[];
  blockers: string[];
}

export interface TransportAdapter {
  readonly kind: TransportKind;
  plan(config: BridgeConfig): Promise<TransportPlan>;
  connect(): Promise<never>;
}

export interface SessionConfig {
  maxDurationMinutes: number;
  wakePhrase: string;
  requireExplicitStart: boolean;
}

export interface CodexConfig {
  target: "current-task";
  cdpHost: "127.0.0.1";
}

export interface DiscordConfig {
  guildId: string;
  voiceChannelId: string;
  textChannelId: string;
  allowedUserIds: string[];
  gatewayVersion: number;
  dave: {
    required: boolean;
    provider: string;
  };
  textCommands: {
    mode: "application-commands";
    commandName: string;
    persistUserPromptContent: boolean;
  };
}

export interface MeetConfig {
  enabled: false;
  meetingUrl: string;
  dedicatedProfile: boolean;
}

export interface BridgeConfig {
  mode: RunMode;
  transport: TransportKind;
  session: SessionConfig;
  codex: CodexConfig;
  discord: DiscordConfig;
  meet: MeetConfig;
}

export interface DryRunReport {
  project: "codex-discord-voice-bridge";
  mode: "dry-run";
  state: SessionState;
  generatedAt: string;
  guarantees: string[];
  plan: TransportPlan;
}

export type PmCommand = "ask" | "status" | "stop";

export interface CommandContext {
  guildId: string;
  channelId: string;
  userId: string;
  command: PmCommand;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason:
    | "allowlisted"
    | "guild-not-allowed"
    | "channel-not-allowed"
    | "user-not-allowed";
}

export type AuditEventType =
  | "plan-requested"
  | "plan-completed"
  | "start-requested"
  | "start-rejected"
  | "session-started"
  | "stop-requested"
  | "session-stopped"
  | "command-authorized"
  | "command-rejected";

export interface AuditEvent {
  sequence: number;
  timestamp: string;
  type: AuditEventType;
  state: SessionState;
  outcome: "accepted" | "rejected" | "completed";
  actorClass?: "allowlisted-user" | "untrusted-user" | "local-user";
  reasonCode?: string;
}

export interface AuditSink {
  record(event: Omit<AuditEvent, "sequence" | "timestamp">): AuditEvent;
}
