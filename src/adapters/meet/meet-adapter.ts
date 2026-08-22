import type {
  BridgeConfig,
  TransportAdapter,
  TransportPlan,
} from "../../core/contracts.ts";
import { isPlaceholder } from "../../core/config.ts";

export class MeetAdapter implements TransportAdapter {
  readonly kind = "meet" as const;

  async plan(config: BridgeConfig): Promise<TransportPlan> {
    const blockers = [
      "Meet is a disabled future adapter candidate and is outside the Discord MVP.",
      "Live Meet browser automation is not implemented in this phase.",
      "Dedicated Chrome profile and audio endpoints require explicit user setup.",
    ];
    if (isPlaceholder(config.meet.meetingUrl)) {
      blockers.push("Meet URL is a placeholder in the example configuration.");
    }

    return {
      transport: "meet",
      dryRun: true,
      capabilities: [
        {
          id: "browser-control",
          status: "planned",
          detail: "Dedicated Chrome only; CDP must remain on 127.0.0.1.",
        },
        {
          id: "isolated-audio-routes",
          status: "planned",
          detail: "Meeting-to-Codex and Codex-to-Meeting endpoints must be distinct.",
        },
      ],
      requiredPermissions: [
        "Dedicated Google account access",
        "Chrome microphone permission for meet.google.com",
      ],
      steps: [
        {
          id: "meet.prepare-profile",
          description: "Would verify a dedicated Chrome profile without reading credentials.",
          risk: "blocked",
          network: "none",
          mutation: "would-change-local",
        },
        {
          id: "meet.join-muted",
          description: "Would join the invite-only meeting with the bridge microphone muted.",
          risk: "blocked",
          network: "would-connect",
          mutation: "would-change-external",
        },
      ],
      blockers,
    };
  }

  async connect(): Promise<never> {
    throw new Error("Meet live connections are intentionally disabled. Use dry-run only.");
  }
}
