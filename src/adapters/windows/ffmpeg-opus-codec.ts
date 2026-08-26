import { spawn, spawnSync } from "node:child_process";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const MAX_FRAME_SAMPLES = 5_760 * CHANNELS;
const MAX_DECODED_SAMPLES = SAMPLE_RATE * CHANNELS;

export interface PcmAudioFrame {
  readonly samples: Int16Array;
  readonly sampleRate: 48_000;
  readonly channels: 2;
}

export interface OpusCodec {
  decode(opus: Uint8Array): PcmAudioFrame;
  decodeAsync?(opus: Uint8Array): Promise<PcmAudioFrame>;
  decodeBatchAsync?(opusPackets: readonly Uint8Array[]): Promise<PcmAudioFrame>;
  encode(frame: PcmAudioFrame): Uint8Array;
}

function crc32Ogg(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000_0000) ? ((crc << 1) ^ 0x04c1_1db7) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

function oggPage(packet: Uint8Array, serial: number, sequence: number, granule: bigint, flags: number): Buffer {
  if (packet.length === 0 || packet.length > 65_025) throw new Error("Opus packet cannot fit in one bounded Ogg page.");
  const lacing: number[] = [];
  for (let remaining = packet.length; remaining >= 255; remaining -= 255) lacing.push(255);
  lacing.push(packet.length % 255);
  const page = Buffer.alloc(27 + lacing.length + packet.length);
  page.write("OggS", 0, "ascii");
  page[4] = 0;
  page[5] = flags;
  page.writeBigUInt64LE(granule, 6);
  page.writeUInt32LE(serial >>> 0, 14);
  page.writeUInt32LE(sequence >>> 0, 18);
  page.writeUInt32LE(0, 22);
  page[26] = lacing.length;
  page.set(lacing, 27);
  page.set(packet, 27 + lacing.length);
  page.writeUInt32LE(crc32Ogg(page), 22);
  return page;
}

function wrapOpusPacket(opus: Uint8Array): Buffer {
  return wrapOpusPackets([opus]);
}

function wrapOpusPackets(packets: readonly Uint8Array[]): Buffer {
  if (packets.length === 0 || packets.some((packet) => packet.length === 0)) throw new Error("Opus packet batch is empty.");
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "ascii");
  head[8] = 1;
  head[9] = CHANNELS;
  head.writeUInt16LE(0, 10);
  head.writeUInt32LE(SAMPLE_RATE, 12);
  head.writeUInt16LE(0, 16);
  head[18] = 0;
  const tags = Buffer.concat([Buffer.from("OpusTags", "ascii"), Buffer.alloc(8)]);
  return Buffer.concat([
    oggPage(head, 0x43445642, 0, 0n, 2),
    oggPage(tags, 0x43445642, 1, 0n, 0),
    ...packets.map((packet, index) => oggPage(packet, 0x43445642, index + 2, BigInt((index + 1) * 960), index + 1 === packets.length ? 4 : 0)),
  ]);
}

function extractOpusPackets(ogg: Uint8Array): Uint8Array[] {
  const bytes = Buffer.from(ogg);
  const packets: Uint8Array[] = [];
  let offset = 0;
  let pending: Buffer[] = [];
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || bytes.toString("ascii", offset, offset + 4) !== "OggS") throw new Error("ffmpeg returned malformed Ogg Opus output.");
    const segments = bytes[offset + 26]!;
    if (offset + 27 + segments > bytes.length) throw new Error("ffmpeg returned a truncated Ogg segment table.");
    const table = bytes.subarray(offset + 27, offset + 27 + segments);
    let bodyOffset = offset + 27 + segments;
    for (const length of table) {
      if (bodyOffset + length > bytes.length) throw new Error("ffmpeg returned a truncated Ogg packet.");
      pending.push(bytes.subarray(bodyOffset, bodyOffset + length));
      bodyOffset += length;
      if (length < 255) {
        const packet = Buffer.concat(pending);
        pending = [];
        if (!packet.subarray(0, 8).equals(Buffer.from("OpusHead")) && !packet.subarray(0, 8).equals(Buffer.from("OpusTags"))) packets.push(Uint8Array.from(packet));
      }
    }
    offset = bodyOffset;
  }
  if (pending.length !== 0 || packets.length === 0) throw new Error("ffmpeg produced no complete Opus audio packet.");
  return packets;
}

function runFfmpeg(executable: string, args: string[], input: Uint8Array): Buffer {
  const result = spawnSync(executable, args, { input: Buffer.from(input), maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0 || !result.stdout || result.stdout.length === 0) throw new Error("The isolated ffmpeg Opus codec failed closed.");
  return result.stdout;
}

function runFfmpegAsync(executable: string, args: string[], input: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    let length = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 4 * 1024 * 1024) { child.kill(); reject(new Error("The isolated ffmpeg Opus codec exceeded its output bound.")); return; }
      chunks.push(chunk);
    });
    child.once("error", () => reject(new Error("The isolated ffmpeg Opus codec failed closed.")));
    child.once("exit", (code) => {
      const output = Buffer.concat(chunks);
      if (code !== 0 || output.length === 0) reject(new Error("The isolated ffmpeg Opus codec failed closed."));
      else resolve(output);
    });
    child.stdin.end(Buffer.from(input));
  });
}

export class FfmpegOpusCodec implements OpusCodec {
  readonly #executable: string;
  constructor(executable = process.env.FFMPEG_PATH ?? "ffmpeg") { this.#executable = executable; }

  decode(opus: Uint8Array): PcmAudioFrame {
    if (!(opus instanceof Uint8Array) || opus.length === 0) throw new Error("Opus input frame is empty.");
    const pcm = runFfmpeg(this.#executable, ["-hide_banner", "-loglevel", "error", "-f", "ogg", "-i", "pipe:0", "-f", "s16le", "-acodec", "pcm_s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "pipe:1"], wrapOpusPacket(opus));
    if (pcm.length % 2 !== 0 || pcm.length === 0 || pcm.length / 2 > MAX_FRAME_SAMPLES) throw new Error("Decoded PCM frame is invalid or unbounded.");
    return Object.freeze({ samples: new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)), sampleRate: SAMPLE_RATE, channels: CHANNELS });
  }

  async decodeAsync(opus: Uint8Array): Promise<PcmAudioFrame> {
    if (!(opus instanceof Uint8Array) || opus.length === 0) throw new Error("Opus input frame is empty.");
    const pcm = await runFfmpegAsync(this.#executable, ["-hide_banner", "-loglevel", "error", "-f", "ogg", "-i", "pipe:0", "-f", "s16le", "-acodec", "pcm_s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "pipe:1"], wrapOpusPacket(opus));
    if (pcm.length % 2 !== 0 || pcm.length === 0 || pcm.length / 2 > MAX_FRAME_SAMPLES) throw new Error("Decoded PCM frame is invalid or unbounded.");
    return Object.freeze({ samples: new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)), sampleRate: SAMPLE_RATE, channels: CHANNELS });
  }

  async decodeBatchAsync(opusPackets: readonly Uint8Array[]): Promise<PcmAudioFrame> {
    if (opusPackets.length === 0 || opusPackets.length > 50) throw new Error("Opus decode batch must contain 1 through 50 packets.");
    const pcm = await runFfmpegAsync(this.#executable, ["-hide_banner", "-loglevel", "error", "-f", "ogg", "-i", "pipe:0", "-f", "s16le", "-acodec", "pcm_s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "pipe:1"], wrapOpusPackets(opusPackets));
    if (pcm.length % 2 !== 0 || pcm.length === 0 || pcm.length / 2 > MAX_DECODED_SAMPLES) throw new Error("Decoded PCM batch is invalid or unbounded.");
    return Object.freeze({ samples: new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)), sampleRate: SAMPLE_RATE, channels: CHANNELS });
  }

  encode(frame: PcmAudioFrame): Uint8Array {
    if (frame.sampleRate !== SAMPLE_RATE || frame.channels !== CHANNELS || !(frame.samples instanceof Int16Array) || frame.samples.length === 0 || frame.samples.length > MAX_FRAME_SAMPLES) {
      throw new Error("PCM response must be bounded 48 kHz stereo signed-16 audio.");
    }
    const pcm = Buffer.from(frame.samples.buffer, frame.samples.byteOffset, frame.samples.byteLength);
    const ogg = runFfmpeg(this.#executable, ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-i", "pipe:0", "-c:a", "libopus", "-application", "voip", "-frame_duration", "20", "-f", "opus", "pipe:1"], pcm);
    return extractOpusPackets(ogg)[0]!;
  }
}
