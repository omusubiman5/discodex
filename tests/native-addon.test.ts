import assert from "node:assert/strict";
import test from "node:test";
import { loadOfficialLibdaveNativeProbe, openOfficialLibdaveNativeReadySession } from "../src/adapters/discord/native-addon.ts";
import { TEST_DISCORD_ID_1, TEST_DISCORD_ID_2 } from "./fixtures/public-identities.mjs";

test("loads only an official native C API probe with a passing lifecycle", () => {
  let loadedPath = "";
  const result = loadOfficialLibdaveNativeProbe("work/probe.node", (absolutePath) => {
    loadedPath = absolutePath;
    return { maxProtocolVersion: 1, sessionLifecycle: () => true };
  });

  assert.match(loadedPath, /probe\.node$/);
  assert.deepEqual(result, {
    provider: "discord/libdave",
    transport: "native-capi",
    maxProtocolVersion: 1,
    sessionLifecycle: true,
  });
  assert.equal(Object.isFrozen(result), true);
});

test("opens and explicitly closes an official native ready session", () => {
  let open = false;
  const session = openOfficialLibdaveNativeReadySession("work/probe.node", () => ({
    maxProtocolVersion: 1,
    sessionOpen: () => { open = true; return true; },
    sessionClose: () => { open = false; return true; },
    sessionIsOpen: () => open,
  }));
  assert.equal(session.state, "initialized");
  assert.equal(session.isOpen(), true);
  session.close();
  assert.equal(session.isOpen(), false);
  session.close();
});

test("native ready session exposes live epoch and External Sender operations", () => {
  const calls: string[] = [];
  let open = false;
  const session = openOfficialLibdaveNativeReadySession("work/probe.node", () => ({
    maxProtocolVersion: 1,
    sessionOpen: () => { open = true; return true; },
    sessionClose: () => { open = false; return true; },
    sessionIsOpen: () => open,
    sessionConfigure: (group: string, user: string) => { calls.push(`configure:${group}:${user}`); return true; },
    sessionSetProtocolVersion: (version: number) => { calls.push(`version:${version}`); return true; },
    sessionSetExternalSender: (payload: Uint8Array) => { calls.push(`external:${Buffer.from(payload).toString("hex")}`); return true; },
    sessionKeyPackage: () => { calls.push("key-package"); return Buffer.from([1, 2, 3]); },
  }));
  session.setProtocolVersion(1);
  session.setExternalSender(Uint8Array.from([0xaa]));
  session.configure(TEST_DISCORD_ID_1, TEST_DISCORD_ID_2);
  assert.deepEqual(session.createKeyPackage(), Uint8Array.from([1, 2, 3]));
  assert.deepEqual(calls, ["version:1", "external:aa", `configure:${TEST_DISCORD_ID_1}:${TEST_DISCORD_ID_2}`, "key-package"]);
  session.close();
});

test("native ready session processes MLS control results and fails closed on malformed ABI results", () => {
  let open = false;
  const session = openOfficialLibdaveNativeReadySession("work/probe.node", () => ({
    maxProtocolVersion: 1,
    sessionOpen: () => { open = true; return true; },
    sessionClose: () => { open = false; return true; },
    sessionIsOpen: () => open,
    sessionProcessProposals: () => Buffer.from([9]),
    sessionProcessCommit: () => "ignored",
    sessionProcessWelcome: () => false,
    sessionReset: () => true,
  }));
  assert.deepEqual(session.processProposals(Uint8Array.from([1]), [TEST_DISCORD_ID_1]), Uint8Array.from([9]));
  assert.equal(session.processCommit(Uint8Array.from([2])), "ignored");
  assert.equal(session.processWelcome(Uint8Array.from([3]), [TEST_DISCORD_ID_1]), "failed");
  session.reset();
  session.close();

  let invalidOpen = false;
  const invalid = openOfficialLibdaveNativeReadySession("work/probe.node", () => ({
    maxProtocolVersion: 1,
    sessionOpen: () => { invalidOpen = true; return true; },
    sessionClose: () => { invalidOpen = false; return true; },
    sessionIsOpen: () => invalidOpen,
    sessionProcessCommit: () => true,
  }));
  assert.throws(() => invalid.processCommit(Uint8Array.from([1])), /commit result is invalid/);
  invalid.close();
});

test("native ready session binds DAVE decrypt to the packet SSRC", () => {
  const calls: string[] = [];
  let open = false;
  const session = openOfficialLibdaveNativeReadySession("work/probe.node", () => ({
    maxProtocolVersion: 1,
    sessionOpen: () => { open = true; return true; },
    sessionClose: () => { open = false; return true; },
    sessionIsOpen: () => open,
    sessionSelectMediaRatchet: (userId: string, ssrc: number) => { calls.push(`select:${userId}:${ssrc}`); return true; },
    sessionDecryptOpus: (ssrc: number, frame: Uint8Array) => { calls.push(`decrypt:${ssrc}`); return Buffer.from(frame).subarray(1); },
  }));
  session.selectMediaRatchet(TEST_DISCORD_ID_1, 84);
  assert.deepEqual(session.decryptOpus(84, Uint8Array.from([0xda, 1, 2])), Uint8Array.from([1, 2]));
  assert.deepEqual(calls, [`select:${TEST_DISCORD_ID_1}:84`, "decrypt:84"]);
  session.close();
});

test("rejects non-native, malformed, and failed addon probes", () => {
  assert.throws(() => loadOfficialLibdaveNativeProbe("probe.js", () => ({})), /must end in \.node/);
  assert.throws(
    () => loadOfficialLibdaveNativeProbe("probe.node", () => ({ maxProtocolVersion: 0, sessionLifecycle: () => true })),
    /invalid protocol version/,
  );
  assert.throws(
    () => loadOfficialLibdaveNativeProbe("probe.node", () => ({ maxProtocolVersion: 1, sessionLifecycle: () => false })),
    /failed closed/,
  );
  assert.throws(
    () => loadOfficialLibdaveNativeProbe("probe.node", () => ({ maxProtocolVersion: 1, sessionLifecycle: () => { throw new Error("native"); } })),
    /probe threw/,
  );
});
