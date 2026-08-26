import assert from "node:assert/strict";
import test from "node:test";
import { DiscordJsOpusCodec } from "../src/adapters/discord/discordjs-opus-codec.ts";

function frame(phase: number) {
  return {
    samples: Int16Array.from({ length: 1_920 }, (_, index) => Math.round(Math.sin((index + phase) / 18) * 4_000)),
    sampleRate: 48_000 as const,
    channels: 2 as const,
  };
}

test("persistent Discord libopus codec preserves one 20 ms stream across consecutive frames", () => {
  const encoder = new DiscordJsOpusCodec();
  const decoder = new DiscordJsOpusCodec();
  for (let index = 0; index < 20; index += 1) {
    const packet = encoder.encode(frame(index * 1_920));
    const pcm = decoder.decode(packet);
    assert.equal(pcm.samples.length, 1_920);
    assert.ok(packet.length > 0 && packet.length < 1_500);
    assert.ok(Math.max(...pcm.samples.map(Math.abs)) > 100);
  }
});

test("Discord libopus codec rejects non-20 ms PCM instead of resetting its stream", () => {
  const codec = new DiscordJsOpusCodec();
  assert.throws(() => codec.encode({ ...frame(0), samples: new Int16Array(960) }), /one 20 ms/);
});
