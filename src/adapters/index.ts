import type { TransportAdapter, TransportKind } from "../core/contracts.ts";
import { DiscordAdapter } from "./discord/discord-adapter.ts";
import { MeetAdapter } from "./meet/meet-adapter.ts";

export function createAdapter(kind: TransportKind): TransportAdapter {
  if (kind === "discord") return new DiscordAdapter();
  if (kind === "meet") return new MeetAdapter();
  throw new Error(`Unsupported transport: ${String(kind)}`);
}
