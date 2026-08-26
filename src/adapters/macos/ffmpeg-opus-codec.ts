import { FfmpegOpusCodec, type OpusCodec, type PcmAudioFrame } from "../windows/ffmpeg-opus-codec.ts";

/**
 * macOS process boundary for the cross-platform ffmpeg Opus codec. The class is
 * intentionally separate so setup, executable discovery, signing, and future
 * AudioToolbox replacement remain OS-scoped without changing the media core.
 */
export class MacosFfmpegOpusCodec extends FfmpegOpusCodec implements OpusCodec {
  constructor(executable = process.env.FFMPEG_PATH ?? "ffmpeg") { super(executable); }
}

export type { OpusCodec, PcmAudioFrame };
