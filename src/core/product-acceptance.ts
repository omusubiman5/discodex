export const MEETMATE_PRIMARY_REFERENCES = Object.freeze([
  "https://github.com/caty-ai/meetmate",
  "https://github.com/caty-ai/meetmate/blob/main/docs/TECHNICAL.md",
  "https://github.com/caty-ai/meetmate/blob/main/docs/architecture.md",
  "https://github.com/caty-ai/meetmate/blob/main/docs/setup-guide.md",
  "https://github.com/caty-ai/meetmate/blob/main/docs/deploy-checklist.md",
] as const);

export const PRODUCT_REQUIREMENTS = Object.freeze([
  "same-codex-thread-identity",
  "same-codex-thread-context",
  "personality-memory-skills-tools",
  "discord-input-to-voice-brain",
  "voice-brain-output-to-discord",
  "barge-in-stop-reconnect",
  "windows-real-e2e",
  "macos-real-e2e",
] as const);

export type ProductRequirement = typeof PRODUCT_REQUIREMENTS[number];
export type AcceptanceEvidenceKind = "source" | "test" | "windows-e2e" | "macos-e2e" | "proxy";

export interface AcceptanceTrace {
  readonly requirement: ProductRequirement;
  readonly requirementRef: string;
  readonly evidenceId: string;
  readonly sourcePath: string;
  readonly testName: string;
  readonly evidenceKind: AcceptanceEvidenceKind;
  readonly evidenceRef: string;
  readonly status: "pass" | "invalidated" | "missing";
}

/** Fail-closed requirement -> test -> evidence gate. */
export function assertMeetmateDiscordAcceptance(traces: readonly AcceptanceTrace[]): void {
  const failures: string[] = [];
  for (const requirement of PRODUCT_REQUIREMENTS) {
    const matches = traces.filter((trace) => trace.requirement === requirement);
    if (matches.length !== 1) {
      failures.push(`${requirement}: expected exactly one trace`);
      continue;
    }
    const trace = matches[0]!;
    if (trace.requirementRef !== `PROJECT_GOALS.md#discord-voice-entry/${requirement}`) failures.push(`${requirement}: canonical requirement reference is invalid`);
    if (!/^evidence:[a-z0-9][a-z0-9._-]*$/i.test(trace.evidenceId)) failures.push(`${requirement}: stable evidence ID is invalid`);
    if (!trace.sourcePath || !trace.testName || !trace.evidenceRef) failures.push(`${requirement}: source/test/evidence link is incomplete`);
    if (trace.status !== "pass" || trace.evidenceKind === "proxy") failures.push(`${requirement}: acceptance evidence is not a valid pass`);
    if (requirement === "windows-real-e2e" && trace.evidenceKind !== "windows-e2e") failures.push(`${requirement}: Windows E2E evidence is required`);
    if (requirement === "macos-real-e2e" && trace.evidenceKind !== "macos-e2e") failures.push(`${requirement}: macOS E2E evidence is required`);
  }
  if (failures.length > 0) throw new Error(`Meetmate Discord acceptance failed closed: ${failures.join("; ")}`);
}
