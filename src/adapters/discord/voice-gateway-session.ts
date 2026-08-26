import type { DaveSession } from "./dave-binding.ts";
import type { GatewayPayload, VoiceGatewayHandoff } from "./gateway-session.ts";

export const DISCORD_VOICE_GATEWAY_VERSION = 8;
export const REQUIRED_TRANSPORT_MODES = [
  "aead_aes256_gcm_rtpsize",
  "aead_xchacha20_poly1305_rtpsize",
] as const;

export type VoiceGatewaySessionState =
  | "idle"
  | "hello-received"
  | "identified"
  | "voice-ready"
  | "protocol-selected"
  | "session-described"
  | "dave-preparing"
  | "dave-ready"
  | "active"
  | "closed";

export interface VoiceReady {
  ip: string;
  port: number;
  ssrc: number;
  modes: readonly string[];
}

export interface SessionDescription {
  mode: string;
  secret_key: readonly number[];
  dave_protocol_version: number;
}

interface PendingDaveTransition {
  transitionId: number;
  protocolVersion: number;
  epoch?: number;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
}

export class DiscordVoiceGatewaySession {
  #state: VoiceGatewaySessionState = "idle";
  #heartbeatPending = false;
  #maxDaveProtocolVersion: number;
  #pendingTransition?: PendingDaveTransition;
  readonly #dave: DaveSession;

  constructor(dave: DaveSession) {
    this.#dave = dave;
    this.#maxDaveProtocolVersion = dave.maxProtocolVersion();
    assertPositiveInteger(this.#maxDaveProtocolVersion, "Official libdave maximum protocol version");
  }

  get state(): VoiceGatewaySessionState {
    return this.#state;
  }

  receiveHello(heartbeatIntervalMs: number): void {
    if (this.#state !== "idle") throw new Error(`Voice Hello is invalid in ${this.#state}.`);
    assertPositiveInteger(heartbeatIntervalMs, "Heartbeat interval");
    this.#state = "hello-received";
  }

  identify(handoff: VoiceGatewayHandoff): GatewayPayload {
    if (this.#state !== "hello-received") throw new Error(`Voice Identify is invalid in ${this.#state}.`);
    if (!handoff.token || !handoff.sessionId) throw new Error("Voice handoff credentials are incomplete.");
    this.#state = "identified";
    return {
      op: 0,
      d: {
        server_id: handoff.guildId,
        user_id: handoff.userId,
        session_id: handoff.sessionId,
        token: handoff.token,
        max_dave_protocol_version: this.#maxDaveProtocolVersion,
      },
    };
  }

  heartbeat(lastReceivedSequence: number | null): GatewayPayload {
    if (this.#state === "idle" || this.#state === "closed") {
      throw new Error(`Voice Heartbeat is invalid in ${this.#state}.`);
    }
    if (this.#heartbeatPending) throw new Error("Voice Gateway heartbeat ACK is overdue.");
    if (lastReceivedSequence !== null && (!Number.isSafeInteger(lastReceivedSequence) || lastReceivedSequence < 0)) {
      throw new Error("Voice Gateway seq_ack must be null or a non-negative integer.");
    }
    this.#heartbeatPending = true;
    return { op: 3, d: { seq_ack: lastReceivedSequence } };
  }

  receiveHeartbeatAck(): void {
    if (!this.#heartbeatPending) throw new Error("Unexpected Voice Gateway heartbeat ACK.");
    this.#heartbeatPending = false;
  }

  receiveReady(ready: VoiceReady): void {
    if (this.#state !== "identified") throw new Error(`Voice Ready is invalid in ${this.#state}.`);
    if (!ready.ip || !Number.isInteger(ready.port) || ready.port <= 0 || ready.port > 65_535) {
      throw new Error("Voice Ready contains an invalid UDP endpoint.");
    }
    assertPositiveInteger(ready.ssrc, "Voice SSRC");
    if (!REQUIRED_TRANSPORT_MODES.some((mode) => ready.modes.includes(mode))) {
      throw new Error("Voice server offers no required AEAD RTP transport mode.");
    }
    this.#state = "voice-ready";
  }

  selectProtocol(discoveredAddress: string, discoveredPort: number, offeredModes: readonly string[]): GatewayPayload {
    if (this.#state !== "voice-ready") throw new Error(`Select Protocol is invalid in ${this.#state}.`);
    if (!discoveredAddress || !Number.isInteger(discoveredPort) || discoveredPort <= 0 || discoveredPort > 65_535) {
      throw new Error("UDP discovery result is invalid.");
    }
    const mode = REQUIRED_TRANSPORT_MODES.find((candidate) => offeredModes.includes(candidate));
    if (!mode) throw new Error("No supported AEAD RTP transport mode can be selected.");
    this.#state = "protocol-selected";
    return { op: 1, d: { protocol: "udp", data: { address: discoveredAddress, port: discoveredPort, mode } } };
  }

  receiveSessionDescription(description: SessionDescription): void {
    if (this.#state !== "protocol-selected") {
      throw new Error(`Session Description is invalid in ${this.#state}.`);
    }
    if (!REQUIRED_TRANSPORT_MODES.includes(description.mode as (typeof REQUIRED_TRANSPORT_MODES)[number])) {
      this.#failClosed("Session Description selected an unsupported transport mode.");
    }
    if (description.secret_key.length !== 32 || description.secret_key.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      this.#failClosed("Session Description transport key must contain exactly 32 bytes.");
    }
    if (description.dave_protocol_version <= 0) {
      this.#failClosed("DAVE protocol version 0/plaintext fallback is forbidden.");
    }
    if (description.dave_protocol_version > this.#maxDaveProtocolVersion) {
      this.#failClosed("Voice server selected an unsupported DAVE protocol version.");
    }
    this.#dave.setProtocolVersion(description.dave_protocol_version);
    this.#state = "session-described";
  }

  receivePrepareTransition(transitionId: number, protocolVersion: number): void {
    this.#prepareDaveTransition({ transitionId, protocolVersion });
  }

  receivePrepareEpoch(transitionId: number, protocolVersion: number, epoch: number): void {
    assertPositiveInteger(epoch, "DAVE epoch");
    this.#prepareDaveTransition({ transitionId, protocolVersion, epoch });
  }

  receiveExternalSender(payload: Uint8Array): void {
    this.#assertPreparing("External Sender");
    this.#dave.setExternalSender(payload);
  }

  receiveProposals(payload: Uint8Array, recognizedUserIds: readonly string[]): Uint8Array | null {
    this.#assertPreparing("Proposals");
    return this.#dave.processProposals(payload, recognizedUserIds);
  }

  receiveCommit(payload: Uint8Array): "accepted" | "ignored" | "failed" {
    this.#assertPreparing("Commit");
    const result = this.#dave.processCommit(payload);
    if (result === "failed") this.#failClosed("DAVE commit processing failed.");
    return result;
  }

  receiveWelcome(payload: Uint8Array, recognizedUserIds: readonly string[]): "accepted" | "failed" {
    this.#assertPreparing("Welcome");
    const result = this.#dave.processWelcome(payload, recognizedUserIds);
    if (result === "failed") this.#failClosed("DAVE welcome processing failed.");
    return result;
  }

  markDaveReady(transitionId: number): GatewayPayload {
    this.#assertPreparing("DAVE Ready");
    if (this.#pendingTransition?.transitionId !== transitionId) this.#failClosed("DAVE transition ID does not match.");
    this.#state = "dave-ready";
    return { op: 23, d: { transition_id: transitionId } };
  }

  executeTransition(transitionId: number): void {
    if (this.#state !== "dave-ready") throw new Error(`DAVE Execute Transition is invalid in ${this.#state}.`);
    if (this.#pendingTransition?.transitionId !== transitionId) this.#failClosed("DAVE transition ID does not match.");
    this.#pendingTransition = undefined;
    this.#state = "active";
  }

  speaking(ssrc: number): GatewayPayload {
    if (this.#state !== "active") throw new Error(`Voice Speaking is invalid in ${this.#state}; DAVE is not active.`);
    assertPositiveInteger(ssrc, "Voice SSRC");
    return { op: 5, d: { speaking: 1, delay: 0, ssrc } };
  }

  encryptOpus(ssrc: number, opusFrame: Uint8Array): Uint8Array {
    if (this.#state !== "active") throw new Error(`Audio send is forbidden in ${this.#state}; DAVE is not active.`);
    return this.#dave.encryptOpus(ssrc, opusFrame);
  }

  decryptOpus(ssrc: number, encryptedFrame: Uint8Array): Uint8Array {
    if (this.#state !== "active") throw new Error(`Audio receive is forbidden in ${this.#state}; DAVE is not active.`);
    return this.#dave.decryptOpus(ssrc, encryptedFrame);
  }

  close(): void {
    this.#pendingTransition = undefined;
    this.#heartbeatPending = false;
    this.#dave.destroy();
    this.#state = "closed";
  }

  #prepareDaveTransition(transition: PendingDaveTransition): void {
    if (this.#state !== "session-described" && this.#state !== "active") {
      throw new Error(`DAVE Prepare Transition is invalid in ${this.#state}.`);
    }
    assertPositiveInteger(transition.transitionId, "DAVE transition ID");
    if (transition.protocolVersion <= 0) this.#failClosed("DAVE downgrade/plaintext transition is forbidden.");
    if (transition.protocolVersion > this.#maxDaveProtocolVersion) {
      this.#failClosed("DAVE transition requests an unsupported protocol version.");
    }
    this.#dave.setProtocolVersion(transition.protocolVersion);
    this.#pendingTransition = transition;
    this.#state = "dave-preparing";
  }

  #assertPreparing(operation: string): void {
    if (this.#state !== "dave-preparing") throw new Error(`${operation} is invalid in ${this.#state}.`);
  }

  #failClosed(message: string): never {
    this.close();
    throw new Error(message);
  }
}
