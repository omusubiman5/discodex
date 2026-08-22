import assert from "node:assert/strict";
import test from "node:test";
import { DiscordGatewaySession } from "../src/adapters/discord/gateway-session.ts";

test("Gateway session creates a voice handoff only after both matching updates", () => {
  const session = new DiscordGatewaySession();
  session.receiveHello();
  const identify = session.identify("unit-test-credential");
  assert.equal(identify.op, 2);
  assert.equal((identify.d as { intents: number }).intents, 1 << 7);
  session.receiveReady("bot");
  assert.equal(session.requestVoiceState("guild", "voice").op, 4);
  assert.equal(session.receiveVoiceServerUpdate({ guildId: "guild", endpoint: "voice.example", token: "voice-token" }), null);
  const handoff = session.receiveVoiceStateUpdate({ guildId: "guild", channelId: "voice", userId: "bot", sessionId: "session" });
  assert.deepEqual(handoff, {
    guildId: "guild",
    channelId: "voice",
    userId: "bot",
    sessionId: "session",
    endpoint: "voice.example",
    token: "voice-token",
  });
  session.close();
  assert.equal(session.state, "closed");
});

test("Gateway session fails closed when voice update guilds differ", () => {
  const session = new DiscordGatewaySession();
  session.receiveHello();
  session.identify("unit-test-credential");
  session.receiveReady("bot");
  session.requestVoiceState("guild-a", "voice");
  session.receiveVoiceStateUpdate({ guildId: "guild-a", channelId: "voice", userId: "bot", sessionId: "session" });
  assert.throws(
    () => session.receiveVoiceServerUpdate({ guildId: "guild-b", endpoint: "voice.example", token: "voice-token" }),
    /does not match/,
  );
  assert.equal(session.state, "closed");
});

test("Gateway session fails closed when channel or bot user does not match the request", () => {
  for (const update of [
    { guildId: "guild", channelId: "other", userId: "bot", sessionId: "session" },
    { guildId: "guild", channelId: "voice", userId: "other-bot", sessionId: "session" },
  ]) {
    const session = new DiscordGatewaySession();
    session.receiveHello();
    session.identify("unit-test-credential");
    session.receiveReady("bot");
    session.requestVoiceState("guild", "voice");
    assert.throws(() => session.receiveVoiceStateUpdate(update), /does not match/);
    assert.equal(session.state, "closed");
  }
});

test("Gateway session rejects duplicate handoff events", () => {
  const session = new DiscordGatewaySession();
  session.receiveHello();
  session.identify("unit-test-credential");
  session.receiveReady("bot");
  session.requestVoiceState("guild", "voice");
  session.receiveVoiceServerUpdate({ guildId: "guild", endpoint: "voice.example", token: "voice-token" });
  assert.throws(
    () => session.receiveVoiceServerUpdate({ guildId: "guild", endpoint: "voice.example", token: "voice-token-2" }),
    /Duplicate/,
  );
  assert.equal(session.state, "closed");
});
