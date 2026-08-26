import assert from "node:assert/strict";
import test from "node:test";
import { assertMeetmateDiscordAcceptance, MEETMATE_PRIMARY_REFERENCES, PRODUCT_REQUIREMENTS, type AcceptanceTrace } from "../src/core/product-acceptance.ts";

test("acceptance contract pins Meetmate sources, same thread, and both OS gates", () => {
  assert.equal(MEETMATE_PRIMARY_REFERENCES[0], "https://github.com/caty-ai/meetmate");
  assert.ok(MEETMATE_PRIMARY_REFERENCES.every((url) => url.startsWith("https://github.com/caty-ai/meetmate")));
  assert.ok(PRODUCT_REQUIREMENTS.includes("same-codex-thread-context"));
  assert.ok(PRODUCT_REQUIREMENTS.includes("windows-real-e2e"));
  assert.ok(PRODUCT_REQUIREMENTS.includes("macos-real-e2e"));
});

test("proxy-only independent bot evidence cannot close product acceptance", () => {
  const proxyOnly = PRODUCT_REQUIREMENTS.map((requirement): AcceptanceTrace => ({
    requirement, requirementRef: `PROJECT_GOALS.md#discord-voice-entry/${requirement}`, evidenceId: `evidence:${requirement}`, sourcePath: "src/discord-gateway-smoke.ts",
    testName: "old independent bot transport probe", evidenceKind: "proxy",
    evidenceRef: "invalidated-for-product-acceptance", status: "invalidated",
  }));
  assert.throws(() => assertMeetmateDiscordAcceptance(proxyOnly), /acceptance evidence is not a valid pass/);
});

test("unit evidence cannot impersonate either real OS E2E gate", () => {
  const traces = PRODUCT_REQUIREMENTS.map((requirement): AcceptanceTrace => ({
    requirement, requirementRef: `PROJECT_GOALS.md#discord-voice-entry/${requirement}`, evidenceId: `evidence:${requirement}`, sourcePath: "src/core/codex-audio-route.ts",
    testName: `trace ${requirement}`, evidenceKind: "test", evidenceRef: "unit:test", status: "pass",
  }));
  assert.throws(() => assertMeetmateDiscordAcceptance(traces), /Windows E2E evidence is required.*macOS E2E evidence is required/);
});
