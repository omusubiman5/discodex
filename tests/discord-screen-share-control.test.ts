import assert from "node:assert/strict";
import test from "node:test";
import {
  discordScreenSharePrompt,
  runDiscordScreenShareAction,
  type FixedTaskPromptRunner,
} from "../src/core/discord-screen-share-control.ts";

class FakeRunner implements FixedTaskPromptRunner {
  readonly prompts: string[] = [];
  readonly chunks: readonly string[];
  constructor(chunks: readonly string[]) { this.chunks = chunks; }
  async *streamChat(messages: readonly { readonly role: "user"; readonly content: string }[]): AsyncGenerator<string> {
    this.prompts.push(messages[0]?.content ?? "");
    for (const chunk of this.chunks) yield chunk;
  }
}

test("screen-share start is a fixed official-Discord UI operation", async () => {
  const runner = new FakeRunner(["done\nDISCODEX_SCREEN_SHARE_STARTED"]);
  assert.deepEqual(await runDiscordScreenShareAction("start", runner), { ok: true, action: "start", status: "confirmed" });
  assert.match(runner.prompts[0]!, /公式Discordデスクトップ/);
  assert.match(runner.prompts[0]!, /Go Live/);
  assert.match(runner.prompts[0]!, /現在のCodex作業画面を一つだけ/);
  assert.match(runner.prompts[0]!, /非公開API、コード変更、設定変更は行わない/);
});

test("screen-share stop preserves voice and requires a confirmed UI state", async () => {
  const runner = new FakeRunner(["DISCODEX_SCREEN_SHARE_BLOCKED"]);
  assert.deepEqual(await runDiscordScreenShareAction("stop", runner), { ok: false, action: "stop", status: "blocked" });
  const prompt = discordScreenSharePrompt("stop");
  assert.match(prompt, /画面共有だけ/);
  assert.match(prompt, /音声接続、Discodex runner、Codex音声通話は停止しない/);
});

test("an unrelated Codex response cannot claim screen-share success", async () => {
  const runner = new FakeRunner(["画面共有を開始しました。"]);
  assert.deepEqual(await runDiscordScreenShareAction("start", runner), { ok: false, action: "start", status: "blocked" });
});
