import assert from "node:assert/strict";
import test from "node:test";
import { WindowsSystemSpeechStt, synthesizeWithWindowsSystemSpeech } from "../src/adapters/windows/system-speech.ts";

test("Windows System.Speech preserves Japanese UTF-8 across TTS and STT", { skip: process.platform !== "win32" }, async () => {
  const expected = "電子書籍ソフト";
  const audio: Buffer[] = [];
  await synthesizeWithWindowsSystemSpeech(expected, {
    sampleRate: 16_000,
    onAudio: (chunk) => audio.push(chunk),
  });

  const stt = new WindowsSystemSpeechStt({ sampleRate: 16_000, culture: "ja-JP" });
  const recognized = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Windows speech recognition timed out.")), 15_000);
    stt.on("utterance_end", (text: string) => { clearTimeout(timeout); resolve(text); });
    stt.on("error", (error: Error) => { clearTimeout(timeout); reject(error); });
  });
  stt.send(Buffer.concat(audio));
  stt.send(Buffer.alloc(16_000 * 2));
  assert.equal(await recognized, expected);
  stt.close();
});
