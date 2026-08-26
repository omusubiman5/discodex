import assert from "node:assert/strict";
import test from "node:test";
import { MacosFfmpegOpusCodec } from "../src/adapters/macos/ffmpeg-opus-codec.ts";

const KNOWN_OPUS = Uint8Array.from(Buffer.from("7881a75d6c7e40e600000a3f644cfde7b45933264f56f15dbdc8a3ee57a565cb7563ae7dbef27d9e7c6c7232420d1fbcd53719a897a71830f205bd757d24b4c81e3926d5a1aa751ed003", "hex"));

test("macOS ffmpeg adapter exposes the same bounded Discord Opus/PCM contract", () => {
  const codec = new MacosFfmpegOpusCodec();
  const pcm = codec.decode(KNOWN_OPUS);
  assert.deepEqual({ sampleRate: pcm.sampleRate, channels: pcm.channels, samples: pcm.samples.length }, { sampleRate: 48_000, channels: 2, samples: 1_920 });
  const encoded = codec.encode(pcm);
  assert.ok(encoded.length > 0 && encoded.length < 1_500);
});

test("macOS ffmpeg adapter can decode asynchronously without blocking the event loop", async () => {
  const codec = new MacosFfmpegOpusCodec();
  const source = { samples: Int16Array.from({ length: 1_920 }, (_, index) => Math.round(Math.sin(index / 12) * 2_000)), sampleRate: 48_000 as const, channels: 2 as const };
  const opus = codec.encode(source);
  let timerFired = false;
  const decoding = codec.decodeAsync!(opus);
  setTimeout(() => { timerFired = true; }, 0);
  const decoded = await decoding;
  assert.equal(timerFired, true);
  assert.equal(decoded.samples.length > 0, true);
});

test("macOS adapter fails closed when ffmpeg is unavailable", () => {
  assert.throws(() => new MacosFfmpegOpusCodec("missing-ffmpeg").decode(KNOWN_OPUS), /failed closed/);
});
