import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultHost = resolve(moduleDirectory, "../../../native/macos/.build/release/discodex-coreaudio-host");

function assertPcm(frame) {
  if (frame?.sampleRate !== 48_000 || frame?.channels !== 2 || !(frame.samples instanceof Int16Array)
      || frame.samples.length === 0 || frame.samples.length > 96_000) {
    throw new Error("macOS Core Audio input must be bounded 48 kHz stereo signed-16 PCM.");
  }
}

function defaultProcessExists(processId) {
  try { process.kill(processId, 0); return true; } catch { return false; }
}

/** Renders Discord PCM only to one exact Core Audio virtual device. */
export class MacosExistingGptLiveAudio {
  #options;
  #child;
  #exitPromise;
  #state = "idle";

  constructor(options) {
    const processId = Number(options?.existingGptLiveProcessId);
    const deviceName = options?.virtualAudioDeviceName?.trim();
    if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error("A caller-supplied existing Codex process id is required.");
    if (!deviceName || deviceName.length > 128) throw new Error("An exact Core Audio virtual device name is required.");
    if (!/^[a-f0-9]{64}$/i.test(options?.expectedSessionIdentity || "")) throw new Error("The exact existing Codex session identity is required.");
    if (typeof options?.verifyExistingSession !== "function") throw new Error("An existing Codex session verifier is required.");
    this.#options = {
      platform: options.platform || process.platform,
      hostExecutable: options.hostExecutable || defaultHost,
      existingGptLiveProcessId: processId,
      virtualAudioDeviceName: deviceName,
      expectedSessionIdentity: options.expectedSessionIdentity.toLowerCase(),
      verifyExistingSession: options.verifyExistingSession,
      processExists: options.processExists || defaultProcessExists,
      executableExists: options.executableExists || existsSync,
      spawnHost: options.spawnHost || ((executable, args) => spawn(executable, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] })),
      startupTimeoutMs: options.startupTimeoutMs ?? 3_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 2_000,
    };
    if (!Number.isSafeInteger(this.#options.shutdownTimeoutMs) || this.#options.shutdownTimeoutMs < 0 || this.#options.shutdownTimeoutMs > 5_000) {
      throw new Error("macOS Core Audio shutdown timeout is invalid.");
    }
    if (!Number.isSafeInteger(this.#options.startupTimeoutMs) || this.#options.startupTimeoutMs < 10 || this.#options.startupTimeoutMs > 10_000) {
      throw new Error("macOS Core Audio startup timeout is invalid.");
    }
  }

  async start() {
    if (this.#state === "active") return;
    if (this.#state === "closed") throw new Error("macOS Core Audio endpoint is closed.");
    if (this.#options.platform !== "darwin") throw new Error("macOS Core Audio requires darwin.");
    if (!this.#options.executableExists(this.#options.hostExecutable)) throw new Error(`macOS Core Audio host was not built: ${this.#options.hostExecutable}`);
    if (!this.#options.processExists(this.#options.existingGptLiveProcessId)) throw new Error("The caller-supplied existing Codex process is not running.");
    const verified = await this.#options.verifyExistingSession({
      existingGptLiveProcessId: this.#options.existingGptLiveProcessId,
      expectedSessionIdentity: this.#options.expectedSessionIdentity,
    });
    if (verified?.matches !== true || verified?.voiceActive !== true
        || verified?.processId !== this.#options.existingGptLiveProcessId
        || verified?.sessionIdentity?.toLowerCase() !== this.#options.expectedSessionIdentity) {
      throw new Error(`Existing Codex session verification failed: ${verified?.reason || "identity-or-voice-state"}.`);
    }
    this.#state = "starting";
    this.#child = this.#options.spawnHost(this.#options.hostExecutable, ["--device-name", this.#options.virtualAudioDeviceName]);
    let stderr = "";
    this.#child.stderr?.on("data", (chunk) => { if (stderr.length < 2048) stderr += Buffer.from(chunk).toString("utf8").slice(0, 2048 - stderr.length); });
    this.#exitPromise = new Promise((resolveFailure) => {
      this.#child.once("error", () => { if (this.#state !== "closed") this.#state = "failed"; resolveFailure("spawn"); });
      this.#child.once("exit", () => { if (this.#state !== "closed") this.#state = "failed"; resolveFailure(stderr.includes("device") ? "device" : "exit"); });
    });
    let readyOutput = "";
    const ready = new Promise((resolveReady) => this.#child.stdout.on("data", (chunk) => {
      if (readyOutput.length < 32) readyOutput += Buffer.from(chunk).toString("ascii").slice(0, 32 - readyOutput.length);
      if (readyOutput === "READY\n") resolveReady(null);
    }));
    const failure = await Promise.race([
      this.#exitPromise,
      ready,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("startup-timeout"), this.#options.startupTimeoutMs)),
    ]);
    if (failure) { this.#state = "failed"; this.#child.kill?.("SIGTERM"); throw new Error(`macOS Core Audio host failed during ${failure}.`); }
    this.#state = "active";
  }

  onOutput(handler) {
    if (typeof handler !== "function") throw new Error("Output handler must be callable.");
    return () => undefined;
  }

  async writeInput(frame) {
    if (this.#state !== "active") throw new Error("macOS Core Audio endpoint is not active.");
    assertPcm(frame);
    const bytes = Buffer.from(frame.samples.buffer, frame.samples.byteOffset, frame.samples.byteLength);
    if (!this.#child.stdin.write(bytes)) await new Promise((resolveDrain, rejectDrain) => {
      const cleanup = () => { this.#child.stdin.off("drain", onDrain); this.#child.off("exit", onExit); this.#child.off("error", onError); };
      const onDrain = () => { cleanup(); resolveDrain(); };
      const onExit = () => { cleanup(); rejectDrain(new Error("macOS Core Audio host exited while rendering.")); };
      const onError = () => { cleanup(); rejectDrain(new Error("macOS Core Audio host failed while rendering.")); };
      this.#child.stdin.once("drain", onDrain); this.#child.once("exit", onExit); this.#child.once("error", onError);
    });
  }

  async close() {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#child?.stdin.end();
    if (this.#child && this.#options.shutdownTimeoutMs > 0) {
      const exited = await Promise.race([
        this.#exitPromise.then(() => true),
        new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), this.#options.shutdownTimeoutMs)),
      ]);
      if (!exited) this.#child.kill("SIGTERM");
    }
  }

  get state() { return this.#state; }
}
