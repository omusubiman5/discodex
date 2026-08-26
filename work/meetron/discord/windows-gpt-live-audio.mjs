import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDirectPcm } from "./direct-audio-bridge.mjs";

const MINIMUM_PROCESS_LOOPBACK_BUILD = 20_348;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultHost = resolve(
  moduleDirectory,
  "../native/windows-audio/out/Release/meetron-windows-audio-host.exe",
);

export function windowsBuildNumber(value = release()) {
  const build = Number.parseInt(value.split(".")[2] || "0", 10);
  return Number.isSafeInteger(build) ? build : 0;
}

export function int16ToFloat32Buffer(samples) {
  const result = Buffer.allocUnsafe(samples.length * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < samples.length; index += 1) {
    const divisor = samples[index] < 0 ? 32_768 : 32_767;
    result.writeFloatLE(samples[index] / divisor, index * 4);
  }
  return result;
}

export function float32BufferToInt16(buffer) {
  if (buffer.length % 4 !== 0) throw new Error("Windows audio host emitted a partial float sample.");
  const samples = new Int16Array(buffer.length / 4);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, buffer.readFloatLE(index * 4)));
    samples[index] = value < 0 ? Math.round(value * 32_768) : Math.round(value * 32_767);
  }
  return samples;
}

function defaultProcessExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Meetron voice endpoint for one caller-supplied, already-running GPT Live
 * browser process. This class never launches or navigates a browser.
 */
export class WindowsExistingGptLiveAudio {
  #options;
  #child;
  #outputHandlers = new Set();
  #remainder = Buffer.alloc(0);
  #state = "idle";
  #hostFailure = "host-exit";

  constructor(options) {
    const processId = Number(options?.existingGptLiveProcessId);
    if (!Number.isSafeInteger(processId) || processId <= 0) {
      throw new Error("A caller-supplied existing GPT Live process id is required.");
    }
    if (!options?.virtualCableRenderEndpointId?.trim()) {
      throw new Error("The isolated virtual-cable render endpoint id is required.");
    }
    if (!/^[a-f0-9]{64}$/i.test(options?.expectedSessionIdentity || "")) {
      throw new Error("The exact existing GPT Live session identity is required.");
    }
    if (typeof options?.verifyExistingSession !== "function") {
      throw new Error("An existing GPT Live session verifier is required.");
    }
    this.#options = {
      hostExecutable: options.hostExecutable || defaultHost,
      existingGptLiveProcessId: processId,
      virtualCableRenderEndpointId: options.virtualCableRenderEndpointId,
      expectedSessionIdentity: options.expectedSessionIdentity.toLowerCase(),
      verifyExistingSession: options.verifyExistingSession,
      platform: options.platform || process.platform,
      osRelease: options.osRelease || release(),
      processExists: options.processExists || defaultProcessExists,
      spawnHost: options.spawnHost || ((executable, args) => spawn(executable, args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })),
      executableExists: options.executableExists || existsSync,
      startupSettleMs: options.startupSettleMs ?? 250,
    };
    if (!Number.isSafeInteger(this.#options.startupSettleMs) || this.#options.startupSettleMs < 0 || this.#options.startupSettleMs > 2_000) {
      throw new Error("Windows audio host startup settle time is invalid.");
    }
  }

  #classifyHostFailure(stderr, code) {
    if (stderr.includes("render route failed")) return "render-route";
    if (stderr.includes("process-loopback route failed")) return "process-loopback-route";
    if (code === 64) return "host-arguments";
    if (code === 65) return "capture-self";
    if (code === 68) return "capture-output";
    return "host-exit";
  }

  async start() {
    if (this.#state === "active") return;
    if (this.#state === "closed") throw new Error("Windows GPT Live audio endpoint is closed.");
    if (this.#options.platform !== "win32") throw new Error("Windows GPT Live audio requires win32.");
    if (windowsBuildNumber(this.#options.osRelease) < MINIMUM_PROCESS_LOOPBACK_BUILD) {
      throw new Error(`Windows build ${MINIMUM_PROCESS_LOOPBACK_BUILD} or later is required.`);
    }
    if (!this.#options.executableExists(this.#options.hostExecutable)) {
      throw new Error(`Windows audio host was not built: ${this.#options.hostExecutable}`);
    }
    if (!this.#options.processExists(this.#options.existingGptLiveProcessId)) {
      throw new Error("The caller-supplied existing GPT Live process is not running.");
    }
    const verified = await this.#options.verifyExistingSession({
      existingGptLiveProcessId: this.#options.existingGptLiveProcessId,
      expectedSessionIdentity: this.#options.expectedSessionIdentity,
    });
    if (
      verified?.matches !== true ||
      verified?.voiceActive !== true ||
      verified?.processId !== this.#options.existingGptLiveProcessId ||
      verified?.sessionIdentity?.toLowerCase() !== this.#options.expectedSessionIdentity
    ) {
      throw new Error(`Existing GPT Live session verification failed: ${verified?.reason || "identity-or-voice-state"}.`);
    }
    this.#state = "starting";
    this.#child = this.#options.spawnHost(this.#options.hostExecutable, [
      "--render-endpoint",
      this.#options.virtualCableRenderEndpointId,
      "--capture-process",
      String(this.#options.existingGptLiveProcessId),
    ]);
    let stderr = "";
    this.#child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4_096) stderr += Buffer.from(chunk).toString("utf8").slice(0, 4_096 - stderr.length);
    });
    this.#child.stdout.on("data", (chunk) => this.#acceptOutput(chunk));
    const earlyFailure = new Promise((resolveFailure) => {
      this.#child.once("error", () => {
        this.#hostFailure = "host-spawn";
        this.#state = "failed";
        resolveFailure(this.#hostFailure);
      });
      this.#child.once("exit", (code) => {
        this.#hostFailure = this.#classifyHostFailure(stderr, code);
        if (this.#state !== "closed") this.#state = "failed";
        resolveFailure(this.#hostFailure);
      });
    });
    const failure = await Promise.race([
      earlyFailure,
      new Promise((resolveReady) => setTimeout(() => resolveReady(null), this.#options.startupSettleMs)),
    ]);
    if (failure) throw new Error(`Windows audio host failed during ${failure}.`);
    this.#state = "active";
  }

  #acceptOutput(chunk) {
    const combined = this.#remainder.length ? Buffer.concat([this.#remainder, chunk]) : chunk;
    const completeBytes = combined.length - (combined.length % 8); // stereo float32 frame
    this.#remainder = combined.subarray(completeBytes);
    if (completeBytes === 0) return;
    const frame = {
      sampleRate: 48_000,
      channels: 2,
      samples: float32BufferToInt16(combined.subarray(0, completeBytes)),
    };
    for (const handler of this.#outputHandlers) handler(frame);
  }

  onOutput(handler) {
    if (typeof handler !== "function") throw new Error("Output handler must be callable.");
    this.#outputHandlers.add(handler);
    return () => this.#outputHandlers.delete(handler);
  }

  async writeInput(frame) {
    if (this.#state !== "active") throw new Error("Windows GPT Live audio is not active.");
    assertDirectPcm(frame);
    const writable = this.#child.stdin.write(int16ToFloat32Buffer(frame.samples));
    if (!writable) {
      await new Promise((resolveDrain, rejectDrain) => {
        const cleanup = () => {
          this.#child.stdin.off("drain", onDrain);
          this.#child.off("exit", onExit);
          this.#child.off("error", onError);
        };
        const onDrain = () => { cleanup(); resolveDrain(); };
        const onExit = () => { cleanup(); rejectDrain(new Error(`Windows audio host failed during ${this.#hostFailure}.`)); };
        const onError = () => { cleanup(); rejectDrain(new Error("Windows audio host failed during host-spawn.")); };
        this.#child.stdin.once("drain", onDrain);
        this.#child.once("exit", onExit);
        this.#child.once("error", onError);
      });
    }
  }

  async close() {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#child?.stdin.end();
    this.#outputHandlers.clear();
  }

  get state() {
    return this.#state;
  }
}
