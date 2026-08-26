import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("product package pins the reviewed Meetmate source and retains its notice", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(
    pkg.dependencies?.meetmate,
    "github:caty-ai/meetmate#939a627d0d781ecb4ca4fc291eef0e9e456d59c5",
  );
  const notice = await readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  assert.match(notice, /Copyright \(c\) 2026 Shoji Kumaru/);
  assert.match(notice, /MIT License/);
});

test("Discord transport imports upstream pipeline instead of duplicating STT/agent/TTS", async () => {
  const source = await readFile(new URL("../src/transport-discord/meetmate-discord-transport.ts", import.meta.url), "utf8");
  assert.match(source, /meetmate\/src\/pipeline\.js/);
  assert.doesNotMatch(source, /class .*STT|function\s+\w*synthesi|async function\*?\s+streamChat/i);
});

test("reviewed Meetmate core exposes only the injected current-agent provider seam", async () => {
  const source = await readFile(new URL("../node_modules/meetmate/src/pipeline.js", import.meta.url), "utf8");
  assert.match(source, /options\.llmProvider \|\| createLlmProvider/);
  assert.match(source, /providerManagesHistory/);
  assert.match(source, /createSTT/);
  assert.match(source, /speakSentence/);
});
