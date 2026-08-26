import assert from "node:assert/strict";
import test from "node:test";
import { redact } from "../src/core/redaction.ts";

test("redacts Discord-like secrets, IDs, and Meet URLs", () => {
  const input = "REDACTED_DISCORD_TOKEN user REDACTED_DISCORD_ID_5 https://meet.google.com/abc-defg-hij";
  const output = redact(input);
  assert.doesNotMatch(output, /mfa\./);
  assert.doesNotMatch(output, /REDACTED_DISCORD_ID_5/);
  assert.doesNotMatch(output, /abc-defg-hij/);
});

test("redacts Voice Gateway credentials and endpoint by JSON key", () => {
  const input = JSON.stringify({ token: "voice-token", endpoint: "voice.example", sessionId: "voice-session", secret_key: [1, 2, 3] });
  const output = redact(input);
  assert.doesNotMatch(output, /voice-token|voice\.example|voice-session|\[1,2,3\]/);
  assert.equal(JSON.parse(output).token, "[REDACTED_SECRET]");
});
