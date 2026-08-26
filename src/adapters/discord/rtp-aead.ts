import { createCipheriv, createDecipheriv } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import type { DaveSession } from "./dave-binding.ts";

/** The only transport mode implemented by the product path. XChaCha is rejected
 * rather than silently using a non-official crypto implementation. */
export const DISCORD_AES_GCM_RTP_SIZE = "aead_aes256_gcm_rtpsize";
const RTP_HEADER_BYTES = 12;
const AEAD_TAG_BYTES = 16;
const NONCE_SUFFIX_BYTES = 4;
const OPUS_PAYLOAD_TYPE = 0x78;

export interface RtpAudioFrame {
  readonly ssrc: number;
  readonly sequence: number;
  readonly timestamp: number;
  readonly opus: Uint8Array;
}

export interface DiscordAesRtpOptions {
  readonly secretKey: Uint8Array;
  readonly ssrc: number;
  readonly dave: DaveSession;
  readonly mode: string;
}

function assertU32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`${name} must be a uint32.`);
}

function parseRtpHeader(packet: Uint8Array): { readonly header: Buffer; readonly headerLength: number; readonly encryptedExtensionBytes: number; readonly ssrc: number; readonly sequence: number; readonly timestamp: number } {
  if (packet.length < RTP_HEADER_BYTES + AEAD_TAG_BYTES + NONCE_SUFFIX_BYTES || packet[0] === undefined || packet[1] === undefined) {
    throw new Error("Discord RTP packet is truncated.");
  }
  if (packet[0]! >> 6 !== 2 || (packet[1]! & 0x7f) !== OPUS_PAYLOAD_TYPE) throw new Error("Discord RTP packet is not Opus RTP.");
  const csrcCount = packet[0]! & 0x0f;
  const hasExtension = Boolean(packet[0]! & 0x10);
  let headerLength = RTP_HEADER_BYTES + (csrcCount * 4);
  let encryptedExtensionBytes = 0;
  if (hasExtension) {
    if (packet.length < headerLength + 4) throw new Error("Discord RTP extension header is truncated.");
    encryptedExtensionBytes = Buffer.from(packet).readUInt16BE(headerLength + 2) * 4;
    // RTP-size modes authenticate the fixed header, CSRCs, and extension
    // preamble. The extension data itself remains inside the AEAD ciphertext.
    headerLength += 4;
  }
  if (packet.length < headerLength + encryptedExtensionBytes + AEAD_TAG_BYTES + NONCE_SUFFIX_BYTES) throw new Error("Discord RTP encrypted payload is truncated.");
  const data = Buffer.from(packet);
  return {
    header: data.subarray(0, headerLength), headerLength, encryptedExtensionBytes,
    sequence: data.readUInt16BE(2), timestamp: data.readUInt32BE(4), ssrc: data.readUInt32BE(8),
  };
}

/**
 * AES-GCM RTP framing for Discord's `aead_aes256_gcm_rtpsize` mode. DAVE is
 * always applied inside the transport AEAD; there is no plaintext fallback.
 */
export class DiscordAesRtpTransport {
  readonly #key: Buffer;
  readonly #ssrc: number;
  readonly #dave: DaveSession;
  #sequence = Math.floor(Math.random() * 0x1_0000);
  #timestamp = Math.floor(Math.random() * 0x1_0000_0000);
  #nonce = 0;

  constructor(options: DiscordAesRtpOptions) {
    if (options.mode !== DISCORD_AES_GCM_RTP_SIZE) throw new Error("Discord transport mode is unsupported; AES-GCM RTP-size is required.");
    if (!(options.secretKey instanceof Uint8Array) || options.secretKey.length !== 32) throw new Error("Discord AES-GCM key must be exactly 32 bytes.");
    assertU32(options.ssrc, "Discord RTP SSRC");
    this.#key = Buffer.from(options.secretKey);
    this.#ssrc = options.ssrc;
    this.#dave = options.dave;
  }

  encode(opus: Uint8Array): Buffer {
    if (!(opus instanceof Uint8Array) || opus.length === 0) throw new Error("Discord Opus frame is empty.");
    const header = Buffer.alloc(RTP_HEADER_BYTES);
    header[0] = 0x80;
    header[1] = OPUS_PAYLOAD_TYPE;
    header.writeUInt16BE(this.#sequence, 2);
    header.writeUInt32BE(this.#timestamp, 4);
    header.writeUInt32BE(this.#ssrc, 8);
    this.#sequence = (this.#sequence + 1) & 0xffff;
    this.#timestamp = (this.#timestamp + 960) >>> 0; // 20ms at 48kHz
    this.#nonce = (this.#nonce + 1) >>> 0;
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(this.#nonce, 0);
    const inner = this.#dave.encryptOpus(this.#ssrc, opus);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(inner), cipher.final(), cipher.getAuthTag(), nonce.subarray(0, NONCE_SUFFIX_BYTES)]);
  }

  decode(packet: Uint8Array): RtpAudioFrame {
    const parsed = parseRtpHeader(packet);
    const bytes = Buffer.from(packet);
    const nonce = Buffer.alloc(12);
    bytes.copy(nonce, 0, bytes.length - NONCE_SUFFIX_BYTES);
    const ciphertextEnd = bytes.length - NONCE_SUFFIX_BYTES - AEAD_TAG_BYTES;
    const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
    decipher.setAAD(parsed.header);
    decipher.setAuthTag(bytes.subarray(ciphertextEnd, bytes.length - NONCE_SUFFIX_BYTES));
    const protectedPayload = Buffer.concat([decipher.update(bytes.subarray(parsed.headerLength, ciphertextEnd)), decipher.final()]);
    const daveCiphertext = protectedPayload.subarray(parsed.encryptedExtensionBytes);
    return Object.freeze({
      ssrc: parsed.ssrc, sequence: parsed.sequence, timestamp: parsed.timestamp,
      opus: this.#dave.decryptOpus(parsed.ssrc, daveCiphertext),
    });
  }
}

export class DiscordUdpMediaSocket {
  readonly #socket: Socket;
  readonly #host: string;
  readonly #port: number;
  #closed = false;

  constructor(host: string, port: number) {
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("Discord UDP media endpoint is invalid.");
    this.#host = host;
    this.#port = port;
    this.#socket = createSocket("udp4");
  }

  onFrame(listener: (packet: Uint8Array) => void): void {
    this.#socket.on("message", (message) => listener(Uint8Array.from(message)));
  }

  async send(packet: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("Discord UDP media socket is closed.");
    await new Promise<void>((resolve, reject) => this.#socket.send(packet, this.#port, this.#host, (error) => error ? reject(error) : resolve()));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close();
  }
}
