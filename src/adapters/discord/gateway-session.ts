export type GatewaySessionState =
  | "idle"
  | "hello-received"
  | "identified"
  | "gateway-ready"
  | "voice-state-requested"
  | "voice-handoff-ready"
  | "closed";

export interface GatewayPayload {
  op: number;
  d: unknown;
}

export interface VoiceGatewayHandoff {
  guildId: string;
  channelId: string;
  userId: string;
  sessionId: string;
  endpoint: string;
  token: string;
}

interface PendingVoiceState {
  guildId: string;
  channelId: string;
  userId: string;
  sessionId: string;
}

interface PendingVoiceServer {
  guildId: string;
  endpoint: string;
  token: string;
}

interface VoiceServerUpdate extends Omit<PendingVoiceServer, "endpoint"> {
  endpoint: string | null;
}

export class DiscordGatewaySession {
  #state: GatewaySessionState = "idle";
  #selfUserId?: string;
  #requestedGuildId?: string;
  #requestedChannelId?: string;
  #voiceState?: PendingVoiceState;
  #voiceServer?: PendingVoiceServer;

  get state(): GatewaySessionState {
    return this.#state;
  }

  receiveHello(): void {
    if (this.#state !== "idle") throw new Error(`Gateway Hello is invalid in ${this.#state}.`);
    this.#state = "hello-received";
  }

  identify(botToken: string): GatewayPayload {
    if (this.#state !== "hello-received") throw new Error(`Gateway Identify is invalid in ${this.#state}.`);
    if (!botToken) throw new Error("A non-empty credential lease is required for Gateway Identify.");
    this.#state = "identified";
    return {
      op: 2,
      d: {
        token: botToken,
        intents: 1 << 7,
        properties: { os: process.platform, browser: "codex-discord-voice-bridge", device: "codex-discord-voice-bridge" },
      },
    };
  }

  receiveReady(selfUserId: string): void {
    if (this.#state !== "identified") throw new Error(`Gateway Ready is invalid in ${this.#state}.`);
    if (!selfUserId) throw new Error("Gateway Ready must identify the bot user.");
    this.#selfUserId = selfUserId;
    this.#state = "gateway-ready";
  }

  requestVoiceState(guildId: string, channelId: string): GatewayPayload {
    if (this.#state !== "gateway-ready") throw new Error(`Voice state request is invalid in ${this.#state}.`);
    if (!guildId || !channelId) throw new Error("Voice state request requires a guild and channel.");
    this.#requestedGuildId = guildId;
    this.#requestedChannelId = channelId;
    this.#state = "voice-state-requested";
    return { op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: false } };
  }

  receiveVoiceStateUpdate(update: PendingVoiceState): VoiceGatewayHandoff | null {
    if (this.#state !== "voice-state-requested") throw new Error(`Voice State Update is invalid in ${this.#state}.`);
    if (this.#voiceState) return this.#failCorrelation("Duplicate Voice State Update received.");
    if (
      update.guildId !== this.#requestedGuildId ||
      update.channelId !== this.#requestedChannelId ||
      update.userId !== this.#selfUserId
    ) {
      return this.#failCorrelation("Voice State Update does not match the requested guild, channel, and bot user.");
    }
    this.#voiceState = { ...update };
    return this.#completeHandoff();
  }

  receiveVoiceServerUpdate(update: VoiceServerUpdate): VoiceGatewayHandoff | null {
    if (this.#state !== "voice-state-requested") throw new Error(`Voice Server Update is invalid in ${this.#state}.`);
    if (this.#voiceServer) return this.#failCorrelation("Duplicate Voice Server Update received.");
    if (update.guildId !== this.#requestedGuildId) {
      return this.#failCorrelation("Voice Server Update does not match the requested guild.");
    }
    if (!update.endpoint) {
      this.close();
      throw new Error("Voice Server endpoint is unavailable; wait for a new allocation.");
    }
    this.#voiceServer = { ...update, endpoint: update.endpoint };
    return this.#completeHandoff();
  }

  close(): void {
    this.#selfUserId = undefined;
    this.#requestedGuildId = undefined;
    this.#requestedChannelId = undefined;
    this.#voiceState = undefined;
    this.#voiceServer = undefined;
    this.#state = "closed";
  }

  #completeHandoff(): VoiceGatewayHandoff | null {
    if (!this.#voiceState || !this.#voiceServer) return null;
    if (this.#voiceState.guildId !== this.#voiceServer.guildId) {
      this.close();
      throw new Error("Voice State and Voice Server guild IDs do not match.");
    }
    this.#state = "voice-handoff-ready";
    return {
      ...this.#voiceState,
      endpoint: this.#voiceServer.endpoint,
      token: this.#voiceServer.token,
    };
  }

  #failCorrelation(message: string): never {
    this.close();
    throw new Error(message);
  }
}
