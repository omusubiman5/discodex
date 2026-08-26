import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv } from "node:crypto";
import { DiscordAesRtpTransport } from "../src/adapters/discord/rtp-aead.ts";
import type { DaveSession } from "../src/adapters/discord/dave-binding.ts";

test("DAVE Opus is nested inside Discord AES-GCM RTP and round-trips", () => {
  const calls: string[] = [];
  const dave = {
    encryptOpus: (ssrc: number, frame: Uint8Array) => { calls.push(`encrypt:${ssrc}`); return Uint8Array.from([0xda, ...frame]); },
    decryptOpus: (ssrc: number, frame: Uint8Array) => { calls.push(`decrypt:${ssrc}`); assert.equal(frame[0], 0xda); return frame.slice(1); },
  } as DaveSession;
  const transport = new DiscordAesRtpTransport({
    secretKey: new Uint8Array(32).fill(7), ssrc: 42, mode: "aead_aes256_gcm_rtpsize", dave,
  });
  const packet = transport.encode(Uint8Array.from([1, 2, 3]));
  assert.equal(packet[0], 0x80);
  assert.equal(packet[1], 0x78);
  assert.deepEqual([...transport.decode(packet).opus], [1, 2, 3]);
  assert.deepEqual(calls, ["encrypt:42", "decrypt:42"]);
});

test("RTP-size decrypt authenticates the extension preamble and decrypts extension data with the payload", () => {
  const key = Buffer.alloc(32, 7);
  const dave = {
    encryptOpus: () => { throw new Error("not used"); },
    decryptOpus: (ssrc: number, frame: Uint8Array) => {
      assert.equal(ssrc, 42);
      assert.deepEqual([...frame], [0xda, 1, 2, 3]);
      return frame.slice(1);
    },
  } as DaveSession;
  const transport = new DiscordAesRtpTransport({ secretKey: key, ssrc: 42, mode: "aead_aes256_gcm_rtpsize", dave });
  const header = Buffer.alloc(16);
  header[0] = 0x90;
  header[1] = 0x78;
  header.writeUInt32BE(42, 8);
  header.writeUInt16BE(0xbede, 12);
  header.writeUInt16BE(1, 14);
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(9, 0);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(Uint8Array.from([0x10, 0, 0, 0, 0xda, 1, 2, 3])), cipher.final()]);
  const packet = Buffer.concat([header, ciphertext, cipher.getAuthTag(), nonce.subarray(0, 4)]);
  assert.deepEqual([...transport.decode(packet).opus], [1, 2, 3]);
});
