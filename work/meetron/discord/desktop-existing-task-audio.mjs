import { assertDirectPcm } from "./direct-audio-bridge.mjs";

/**
 * Discord input still renders to the isolated per-call VB-CABLE route, while
 * Codex output comes directly from the existing WebRTC receiver track.
 */
export class DesktopExistingTaskAudio {
  #input;
  #transport;
  #threadId;
  #handlers = new Set();
  #unsubscribe;
  #state = "idle";

  constructor({ input, transport, threadId }) {
    if (!input || !transport || !/^[0-9a-f-]{20,}$/i.test(threadId || "")) throw new Error("Exact existing-task direct audio dependencies are required.");
    this.#input = input;
    this.#transport = transport;
    this.#threadId = threadId;
  }

  async start() {
    if (this.#state === "active") return;
    if (this.#state === "closed") throw new Error("Desktop existing-task audio is closed.");
    await this.#input.start();
    this.#unsubscribe = this.#transport.subscribe((notification) => {
      if (notification.method !== "thread/realtime/outputAudio/delta") return;
      const params = notification.params;
      const audio = params?.audio;
      if (params?.threadId !== this.#threadId || audio?.source !== "existing-webrtc-receiver"
        || audio.sampleRate !== 48_000 || audio.numChannels !== 2 || typeof audio.data !== "string") return;
      const bytes = Buffer.from(audio.data, "base64");
      if (bytes.length === 0 || bytes.length % 2 !== 0) return;
      const samples = new Int16Array(bytes.length / 2);
      for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2);
      const frame = { sampleRate: 48_000, channels: 2, samples };
      assertDirectPcm(frame);
      for (const handler of this.#handlers) handler(frame);
    });
    try {
      await this.#transport.attachExistingRealtimeOutput();
    } catch (error) {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      await this.#input.close().catch(() => undefined);
      throw error;
    }
    this.#state = "active";
  }

  onOutput(handler) {
    if (typeof handler !== "function") throw new Error("Output handler must be callable.");
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async writeInput(frame) {
    if (this.#state !== "active") throw new Error("Desktop existing-task audio is not active.");
    assertDirectPcm(frame);
    await this.#input.writeInput(frame);
  }

  async close() {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#handlers.clear();
    await this.#transport.detachExistingRealtimeOutput().catch(() => undefined);
    await this.#input.close();
  }
}
