import assert from "node:assert/strict";
import test from "node:test";
import { EnvironmentCredentialProvider } from "../src/core/credentials.ts";

test("development credential is leased without being logged and cannot be reused after disposal", async () => {
  const variable = "CODEX_BRIDGE_TEST_TOKEN";
  process.env[variable] = "unit-test-only";
  try {
    const lease = await new EnvironmentCredentialProvider(variable).acquire();
    assert.equal(await lease.use(async (value) => value.length), 14);
    lease.dispose();
    await assert.rejects(lease.use(async () => 0), /disposed/);
  } finally {
    delete process.env[variable];
  }
});

test("development credential provider fails when the local variable is absent", async () => {
  delete process.env.CODEX_BRIDGE_MISSING_TOKEN;
  await assert.rejects(
    new EnvironmentCredentialProvider("CODEX_BRIDGE_MISSING_TOKEN").acquire(),
    /is not set/,
  );
});
