import assert from "node:assert/strict";
import test from "node:test";
import type { DaveSession } from "../src/adapters/discord/dave-binding.ts";
import { DiscordVoiceGatewaySession } from "../src/adapters/discord/voice-gateway-session.ts";

function createDaveMock(
  maxVersion = 1,
  results: { commit?: "accepted" | "ignored" | "failed"; welcome?: "accepted" | "failed" } = {},
): DaveSession & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    maxProtocolVersion: () => maxVersion,
    setProtocolVersion: (version) => calls.push(`version:${version}`),
    setExternalSender: () => calls.push("external-sender"),
    processProposals: () => (calls.push("proposals"), new Uint8Array([1])),
    processCommit: () => (calls.push("commit"), results.commit ?? "accepted"),
    processWelcome: () => (calls.push("welcome"), results.welcome ?? "accepted"),
    createKeyPackage: () => new Uint8Array([1]),
    encryptOpus: (_ssrc, frame) => frame,
    decryptOpus: (frame) => frame,
    destroy: () => calls.push("destroy"),
  };
}

function reachDavePreparing(session: DiscordVoiceGatewaySession, transitionId = 12): void {
  reachProtocolSelection(session);
  session.selectProtocol("198.51.100.7", 50_001, ["aead_xchacha20_poly1305_rtpsize"]);
  session.receiveSessionDescription({
    mode: "aead_xchacha20_poly1305_rtpsize",
    secret_key: new Array(32).fill(7),
    dave_protocol_version: 1,
  });
  session.receivePrepareEpoch(transitionId, 1, 3);
}

function reachProtocolSelection(session: DiscordVoiceGatewaySession, offeredModes = ["aead_xchacha20_poly1305_rtpsize"]): void {
  session.receiveHello(10_000);
  const identify = session.identify({
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    sessionId: "session",
    endpoint: "voice.example.invalid",
    token: "ephemeral-voice-token",
  });
  assert.deepEqual(identify, {
    op: 0,
    d: {
      server_id: "guild",
      user_id: "user",
      session_id: "session",
      token: "ephemeral-voice-token",
      max_dave_protocol_version: 1,
    },
  });
  session.receiveReady({ ip: "192.0.2.10", port: 50_000, ssrc: 42, modes: offeredModes });
}

test("Voice Gateway v8 completes transport and DAVE only after Execute Transition", () => {
  const dave = createDaveMock();
  const session = new DiscordVoiceGatewaySession(dave);
  reachProtocolSelection(session);
  const select = session.selectProtocol("198.51.100.7", 50_001, ["aead_xchacha20_poly1305_rtpsize"]);
  assert.equal((select.d as { data: { mode: string } }).data.mode, "aead_xchacha20_poly1305_rtpsize");
  session.receiveSessionDescription({
    mode: "aead_xchacha20_poly1305_rtpsize",
    secret_key: new Array(32).fill(7),
    dave_protocol_version: 1,
  });
  session.receivePrepareEpoch(12, 1, 3);
  session.receiveExternalSender(new Uint8Array([1]));
  session.receiveProposals(new Uint8Array([2]), ["user"]);
  session.receiveCommit(new Uint8Array([3]));
  assert.throws(() => session.encryptOpus(42, new Uint8Array([9])), /DAVE is not active/);
  assert.throws(() => session.executeTransition(12), /invalid in dave-preparing/);
  assert.deepEqual(session.markDaveReady(12), { op: 23, d: { transition_id: 12 } });
  session.executeTransition(12);
  assert.equal(session.state, "active");
  assert.deepEqual(session.speaking(42), { op: 5, d: { speaking: 1, delay: 0, ssrc: 42 } });
  assert.deepEqual(session.encryptOpus(42, new Uint8Array([9])), new Uint8Array([9]));
  assert.deepEqual(dave.calls, ["version:1", "version:1", "external-sender", "proposals", "commit"]);
});

test("Voice Gateway prefers AES-GCM and falls back only to required XChaCha20", () => {
  const session = new DiscordVoiceGatewaySession(createDaveMock());
  const modes = ["aead_xchacha20_poly1305_rtpsize", "aead_aes256_gcm_rtpsize"];
  reachProtocolSelection(session, modes);
  const payload = session.selectProtocol("198.51.100.7", 50_001, modes);
  assert.equal((payload.d as { data: { mode: string } }).data.mode, "aead_aes256_gcm_rtpsize");

  const rejected = new DiscordVoiceGatewaySession(createDaveMock());
  rejected.receiveHello(10_000);
  rejected.identify({ guildId: "g", channelId: "c", userId: "u", sessionId: "s", endpoint: "e", token: "t" });
  assert.throws(
    () => rejected.receiveReady({ ip: "192.0.2.1", port: 50_000, ssrc: 1, modes: ["xsalsa20_poly1305"] }),
    /no required AEAD/,
  );
});

test("Voice Gateway heartbeat carries v8 seq_ack and fails on an overdue ACK", () => {
  const session = new DiscordVoiceGatewaySession(createDaveMock());
  session.receiveHello(10_000);
  assert.deepEqual(session.heartbeat(17), { op: 3, d: { seq_ack: 17 } });
  assert.throws(() => session.heartbeat(18), /ACK is overdue/);
  session.receiveHeartbeatAck();
  assert.deepEqual(session.heartbeat(null), { op: 3, d: { seq_ack: null } });
});

test("Voice Gateway forbids DAVE version zero and malformed transport keys", () => {
  const session = new DiscordVoiceGatewaySession(createDaveMock());
  reachProtocolSelection(session);
  session.selectProtocol("198.51.100.7", 50_001, ["aead_xchacha20_poly1305_rtpsize"]);
  assert.throws(
    () => session.receiveSessionDescription({ mode: "aead_xchacha20_poly1305_rtpsize", secret_key: [1, 2], dave_protocol_version: 1 }),
    /exactly 32 bytes/,
  );

  const downgrade = new DiscordVoiceGatewaySession(createDaveMock());
  reachProtocolSelection(downgrade);
  downgrade.selectProtocol("198.51.100.7", 50_001, ["aead_xchacha20_poly1305_rtpsize"]);
  assert.throws(
    () => downgrade.receiveSessionDescription({ mode: "aead_xchacha20_poly1305_rtpsize", secret_key: new Array(32).fill(1), dave_protocol_version: 0 }),
    /plaintext fallback is forbidden/,
  );
  assert.equal(downgrade.state, "closed");
});

test("DAVE transition IDs must match and downgrade transitions fail closed", () => {
  const session = new DiscordVoiceGatewaySession(createDaveMock());
  reachProtocolSelection(session);
  session.selectProtocol("198.51.100.7", 50_001, ["aead_xchacha20_poly1305_rtpsize"]);
  session.receiveSessionDescription({ mode: "aead_xchacha20_poly1305_rtpsize", secret_key: new Array(32).fill(1), dave_protocol_version: 1 });
  assert.throws(() => session.receivePrepareTransition(1, 0), /downgrade\/plaintext/);
  assert.equal(session.state, "closed");

  const mismatch = new DiscordVoiceGatewaySession(createDaveMock());
  reachProtocolSelection(mismatch);
  mismatch.selectProtocol("198.51.100.7", 50_001, ["aead_xchacha20_poly1305_rtpsize"]);
  mismatch.receiveSessionDescription({ mode: "aead_xchacha20_poly1305_rtpsize", secret_key: new Array(32).fill(1), dave_protocol_version: 1 });
  mismatch.receivePrepareTransition(1, 1);
  assert.throws(() => mismatch.markDaveReady(2), /does not match/);
  assert.equal(mismatch.state, "closed");
});

test("failed DAVE commit destroys the session and permanently blocks ready, execute, and audio", () => {
  const dave = createDaveMock(1, { commit: "failed" });
  const session = new DiscordVoiceGatewaySession(dave);
  reachDavePreparing(session, 31);

  assert.throws(() => session.receiveCommit(new Uint8Array([3])), /commit processing failed/);
  assert.equal(session.state, "closed");
  assert.equal(dave.calls.at(-1), "destroy");
  assert.throws(() => session.markDaveReady(31), /invalid in closed/);
  assert.throws(() => session.executeTransition(31), /invalid in closed/);
  assert.throws(() => session.encryptOpus(42, new Uint8Array([7])), /forbidden in closed/);
});

test("failed DAVE welcome destroys the session and permanently blocks ready, execute, and audio", () => {
  const dave = createDaveMock(1, { welcome: "failed" });
  const session = new DiscordVoiceGatewaySession(dave);
  reachDavePreparing(session, 32);

  assert.throws(() => session.receiveWelcome(new Uint8Array([4]), ["user"]), /welcome processing failed/);
  assert.equal(session.state, "closed");
  assert.equal(dave.calls.at(-1), "destroy");
  assert.throws(() => session.markDaveReady(32), /invalid in closed/);
  assert.throws(() => session.executeTransition(32), /invalid in closed/);
  assert.throws(() => session.encryptOpus(42, new Uint8Array([7])), /forbidden in closed/);
});
