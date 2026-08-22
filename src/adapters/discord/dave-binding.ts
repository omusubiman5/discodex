export interface DaveSessionOptions {
  authSessionId: string;
  selfUserId: string;
  groupId: bigint;
}

export interface DaveSession {
  maxProtocolVersion(): number;
  setProtocolVersion(version: number): void;
  setExternalSender(payload: Uint8Array): void;
  processProposals(payload: Uint8Array, recognizedUserIds: readonly string[]): Uint8Array | null;
  processCommit(payload: Uint8Array): "accepted" | "ignored" | "failed";
  processWelcome(payload: Uint8Array, recognizedUserIds: readonly string[]): "accepted" | "failed";
  createKeyPackage(): Uint8Array;
  encryptOpus(ssrc: number, opusFrame: Uint8Array): Uint8Array;
  decryptOpus(encryptedFrame: Uint8Array): Uint8Array;
  destroy(): void;
}

export interface DaveBinding {
  readonly provider: "discord/libdave";
  readonly transport: "native-capi" | "official-wasm";
  createSession(options: DaveSessionOptions): DaveSession;
}

export function assertOfficialDaveBinding(binding: DaveBinding): void {
  if (binding.provider !== "discord/libdave") {
    throw new Error("DAVE binding must use Discord's official discord/libdave implementation.");
  }
}
