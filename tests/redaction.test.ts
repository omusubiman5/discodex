import assert from "node:assert/strict";
import test from "node:test";
import { redact } from "../src/core/redaction.ts";

test("redacts Discord-like secrets, IDs, and Meet URLs", () => {
  const input = "REDACTED_DISCORD_TOKEN user REDACTED_DISCORD_ID_1 https://meet.google.com/abc-defg-hij";
  const output = redact(input);
  assert.doesNotMatch(output, /mfa\./);
  assert.doesNotMatch(output, /REDACTED_DISCORD_ID_1/);
  assert.doesNotMatch(output, /abc-defg-hij/);
});
