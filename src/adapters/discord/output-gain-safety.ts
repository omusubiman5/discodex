import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const DEFAULT_OUTPUT_GAIN_LINEAR = 0.5;
export const MIN_OUTPUT_GAIN_LINEAR = 0.25;
export const MAX_OUTPUT_GAIN_LINEAR = 1;
const LIMIT = 32_767 * 10 ** (-1 / 20);
const RESPONSE_TARGET_RMS = 8_000;
const RESPONSE_TARGET_PEAK = 28_000;
const MAX_RESPONSE_NORMALIZATION_GAIN = 12;

export interface OutputQualityMetrics {
  readonly samplePeakDbfs: number;
  readonly truePeakDbtp: number;
  readonly clippedSampleCount: number;
  readonly rmsDbfs: number;
}

/**
 * Select one stable pre-gain for a complete response. This compensates for
 * quiet Codex/WebRTC sources without per-packet gain pumping; the caller must
 * retain the returned value until the speaking segment ends.
 */
export function calculateResponseNormalizationGain(samples: Int16Array): number {
  if (samples.length === 0) return 1;
  let peak = 0;
  let sum = 0;
  for (const sample of samples) {
    const absolute = Math.abs(sample);
    peak = Math.max(peak, absolute);
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples.length);
  if (rms === 0 || peak === 0) return 1;
  return Math.min(
    MAX_RESPONSE_NORMALIZATION_GAIN,
    Math.max(1, RESPONSE_TARGET_RMS / rms),
    RESPONSE_TARGET_PEAK / peak,
  );
}

export function applyResponseNormalization(samples: Int16Array, gain: number): Int16Array {
  const stableGain = Number.isFinite(gain) ? Math.min(MAX_RESPONSE_NORMALIZATION_GAIN, Math.max(1, gain)) : 1;
  return Int16Array.from(samples, (sample) => Math.max(-32_768, Math.min(32_767, Math.round(sample * stableGain))));
}

export function applyDiscordOutputGain(samples: Int16Array, gainLinear: number): { samples: Int16Array; metrics: OutputQualityMetrics } {
  const gain = Number.isFinite(gainLinear) ? Math.min(MAX_OUTPUT_GAIN_LINEAR, Math.max(MIN_OUTPUT_GAIN_LINEAR, gainLinear)) : DEFAULT_OUTPUT_GAIN_LINEAR;
  const output = new Int16Array(samples.length);
  let peak = 0; let sum = 0; let clipped = 0; let truePeak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i]! * gain;
    const limited = Math.max(-LIMIT, Math.min(LIMIT, value));
    output[i] = Math.round(limited);
    const abs = Math.abs(limited); peak = Math.max(peak, abs); sum += limited * limited;
    if (Math.abs(value) > 32_767) clipped += 1;
    if (i > 0) {
      const previous = samples[i - 1]! * gain;
      for (const fraction of [0.25, 0.5, 0.75]) truePeak = Math.max(truePeak, Math.abs(previous + (value - previous) * fraction));
    }
    truePeak = Math.max(truePeak, abs);
  }
  const db = (value: number) => value > 0 ? 20 * Math.log10(value / 32_767) : -Infinity;
  return { samples: output, metrics: { samplePeakDbfs: db(peak), truePeakDbtp: db(truePeak), clippedSampleCount: clipped, rmsDbfs: db(Math.sqrt(sum / Math.max(1, samples.length))) } };
}

export class DiscordOutputGainPersistence {
  readonly #path: string;
  readonly #scope: string;
  #degraded = false;
  constructor(path: string, guildId: string, channelId: string) {
    this.#path = path;
    this.#scope = createHash("sha256").update(`${guildId}:${channelId}`).digest("hex");
  }
  get degraded(): boolean { return this.#degraded; }
  load(): number {
    this.#degraded = false;
    if (!existsSync(this.#path)) return DEFAULT_OUTPUT_GAIN_LINEAR;
    try {
      const values = JSON.parse(readFileSync(this.#path, "utf8")) as Record<string, unknown>;
      const value = values[this.#scope];
      if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_OUTPUT_GAIN_LINEAR || value > MAX_OUTPUT_GAIN_LINEAR) throw new Error("invalid gain");
      return value;
    } catch { this.#degraded = true; return DEFAULT_OUTPUT_GAIN_LINEAR; }
  }
  save(value: number): void {
    if (!Number.isFinite(value) || value < MIN_OUTPUT_GAIN_LINEAR || value > MAX_OUTPUT_GAIN_LINEAR) throw new Error("Output gain is outside the approved linear range.");
    let values: Record<string, unknown> = {};
    try { if (existsSync(this.#path)) values = JSON.parse(readFileSync(this.#path, "utf8")); } catch { this.#degraded = true; }
    values[this.#scope] = value;
    writeFileSync(this.#path, JSON.stringify(values), "utf8");
    this.#degraded = false;
  }
}
