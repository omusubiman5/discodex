import assert from "node:assert/strict";
import test from "node:test";
import { CurrentCodexTaskLlmProvider } from "../src/core/codex-task-llm-provider.ts";
import type { CodexAppServerNotification, CodexAppServerRpcTransport } from "../src/core/codex-audio-route.ts";

const THREAD_ID = "REDACTED_CODEX_TASK_ID_1";

class MockTaskRpc implements CodexAppServerRpcTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly listeners = new Set<(notification: CodexAppServerNotification) => void>();
  completeBeforeResponse = false;
  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "turn/start") {
      if (this.completeBeforeResponse) {
        this.emit({ method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId: "turn-voice", delta: "early" } });
        this.emit({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: "turn-voice", status: "completed" } } });
      }
      return { turn: { id: "turn-voice", status: "inProgress" } };
    }
    return {};
  }
  subscribe(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(notification: CodexAppServerNotification): void {
    for (const listener of this.listeners) listener(notification);
  }
}

test("Meetmate provider streams one turn through the exact existing Codex task", async () => {
  const rpc = new MockTaskRpc();
  const stages: string[] = [];
  const provider = new CurrentCodexTaskLlmProvider({ threadId: THREAD_ID, transport: rpc, onStage: (stage) => stages.push(stage) });
  const chunks: string[] = [];
  const consume = (async () => {
    for await (const chunk of provider.streamChat([{ role: "user", content: "What did we decide?" }])) chunks.push(chunk);
  })();
  await new Promise((resolve) => setImmediate(resolve));
  rpc.emit({ method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId: "turn-other", delta: "wrong" } });
  rpc.emit({ method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId: "turn-voice", delta: "We decided" } });
  rpc.emit({ method: "item/agentMessage/delta", params: { threadId: THREAD_ID, turnId: "turn-voice", delta: " to ship." } });
  rpc.emit({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: "turn-voice", status: "completed" } } });
  await consume;
  assert.deepEqual(chunks, ["We decided", " to ship."]);
  assert.deepEqual(rpc.requests[0], {
    method: "turn/start",
    params: {
      threadId: THREAD_ID,
      input: [{ type: "text", text: "What did we decide?", text_elements: [] }],
      responsesapiClientMetadata: { source: "meetmate-discord-voice" },
    },
  });
  assert.equal(rpc.listeners.size, 0);
  assert.deepEqual(stages, ["turn-submitting", "turn-started", "first-delta", "turn-completed"]);
});

test("current-task provider retains deltas and completion that race the turn/start response", async () => {
  const rpc = new MockTaskRpc();
  rpc.completeBeforeResponse = true;
  const provider = new CurrentCodexTaskLlmProvider({ threadId: THREAD_ID, transport: rpc });
  const chunks: string[] = [];
  for await (const chunk of provider.streamChat([{ role: "user", content: "race" }])) chunks.push(chunk);
  assert.deepEqual(chunks, ["early"]);
});

test("Meetmate barge-in interrupts only its active current-task turn", async () => {
  const rpc = new MockTaskRpc();
  const controller = new AbortController();
  const stages: string[] = [];
  const provider = new CurrentCodexTaskLlmProvider({ threadId: THREAD_ID, transport: rpc, onStage: (stage) => stages.push(stage) });
  const consume = (async () => {
    for await (const _chunk of provider.streamChat([{ role: "user", content: "Start answering" }], { signal: controller.signal })) { /* no-op */ }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(consume, /interrupted/);
  assert.deepEqual(rpc.requests.at(-1), { method: "turn/interrupt", params: { threadId: THREAD_ID, turnId: "turn-voice" } });
  assert.equal(rpc.requests.filter((request) => request.method === "turn/interrupt").length, 1);
  assert.deepEqual(stages, ["turn-submitting", "turn-started", "turn-interrupted"]);
});

test("current-task provider reports a content-free failure stage when turn/start rejects", async () => {
  const stages: string[] = [];
  const rpc: CodexAppServerRpcTransport = {
    request: async () => { throw new Error("sensitive app-server detail"); },
    subscribe: () => () => undefined,
  };
  const provider = new CurrentCodexTaskLlmProvider({ threadId: THREAD_ID, transport: rpc, onStage: (stage) => stages.push(stage) });
  await assert.rejects(async () => {
    for await (const _chunk of provider.streamChat([{ role: "user", content: "voice input" }])) { /* no-op */ }
  }, /sensitive app-server detail/);
  assert.deepEqual(stages, ["turn-submitting", "turn-failed"]);
});

test("failed turn completion releases the provider for the next Meetmate turn", async () => {
  const rpc = new MockTaskRpc();
  const stages: string[] = [];
  const provider = new CurrentCodexTaskLlmProvider({ threadId: THREAD_ID, transport: rpc, onStage: (stage) => stages.push(stage) });
  const first = (async () => {
    for await (const _chunk of provider.streamChat([{ role: "user", content: "first" }])) { /* no-op */ }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  rpc.emit({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: "turn-voice", status: "failed", error: { message: "private detail" } } } });
  await assert.rejects(first, /voice turn failed/);
  const second = (async () => {
    for await (const _chunk of provider.streamChat([{ role: "user", content: "second" }])) { /* no-op */ }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  rpc.emit({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: "turn-voice", status: "completed" } } });
  await second;
  assert.deepEqual(stages, ["turn-submitting", "turn-started", "turn-failed", "turn-submitting", "turn-started", "turn-completed"]);
});
