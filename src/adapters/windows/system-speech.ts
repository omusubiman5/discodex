import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type SpeechEvent = "transcript" | "utterance_end" | "error" | "open" | "close";
export type WindowsSpeechStage = "speech-detected" | "utterance-recognized" | "recognition-empty" | "recognition-failed";

function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function pcmFromWav(value: Buffer): Buffer {
  for (let offset = 12; offset + 8 <= value.length;) {
    const id = value.toString("ascii", offset, offset + 4);
    const size = value.readUInt32LE(offset + 4);
    if (id === "data") return value.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error("Windows speech synthesis returned no PCM data.");
}

function runPowerShell(script: string, args: readonly string[], input?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", resolve(script), ...args], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.resume();
    const abort = (): void => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Windows speech operation was interrupted."));
      else if (code !== 0) reject(new Error("Windows speech operation failed."));
      else resolveRun(Buffer.concat(output).toString("utf8"));
    });
    child.stdin.end(input ?? "");
  });
}

export class WindowsSystemSpeechStt extends EventEmitter {
  readonly #sampleRate: number;
  readonly #culture: string;
  readonly #frames: Buffer[] = [];
  readonly #onStage: (stage: WindowsSpeechStage) => void;
  #active = false;
  #silentSamples = 0;
  #closed = false;
  #recognition = Promise.resolve();

  constructor(options: { sampleRate?: number; culture?: string; onStage?: (stage: WindowsSpeechStage) => void } = {}) {
    super();
    this.#sampleRate = options.sampleRate ?? 16_000;
    this.#culture = options.culture ?? "ja-JP";
    this.#onStage = options.onStage ?? (() => undefined);
    queueMicrotask(() => this.emit("open"));
  }

  send(buffer: Buffer): void {
    if (this.#closed || buffer.length < 2) return;
    const samples = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    const speech = peak >= 220;
    if (speech) {
      if (!this.#active) this.#onStage("speech-detected");
      this.#active = true;
      this.#silentSamples = 0;
      this.#frames.push(Buffer.from(buffer));
      return;
    }
    if (!this.#active) return;
    this.#frames.push(Buffer.from(buffer));
    this.#silentSamples += samples.length;
    if (this.#silentSamples < Math.floor(this.#sampleRate * 0.8)) return;
    const utterance = Buffer.concat(this.#frames.splice(0));
    this.#active = false;
    this.#silentSamples = 0;
    this.#recognition = this.#recognition.then(() => this.#recognize(utterance)).catch((error) => {
      this.#onStage("recognition-failed");
      this.emit("error", error);
    });
  }

  async #recognize(pcm: Buffer): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "codex-meetmate-stt-"));
    const path = join(root, "input.wav");
    try {
      await writeFile(path, wav(pcm, this.#sampleRate), { flag: "wx" });
      const text = (await runPowerShell("scripts/windows-system-speech-recognize.ps1", ["-WavePath", path, "-Culture", this.#culture])).trim();
      if (!text) { this.#onStage("recognition-empty"); return; }
      this.#onStage("utterance-recognized");
      this.emit("transcript", text, true, 1);
      this.emit("utterance_end", text);
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  close(): void { this.#closed = true; this.#frames.length = 0; this.emit("close"); }
  on(event: SpeechEvent, listener: (...args: any[]) => void): this { return super.on(event, listener); }
}

export async function synthesizeWithWindowsSystemSpeech(text: string, options: {
  sampleRate?: number;
  signal?: AbortSignal;
  onAudio?: (chunk: Buffer) => void;
} = {}): Promise<void> {
  if (!text.trim() || options.signal?.aborted) return;
  const sampleRate = options.sampleRate ?? 24_000;
  const root = await mkdtemp(join(tmpdir(), "codex-meetmate-tts-"));
  const path = join(root, "output.wav");
  try {
    await runPowerShell("scripts/windows-system-speech-synthesize.ps1", ["-WavePath", path, "-SampleRate", String(sampleRate)], text, options.signal);
    if (options.signal?.aborted) return;
    options.onAudio?.(pcmFromWav(await readFile(path)));
  } finally { await rm(root, { recursive: true, force: true }); }
}
