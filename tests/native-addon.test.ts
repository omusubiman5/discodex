import assert from "node:assert/strict";
import test from "node:test";
import { loadOfficialLibdaveNativeProbe } from "../src/adapters/discord/native-addon.ts";

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
