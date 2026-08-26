import opus from "@discordjs/opus";
import type { OpusCodec, PcmAudioFrame } from "../windows/ffmpeg-opus-codec.ts";

const { OpusEncoder } = opus;

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const SAMPLES_PER_FRAME = 960 * CHANNELS;

/** One instance owns one stateful libopus encoder and decoder stream. */
export class DiscordJsOpusCodec implements OpusCodec {
  readonly #codec = new OpusEncoder(SAMPLE_RATE, CHANNELS);

  encode(frame: PcmAudioFrame): Uint8Array {
    if (frame.sampleRate !== SAMPLE_RATE || frame.channels !== CHANNELS ||
        !(frame.samples instanceof Int16Array) || frame.samples.length !== SAMPLES_PER_FRAME) {
      throw new Error("Discord Opus input must be one 20 ms 48 kHz stereo signed-16 frame.");
    }
    const pcm = Buffer.from(frame.samples.buffer, frame.samples.byteOffset, frame.samples.byteLength);
    const encoded = this.#codec.encode(pcm);
    if (encoded.length === 0 || encoded.length > 1_500) throw new Error("Discord Opus encoder returned an invalid packet.");
    return Uint8Array.from(encoded);
  }

  decode(opus: Uint8Array): PcmAudioFrame {
    if (!(opus instanceof Uint8Array) || opus.length === 0 || opus.length > 1_500) {
      throw new Error("Discord Opus packet is empty or unbounded.");
    }
    const decoded = this.#codec.decode(Buffer.from(opus));
    if (decoded.length !== SAMPLES_PER_FRAME * Int16Array.BYTES_PER_ELEMENT) {
      throw new Error("Discord Opus decoder returned a non-20 ms PCM frame.");
    }
    return Object.freeze({
      samples: new Int16Array(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength)),
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    });
  }
}
