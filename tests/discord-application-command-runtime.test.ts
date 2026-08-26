import assert from "node:assert/strict";
import test from "node:test";
import { GUILD_COMMANDS, editDiscordInteractionResponse, registerAndReadbackGuildCommands, resolveApprovedGuildControlScope, resolveApprovedGuildOwnerIdentity, respondToDiscordInteraction, runDiscordApplicationCommandGateway } from "../src/adapters/discord/application-command-runtime.ts";

class FakeControlSocket {
  readonly sent: any[] = [];
  readonly listeners = new Map<string, Array<(event: any) => void>>();
  addEventListener(type: string, listener: (event: any) => void): void {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(code = 1000): void { queueMicrotask(() => this.emit("close", { code })); }
  emit(type: string, event: any): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  message(payload: any): void { this.emit("message", { data: JSON.stringify(payload) }); }
}

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("condition was not reached");
};

test("matching guild commands are read back without replacing stable command IDs", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/oauth2/applications/@me")) return new Response(JSON.stringify({ id: "123" }), { status: 200 });
    return new Response(JSON.stringify(GUILD_COMMANDS), { status: 200 });
  }) as typeof fetch;
  const result = await registerAndReadbackGuildCommands("secret-not-logged", "456", fakeFetch);
  assert.deepEqual(result.commands, ["connect", "disconnect", "gain", "status"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, undefined);
  assert.ok(calls.every((call) => !call.url.includes("secret-not-logged")));
});

test("changed guild commands preserve known IDs during atomic registration", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let request = 0;
  const fakeFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    request += 1;
    if (request === 1) return new Response(JSON.stringify({ id: "123" }), { status: 200 });
    if (request === 2) return new Response(JSON.stringify([{ id: "999", name: "gain", type: 1, description: "old" }]), { status: 200 });
    return new Response(JSON.stringify(GUILD_COMMANDS), { status: 200 });
  }) as typeof fetch;
  const result = await registerAndReadbackGuildCommands("secret-not-logged", "456", fakeFetch);
  assert.deepEqual(result.commands, ["connect", "disconnect", "gain", "status"]);
  assert.equal(calls[2].init.method, "PUT");
  const body = JSON.parse(String(calls[2].init.body));
  assert.equal(body.find((command: any) => command.name === "gain").id, "999");
  assert.equal(body.find((command: any) => command.name === "gain").options[0].min_value, 0.25);
  assert.equal(body.find((command: any) => command.name === "gain").options[0].max_value, 1);
  assert.ok(calls.every((call) => !call.url.includes("secret-not-logged")));
});

test("guild command readback mismatch fails closed", async () => {
  let request = 0;
  const fakeFetch = (async () => {
    request += 1;
    if (request === 1) return new Response(JSON.stringify({ id: "123" }), { status: 200 });
    if (request === 2) return new Response(JSON.stringify([{ id: "999", name: "status", type: 1, description: "old" }]), { status: 200 });
    if (request === 3) return new Response(JSON.stringify(GUILD_COMMANDS), { status: 200 });
    return new Response(JSON.stringify([{ name: "status" }]), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(registerAndReadbackGuildCommands("secret", "456", fakeFetch), /did not match/);
});

test("approved UI identity is the guild owner and existing application owner", async () => {
  const fakeFetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/oauth2/applications/@me")) return new Response(JSON.stringify({ owner: { id: "789" } }), { status: 200 });
    return new Response(JSON.stringify({ owner_id: "789" }), { status: 200 });
  }) as typeof fetch;
  assert.equal(await resolveApprovedGuildOwnerIdentity("secret", "456", fakeFetch), "789");
});

test("mismatched guild/application ownership fails closed", async () => {
  const fakeFetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/oauth2/applications/@me")) return new Response(JSON.stringify({ owner: { id: "111" } }), { status: 200 });
    return new Response(JSON.stringify({ owner_id: "222" }), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(resolveApprovedGuildOwnerIdentity("secret", "456", fakeFetch), /not an owner/);
});

test("approved control scope binds the existing owner to the guild system text channel", async () => {
  const fakeFetch = (async (url: string | URL | Request) => {
    const value = String(url);
    if (value.endsWith("/oauth2/applications/@me")) return new Response(JSON.stringify({ owner: { id: "789" } }), { status: 200 });
    if (value.endsWith("/channels/654")) return new Response(JSON.stringify({ id: "654", guild_id: "456", type: 0 }), { status: 200 });
    return new Response(JSON.stringify({ owner_id: "789", system_channel_id: "654" }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await resolveApprovedGuildControlScope("secret", "456", fakeFetch), { ownerId: "789", textChannelId: "654" });
});

test("approved control scope rejects a non-text system channel", async () => {
  const fakeFetch = (async (url: string | URL | Request) => {
    const value = String(url);
    if (value.endsWith("/oauth2/applications/@me")) return new Response(JSON.stringify({ owner: { id: "789" } }), { status: 200 });
    if (value.endsWith("/channels/654")) return new Response(JSON.stringify({ id: "654", guild_id: "456", type: 2 }), { status: 200 });
    return new Response(JSON.stringify({ owner_id: "789", system_channel_id: "654" }), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(resolveApprovedGuildControlScope("secret", "456", fakeFetch), /not a guild text channel/);
});

test("Discord interaction callback accepts the official 204 No Content success", async () => {
  let body: any;
  const fakeFetch = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    body = JSON.parse(String(init.body));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  await respondToDiscordInteraction("123", "opaque", "Connected.", fakeFetch);
  assert.equal(body.type, 4);
  assert.equal(body.data.content, "Connected.");
  assert.equal(body.data.flags, 64);
});

test("Discord deferred interaction edits the original response through the official webhook route", async () => {
  let requested = "";
  const fakeFetch = (async (url: string | URL | Request) => { requested = String(url); return new Response(JSON.stringify({}), { status: 200 }); }) as typeof fetch;
  await editDiscordInteractionResponse("123", "opaque", "Connection failed before Discord voice Ready.", fakeFetch);
  assert.match(requested, /\/webhooks\/123\/opaque\/messages\/@original$/);
});

test("Discord control Gateway resumes the official session once instead of exiting or rerunning the process", async () => {
  const sockets: FakeControlSocket[] = [];
  const states: string[] = [];
  const controller = new AbortController();
  const fakeFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const value = String(url);
    if (value.endsWith("/oauth2/applications/@me")) return new Response(JSON.stringify({ id: "123" }), { status: 200 });
    if (value.endsWith("/gateway/bot")) return new Response(JSON.stringify({ url: "wss://gateway.discord.test" }), { status: 200 });
    if (value.includes("/commands")) return new Response(JSON.stringify(GUILD_COMMANDS), { status: 200 });
    throw new Error(`unexpected request ${value} ${init.method ?? "GET"}`);
  }) as typeof fetch;
  const running = runDiscordApplicationCommandGateway({
    credential: "secret-not-logged",
    config: { guildId: "456" } as any,
    controls: {} as any,
    signal: controller.signal,
    fetchImpl: fakeFetch,
    socketFactory: () => { const socket = new FakeControlSocket(); sockets.push(socket); return socket; },
    observer: (event) => states.push(event.state),
  });
  await waitFor(() => sockets.length === 1);
  sockets[0].message({ op: 10, d: { heartbeat_interval: 60_000 } });
  assert.equal(sockets[0].sent[0].op, 2);
  sockets[0].message({ op: 0, s: 7, t: "READY", d: { session_id: "session", resume_gateway_url: "wss://resume.discord.test" } });
  sockets[0].emit("close", { code: 1006 });
  await waitFor(() => sockets.length === 2);
  assert.match(states.join(","), /discord-ui-ready,discord-ui-resuming/);
  sockets[1].message({ op: 10, d: { heartbeat_interval: 60_000 } });
  assert.deepEqual(sockets[1].sent[0], { op: 6, d: { token: "secret-not-logged", session_id: "session", seq: 7 } });
  sockets[1].message({ op: 0, s: 8, t: "RESUMED", d: {} });
  controller.abort();
  await running;
  assert.ok(states.includes("discord-ui-resumed"));
  assert.equal(sockets.length, 2);
});
