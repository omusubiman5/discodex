import assert from "node:assert/strict";
import test from "node:test";
import { assertDiscodexAcceptance, PRODUCT_PRIMARY_REFERENCES, PRODUCT_REQUIREMENTS, type AcceptanceTrace } from "../src/core/product-acceptance.ts";

test("acceptance contract pins product sources, same thread, and both OS gates", () => {
  assert.equal(PRODUCT_PRIMARY_REFERENCES[0], "PROJECT_GOALS.md#discord-voice-entry");
  assert.ok(PRODUCT_PRIMARY_REFERENCES.includes("docs/DISCORD_VOICE_RUNBOOK.md"));
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
  assert.throws(() => assertDiscodexAcceptance(proxyOnly), /acceptance evidence is not a valid pass/);
});

test("unit evidence cannot impersonate either real OS E2E gate", () => {
  const traces = PRODUCT_REQUIREMENTS.map((requirement): AcceptanceTrace => ({
    requirement, requirementRef: `PROJECT_GOALS.md#discord-voice-entry/${requirement}`, evidenceId: `evidence:${requirement}`, sourcePath: "src/core/codex-audio-route.ts",
    testName: `trace ${requirement}`, evidenceKind: "test", evidenceRef: "unit:test", status: "pass",
  }));
  assert.throws(() => assertDiscodexAcceptance(traces), /Windows E2E evidence is required.*macOS E2E evidence is required/);
});
