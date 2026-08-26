const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const MAX_SAMPLES = SAMPLE_RATE * CHANNELS;

export function assertDirectPcm(frame) {
  if (
    frame?.sampleRate !== SAMPLE_RATE ||
    frame?.channels !== CHANNELS ||
    !(frame?.samples instanceof Int16Array) ||
    frame.samples.length === 0 ||
    frame.samples.length > MAX_SAMPLES
  ) {
    throw new Error("Meetron direct audio must be bounded 48 kHz stereo signed-16 PCM.");
  }
}

/**
 * Cross-transport form of Meetron's two isolated audio devices:
 * conferencing audio -> ChatGPT Web Voice microphone, and ChatGPT Web Voice
 * output -> conferencing microphone. Frames remain audio for the whole route.
 */
export class MeetronDirectAudioBridge {
  #voice;
  #onStage;
  #conferenceSink = () => undefined;
  #unsubscribeOutput;
  #state = "idle";

  constructor({ voice, onStage }) {
    if (!voice) throw new Error("A ChatGPT Web Voice audio endpoint is required.");
    this.#voice = voice;
    this.#onStage = onStage;
  }

  async start() {
    if (this.#state === "closed") throw new Error("Meetron direct audio bridge is closed.");
    if (this.#state === "active") return;
    await this.#voice.start();
    this.#unsubscribeOutput = this.#voice.onOutput(async (frame) => {
      assertDirectPcm(frame);
      this.#onStage?.("chatgpt-audio-to-conference");
      await this.#conferenceSink(frame);
    });
    this.#state = "active";
    this.#onStage?.("chatgpt-voice-connected");
  }

  async sendConferencePcm(frame) {
    if (this.#state !== "active") throw new Error("Meetron ChatGPT Web Voice audio is not active.");
    assertDirectPcm(frame);
    await this.#voice.writeInput(frame);
    this.#onStage?.("conference-audio-to-chatgpt");
  }

  setConferencePcmSink(sink) {
    if (typeof sink !== "function") throw new Error("Meetron conference PCM sink must be callable.");
    this.#conferenceSink = sink;
  }

  async close() {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#unsubscribeOutput?.();
    this.#unsubscribeOutput = undefined;
    await this.#voice.close();
  }

  get state() {
    return this.#state;
  }
}
