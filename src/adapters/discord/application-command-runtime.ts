import type { DiscordConfig } from "../../core/contracts.ts";
import type { DiscordInteraction, DiscordUiCommand, DiscordUiControlSurface } from "./ui-controls.ts";

const API_BASE = "https://discord.com/api/v10";
const EPHEMERAL = 1 << 6;

type FetchLike = typeof fetch;

interface GatewaySocket {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export const GUILD_COMMANDS = [
  { name: "connect", description: "Connect the current Codex task to Discord voice.", type: 1, default_member_permissions: "0", dm_permission: false },
  { name: "disconnect", description: "Disconnect the current Codex task from Discord voice.", type: 1, default_member_permissions: "0", dm_permission: false },
  { name: "status", description: "Show redacted bridge status and output gain.", type: 1, default_member_permissions: "0", dm_permission: false },
  {
    name: "gain",
    description: "Set Codex-to-Discord output gain.",
    type: 1,
    default_member_permissions: "0",
    dm_permission: false,
    options: [{ name: "linear", description: "Linear gain from 0.25 to 1.0.", type: 10, required: true, min_value: 0.25, max_value: 1 }],
  },
] as const;

function commandSchema(command: any): unknown {
  return {
    name: command?.name,
    description: command?.description,
    type: command?.type,
    default_member_permissions: command?.default_member_permissions ?? null,
    // Discord omits deprecated dm_permission from guild-command readback.
    // Guild commands cannot be used in DMs, so it is not part of the stable
    // guild schema comparison.
    options: Array.isArray(command?.options) ? command.options.map((option: any) => ({
      name: option?.name,
      description: option?.description,
      type: option?.type,
      required: option?.required ?? false,
      min_value: option?.min_value,
      max_value: option?.max_value,
    })) : [],
  };
}

function commandSurfaceMatches(commands: any[]): boolean {
  const actual = commands.map(commandSchema).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  const expected = GUILD_COMMANDS.map(commandSchema).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function discordJson(fetchImpl: FetchLike, url: string, init: RequestInit, label: string): Promise<any> {
  // Discord requires an initial interaction response within three seconds.
  // Bound every REST hop so a stalled socket cannot leave the mobile client
  // showing an indefinite "application did not respond" state.
  const response = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(2_500) });
  if (!response.ok) throw new Error(`${label} failed (${response.status}).`);
  if (response.status === 204) return undefined;
  return response.json();
}

export async function registerAndReadbackGuildCommands(
  credential: string,
  guildId: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ applicationId: string; commands: readonly string[] }> {
  const headers = { authorization: `Bot ${credential}`, "content-type": "application/json" };
  const application = await discordJson(fetchImpl, `${API_BASE}/oauth2/applications/@me`, { headers }, "Discord application lookup");
  if (typeof application?.id !== "string" || !/^\d+$/.test(application.id)) throw new Error("Discord application lookup returned an invalid identity.");
  const endpoint = `${API_BASE}/applications/${application.id}/guilds/${guildId}/commands`;
  const existing = await discordJson(fetchImpl, endpoint, { headers }, "Discord guild command readback");
  let readback = existing;
  if (!Array.isArray(existing) || !commandSurfaceMatches(existing)) {
    const ids = new Map<string, string>();
    if (Array.isArray(existing)) for (const command of existing) {
      if (typeof command?.id === "string" && /^\d+$/.test(command.id) && typeof command?.name === "string" && Number.isSafeInteger(command?.type)) {
        ids.set(`${command.name}:${command.type}`, command.id);
      }
    }
    const stableCommands = GUILD_COMMANDS.map((command) => {
      const id = ids.get(`${command.name}:${command.type}`);
      return id ? { id, ...command } : command;
    });
    await discordJson(fetchImpl, endpoint, { method: "PUT", headers, body: JSON.stringify(stableCommands) }, "Discord guild command registration");
    readback = await discordJson(fetchImpl, endpoint, { headers }, "Discord guild command readback");
  }
  const names = Array.isArray(readback) ? readback.map((item) => item?.name).filter((name): name is string => typeof name === "string").sort() : [];
  const expected = GUILD_COMMANDS.map((command) => command.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("Discord guild command readback did not match the approved control surface.");
  return { applicationId: application.id, commands: names };
}

export async function resolveApprovedGuildOwnerIdentity(
  credential: string,
  guildId: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const headers = { authorization: `Bot ${credential}` };
  const [application, guild] = await Promise.all([
    discordJson(fetchImpl, `${API_BASE}/oauth2/applications/@me`, { headers }, "Discord application lookup"),
    discordJson(fetchImpl, `${API_BASE}/guilds/${guildId}`, { headers }, "Discord guild lookup"),
  ]);
  const ownerId = String(guild?.owner_id ?? "");
  const applicationOwners = new Set<string>();
  if (typeof application?.owner?.id === "string") applicationOwners.add(application.owner.id);
  if (typeof application?.team?.owner_user_id === "string") applicationOwners.add(application.team.owner_user_id);
  for (const member of application?.team?.members ?? []) if (typeof member?.user?.id === "string") applicationOwners.add(member.user.id);
  if (!/^\d+$/.test(ownerId) || !applicationOwners.has(ownerId)) {
    throw new Error("The approved guild owner is not an owner of the existing Discord application.");
  }
  return ownerId;
}

export async function resolveApprovedGuildControlScope(
  credential: string,
  guildId: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ownerId: string; textChannelId: string }> {
  const headers = { authorization: `Bot ${credential}` };
  const ownerId = await resolveApprovedGuildOwnerIdentity(credential, guildId, fetchImpl);
  const guild = await discordJson(fetchImpl, `${API_BASE}/guilds/${guildId}`, { headers }, "Discord guild lookup");
  const textChannelId = String(guild?.system_channel_id ?? "");
  if (!/^\d+$/.test(textChannelId)) throw new Error("The approved guild has no system text channel.");
  const channel = await discordJson(fetchImpl, `${API_BASE}/channels/${textChannelId}`, { headers }, "Discord control channel lookup");
  if (String(channel?.guild_id ?? "") !== guildId || ![0, 5].includes(channel?.type)) {
    throw new Error("The approved guild system channel is not a guild text channel.");
  }
  return { ownerId, textChannelId };
}

function parseInteraction(data: any): DiscordInteraction | undefined {
  const command = data?.data?.name as DiscordUiCommand;
  if (!(["connect", "disconnect", "status", "gain"] as const).includes(command)) return undefined;
  const linear = data?.data?.options?.find((option: any) => option?.name === "linear")?.value;
  return {
    id: String(data.id ?? ""),
    createdAt: Number((BigInt(String(data.id)) >> 22n) + 1420070400000n),
    command,
    context: {
      guildId: String(data.guild_id ?? ""),
      channelId: String(data.channel_id ?? ""),
      userId: String(data.member?.user?.id ?? data.user?.id ?? ""),
      command,
    },
    options: typeof linear === "number" ? { linear } : undefined,
  };
}

export async function respondToDiscordInteraction(
  interactionId: string,
  interactionToken: string,
  message: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await discordJson(fetchImpl, `${API_BASE}/interactions/${interactionId}/${interactionToken}/callback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: 4, data: { content: message, flags: EPHEMERAL } }),
  }, "Discord interaction response");
}

async function deferDiscordInteraction(interactionId: string, interactionToken: string, fetchImpl: FetchLike): Promise<void> {
  await discordJson(fetchImpl, `${API_BASE}/interactions/${interactionId}/${interactionToken}/callback`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: 5, data: { flags: EPHEMERAL } }),
  }, "Discord interaction defer");
}

export async function editDiscordInteractionResponse(applicationId: string, interactionToken: string, message: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await discordJson(fetchImpl, `${API_BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: message, flags: EPHEMERAL }),
  }, "Discord interaction response edit");
}

export async function runDiscordApplicationCommandGateway(options: {
  credential: string;
  config: DiscordConfig;
  controls: DiscordUiControlSurface;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  socketFactory?: (url: string) => GatewaySocket;
  observer?: (event: { state: string }) => void;
}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const registration = await registerAndReadbackGuildCommands(options.credential, options.config.guildId, fetchImpl);
  const applicationId = registration.applicationId;
  const gateway = await discordJson(fetchImpl, `${API_BASE}/gateway/bot`, { headers: { authorization: `Bot ${options.credential}` } }, "Discord Gateway lookup");
  if (typeof gateway?.url !== "string" || !gateway.url.startsWith("wss://")) throw new Error("Discord Gateway lookup returned an invalid endpoint.");
  const makeSocket = (url: string) => options.socketFactory?.(url) ?? new WebSocket(url) as unknown as GatewaySocket;
  const withQuery = (url: string) => `${url.replace(/\/$/, "")}/?v=10&encoding=json`;
  const fatalCloseCodes = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
  let sequence: number | null = null;
  let sessionId: string | undefined;
  let resumeGatewayUrl: string | undefined;
  let mode: "identify" | "resume" = "identify";
  let readyOnce = false;
  let recoveryTransitions = 0;

  while (!options.signal?.aborted) {
    const socket = makeSocket(withQuery(mode === "resume" && resumeGatewayUrl ? resumeGatewayUrl : gateway.url));
    const outcome = await new Promise<"stopped" | "resume" | "identify">((resolve, reject) => {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let firstHeartbeat: ReturnType<typeof setTimeout> | undefined;
      let heartbeatAcked = true;
      let settled = false;
      let sessionReady = false;
      const cleanup = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (firstHeartbeat) clearTimeout(firstHeartbeat);
        options.signal?.removeEventListener("abort", stop);
      };
      const settle = (result: "stopped" | "resume" | "identify", closeCode?: number, reason?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (closeCode !== undefined) try { socket.close(closeCode, reason); } catch { /* socket already closed */ }
        resolve(result);
      };
      const stop = () => settle("stopped", 1000, "bridge-control-stop");
      const recover = () => settle(sessionId && resumeGatewayUrl && sequence !== null ? "resume" : "identify", 4000, "bridge-control-recover");
      const sendHeartbeat = () => {
        if (!heartbeatAcked) { recover(); return; }
        heartbeatAcked = false;
        socket.send(JSON.stringify({ op: 1, d: sequence }));
      };
      options.signal?.addEventListener("abort", stop, { once: true });
      socket.addEventListener("error", recover);
      socket.addEventListener("close", (event) => {
        if (settled) return;
        cleanup();
        const code = Number(event?.code ?? 0);
        if (options.signal?.aborted) { settled = true; resolve("stopped"); return; }
        if (fatalCloseCodes.has(code)) { settled = true; reject(new Error(`Discord control Gateway closed with non-recoverable code ${code}.`)); return; }
        settled = true;
        resolve(code === 4007 || code === 4009 || !sessionId || !resumeGatewayUrl || sequence === null ? "identify" : "resume");
      });
      socket.addEventListener("message", async (event) => {
        let payload: any;
        try { payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data)); }
        catch { recover(); return; }
        if (Number.isInteger(payload.s)) sequence = payload.s;
        if (payload.op === 11) { heartbeatAcked = true; return; }
        if (payload.op === 1) { sendHeartbeat(); return; }
        if (payload.op === 7) { settle("resume", 4000, "discord-requested-resume"); return; }
        if (payload.op === 9) { settle(payload.d === true && sessionId && resumeGatewayUrl && sequence !== null ? "resume" : "identify", 4000, "discord-invalid-session"); return; }
        if (payload.op === 10) {
          const interval = Number(payload.d?.heartbeat_interval);
          if (!Number.isSafeInteger(interval) || interval <= 0) { recover(); return; }
          const handshake = mode === "resume" && sessionId && sequence !== null
            ? { op: 6, d: { token: options.credential, session_id: sessionId, seq: sequence } }
            : { op: 2, d: { token: options.credential, intents: 0, properties: { os: process.platform, browser: "codex-voice-bridge", device: "codex-voice-bridge" } } };
          socket.send(JSON.stringify(handshake));
          firstHeartbeat = setTimeout(() => {
            sendHeartbeat();
            heartbeat = setInterval(sendHeartbeat, interval);
          }, Math.floor(Math.random() * interval));
          return;
        }
        if (payload.t === "READY") {
          if (typeof payload.d?.session_id !== "string" || typeof payload.d?.resume_gateway_url !== "string" || !payload.d.resume_gateway_url.startsWith("wss://")) {
            recover(); return;
          }
          sessionId = payload.d.session_id;
          resumeGatewayUrl = payload.d.resume_gateway_url;
          sessionReady = true;
          readyOnce = true;
          recoveryTransitions = 0;
          options.observer?.({ state: "discord-ui-ready" });
          return;
        }
        if (payload.t === "RESUMED") {
          sessionReady = true;
          recoveryTransitions = 0;
          options.observer?.({ state: "discord-ui-resumed" });
          return;
        }
        if (payload.t !== "INTERACTION_CREATE" || !sessionReady) return;
        // One failed interaction must not kill the persistent control Gateway.
        try {
          options.observer?.({ state: "discord-ui-interaction-received" });
          const interaction = parseInteraction(payload.d);
          await deferDiscordInteraction(payload.d.id, payload.d.token, fetchImpl);
          options.observer?.({ state: "discord-ui-interaction-deferred" });
          const result = interaction ? await (options.controls.handleAsync?.(interaction) ?? options.controls.handle(interaction)) : { ok: false, message: "Interaction rejected." };
          options.observer?.({ state: result.ok ? "discord-ui-interaction-accepted" : "discord-ui-interaction-rejected" });
          await editDiscordInteractionResponse(applicationId, payload.d.token, result.message, fetchImpl);
          options.observer?.({ state: "discord-ui-interaction-responded" });
        } catch {
          options.observer?.({ state: "discord-ui-interaction-failed" });
          const token = typeof payload.d?.token === "string" ? payload.d.token : undefined;
          if (token) await editDiscordInteractionResponse(applicationId, token, "Interaction failed; control remains online.", fetchImpl).catch(() => undefined);
        }
      });
    });
    if (outcome === "stopped") return;
    recoveryTransitions += 1;
    // One Resume and, only when Discord invalidates it, one fresh Identify.
    // Do not compound this with unbounded process/voice retries.
    if ((!readyOnce && recoveryTransitions > 1) || (outcome === "resume" && recoveryTransitions > 1) || (outcome === "identify" && readyOnce && recoveryTransitions > 2)) {
      throw new Error("Discord control Gateway recovery budget was exhausted.");
    }
    if (outcome === "identify") {
      sessionId = undefined;
      resumeGatewayUrl = undefined;
      sequence = null;
      options.observer?.({ state: "discord-ui-reidentifying" });
    } else {
      options.observer?.({ state: "discord-ui-resuming" });
    }
    mode = outcome;
  }
}
