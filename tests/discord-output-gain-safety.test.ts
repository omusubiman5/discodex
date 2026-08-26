import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyDiscordOutputGain,
  applyResponseNormalization,
  calculateResponseNormalizationGain,
  DiscordOutputGainPersistence,
  DEFAULT_OUTPUT_GAIN_LINEAR,
} from "../src/adapters/discord/output-gain-safety.ts";

test("outbound PCM gain applies before encoding and stays below sample/true peak clipping", () => {
  const samples = Int16Array.from({ length: 4_800 }, (_, i) => Math.round(12_000 * Math.sin(i / 8)));
  for (const gain of [0.25, 0.5, 1]) {
    const result = applyDiscordOutputGain(samples, gain);
    assert.ok(result.metrics.samplePeakDbfs < -1);
    assert.ok(result.metrics.truePeakDbtp < -1);
    assert.equal(result.metrics.clippedSampleCount, 0);
  }
  const speech = applyDiscordOutputGain(Int16Array.from({ length: 4_800 }, (_, i) => Math.round(16_000 * Math.sin(i / 8))), 0.5);
  assert.ok(speech.metrics.rmsDbfs >= -30 && speech.metrics.rmsDbfs <= -12);
});

test("quiet Codex speech receives one bounded response gain before user gain and limiter", () => {
  const quiet = Int16Array.from({ length: 4_800 }, (_, index) => Math.round(1_100 * Math.sin(index / 8)));
  const responseGain = calculateResponseNormalizationGain(quiet);
  assert.ok(responseGain > 1 && responseGain <= 12);
  const normalized = applyResponseNormalization(quiet, responseGain);
  const output = applyDiscordOutputGain(normalized, 0.4);
  assert.ok(output.metrics.rmsDbfs >= -24);
  assert.ok(output.metrics.truePeakDbtp < -1);
  assert.equal(output.metrics.clippedSampleCount, 0);
});

test("already-loud Codex speech is not boosted", () => {
  const loud = Int16Array.from({ length: 4_800 }, (_, index) => Math.round(14_000 * Math.sin(index / 8)));
  assert.equal(calculateResponseNormalizationGain(loud), 1);
});

test("gain persistence is scoped, survives restart, and invalid data resets default with degraded marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdvb-gain-")); const path = join(dir, "gain.json");
  const first = new DiscordOutputGainPersistence(path, "guild-a", "channel-a"); first.save(0.75);
  const restarted = new DiscordOutputGainPersistence(path, "guild-a", "channel-a"); assert.equal(restarted.load(), 0.75);
  const otherScope = new DiscordOutputGainPersistence(path, "guild-b", "channel-a"); assert.equal(otherScope.load(), DEFAULT_OUTPUT_GAIN_LINEAR);
  writeFileSync(path, JSON.stringify({ bad: 99 })); const corrupt = new DiscordOutputGainPersistence(path, "guild-a", "channel-a"); assert.equal(corrupt.load(), DEFAULT_OUTPUT_GAIN_LINEAR); assert.equal(corrupt.degraded, true);
  corrupt.save(DEFAULT_OUTPUT_GAIN_LINEAR); assert.equal(corrupt.degraded, false); assert.equal(corrupt.load(), DEFAULT_OUTPUT_GAIN_LINEAR);
  assert.doesNotMatch(readFileSync(path, "utf8"), /guild-a|channel-a/); rmSync(dir, { recursive: true, force: true });
});
