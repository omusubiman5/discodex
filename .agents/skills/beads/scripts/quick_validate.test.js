import assert from "node:assert/strict";
import test from "node:test";
import { quickValidate } from "./quick_validate.js";

const keys = ["external_product_url", "voice_agent_identity", "supported_os", "observable_real_e2e"];

function fixture() {
  const requirements = Object.fromEntries(keys.map((key) => [key, { issue_id: `epic.${key}`, test_ref: `test:${key}`, evidence_ref: `evidence:${key}` }]));
  const children = keys.map((key) => ({
    id: `epic.${key}`,
    parent: "epic",
    issue_type: "task",
    metadata: { acceptance_trace: { epic_id: "epic", requirements: { [key]: {
      test_ref: `test:${key}`,
      evidence_ref: `evidence:${key}`,
      ...(key === "observable_real_e2e" ? { evidence_kind: "observable_real_e2e", actor: "shadow verifier", environment: "real Windows + Discord", operation: "speak to the configured voice agent", observable_result: "audible agent response" } : {})
    } } } }
  }));
  return [{ id: "epic", issue_type: "epic", external_ref: "https://example.test/product", metadata: { product_acceptance: { product_url: "https://example.test/product", voice_agent_identity: "Codex voice agent", supported_os: ["Windows", "macOS"], requirements } } }, ...children];
}

test("complete bidirectional product trace passes", () => assert.deepEqual(quickValidate(fixture(), "epic").errors, []));

test("missing external product URL fails", () => {
  const issues = fixture();
  issues[0].external_ref = "identity:internal";
  issues[0].metadata.product_acceptance.product_url = "";
  assert.ok(quickValidate(issues, "epic").errors.some((error) => error.startsWith("external_product_url:")));
});

test("internal or mismatched Epic external_ref fails", () => {
  const issues = fixture();
  issues[0].external_ref = "identity:internal";
  assert.ok(quickValidate(issues, "epic").errors.some((error) => error.includes("external_ref must match")));
});

test("missing voice identity or supported OS fails", () => {
  const issues = fixture();
  issues[0].metadata.product_acceptance.voice_agent_identity = "";
  issues[0].metadata.product_acceptance.supported_os = [];
  const errors = quickValidate(issues, "epic").errors;
  assert.ok(errors.some((error) => error.startsWith("voice_agent_identity:")));
  assert.ok(errors.some((error) => error.startsWith("supported_os:")));
});

test("one-way or mismatched trace fails", () => {
  const issues = fixture();
  issues[1].metadata.acceptance_trace.requirements.external_product_url.test_ref = "test:other";
  assert.ok(quickValidate(issues, "epic").errors.some((error) => error.includes("reverse trace")));
});

for (const proxy of ["process", "participant", "counter", "unit_test", "internal_transport"]) {
  test(`proxy-only ${proxy} evidence cannot close observable E2E`, () => {
    const issues = fixture();
    const child = issues.find((issue) => issue.id === "epic.observable_real_e2e");
    child.metadata.acceptance_trace.requirements.observable_real_e2e.evidence_kind = proxy;
    assert.ok(quickValidate(issues, "epic").errors.some((error) => error.includes("proxy-only")));
  });
}
