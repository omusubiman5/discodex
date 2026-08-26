import type {
  CodexAppServerNotification,
  CodexAppServerRpcTransport,
} from "./codex-audio-route.ts";

interface CodexTurn {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly error?: { readonly message?: unknown } | null;
}

interface CodexTurnStartResponse {
  readonly turn?: CodexTurn;
}

interface StreamChatOptions {
  readonly signal?: AbortSignal;
}

interface ChatMessage {
  readonly role?: unknown;
  readonly content?: unknown;
}

export type CurrentCodexTaskStage = "turn-submitting" | "turn-started" | "first-delta" | "turn-completed" | "turn-failed" | "turn-interrupted";

function paramsOf(notification: CodexAppServerNotification): Record<string, unknown> | undefined {
  return notification.params && typeof notification.params === "object"
    ? notification.params as Record<string, unknown>
    : undefined;
}

function lastUserText(messages: readonly ChatMessage[]): string {
  const message = [...messages].reverse().find((candidate) => candidate.role === "user");
  if (typeof message?.content !== "string" || message.content.trim().length === 0) {
    throw new Error("Meetmate produced no user text for the current Codex task.");
  }
  return message.content;
}

class AsyncTextQueue implements AsyncIterable<string> {
  readonly #values: string[] = [];
  readonly #waiters: Array<{ resolve: (value: IteratorResult<string>) => void; reject: (error: Error) => void }> = [];
  #closed = false;
  #error?: Error;

  push(value: string): void {
    if (this.#closed || value.length === 0) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async (): Promise<IteratorResult<string>> => {
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#error) throw this.#error;
        if (this.#closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<string>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

/**
 * Meetmate LLM provider backed by one already-owned Codex Desktop task.
 * Meetmate retains STT, turn/barge-in, delegation, and TTS ownership; this
 * provider only submits the recognized utterance to the exact current task.
 */
export class CurrentCodexTaskLlmProvider {
  readonly name = "codex-current-task";
  readonly managesHistory = true;
  readonly #threadId: string;
  readonly #transport: CodexAppServerRpcTransport;
  readonly #onStage: (stage: CurrentCodexTaskStage) => void;
  #active = false;

  constructor(options: {
    readonly threadId: string;
    readonly transport: CodexAppServerRpcTransport;
    readonly onStage?: (stage: CurrentCodexTaskStage) => void;
  }) {
    if (!/^[0-9a-f-]{20,}$/i.test(options.threadId)) throw new Error("A concrete current Codex task ID is required.");
    this.#threadId = options.threadId;
    this.#transport = options.transport;
    this.#onStage = options.onStage ?? (() => undefined);
  }

  async *streamChat(messages: readonly ChatMessage[], options: StreamChatOptions = {}): AsyncGenerator<string> {
    if (this.#active) throw new Error("The current Codex task already has an active Meetmate voice turn.");
    if (options.signal?.aborted) throw new Error("Meetmate voice turn was cancelled before Codex submission.");
    this.#active = true;
    const queue = new AsyncTextQueue();
    const pending: Array<{ readonly turnId: string; readonly delta: string }> = [];
    const pendingCompletions: CodexTurn[] = [];
    let turnId: string | undefined;
    let completed = false;
    let interruptRequested = false;
    let firstDeltaObserved = false;
    let failureObserved = false;

    const reportFailure = (): void => {
      if (failureObserved) return;
      failureObserved = true;
      this.#onStage("turn-failed");
    };

    const pushDelta = (delta: string): void => {
      if (!firstDeltaObserved && delta.length > 0) {
        firstDeltaObserved = true;
        this.#onStage("first-delta");
      }
      queue.push(delta);
    };

    const completeTurn = (turn: CodexTurn): void => {
      completed = true;
      if (turn.status === "failed") {
        reportFailure();
        const detail = typeof turn.error?.message === "string" ? `: ${turn.error.message}` : "";
        queue.fail(new Error(`The current Codex task voice turn failed${detail}`));
      } else {
        this.#onStage("turn-completed");
        queue.close();
      }
    };

    const unsubscribe = this.#transport.subscribe((notification) => {
      const params = paramsOf(notification);
      if (!params || params.threadId !== this.#threadId) return;
      if (notification.method === "item/agentMessage/delta") {
        const notificationTurnId = params.turnId;
        const delta = params.delta;
        if (typeof notificationTurnId !== "string" || typeof delta !== "string") return;
        if (!turnId) pending.push({ turnId: notificationTurnId, delta });
        else if (notificationTurnId === turnId) pushDelta(delta);
        return;
      }
      if (notification.method !== "turn/completed") return;
      const turn = params.turn as CodexTurn | undefined;
      if (typeof turn?.id !== "string") return;
      if (!turnId) pendingCompletions.push(turn);
      else if (turn.id === turnId) completeTurn(turn);
    });

    const abort = (): void => {
      if (!turnId || completed || interruptRequested) return;
      interruptRequested = true;
      this.#onStage("turn-interrupted");
      void this.#transport.request("turn/interrupt", { threadId: this.#threadId, turnId }).catch(() => undefined);
      queue.fail(new Error("Meetmate interrupted the current Codex task voice turn."));
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      this.#onStage("turn-submitting");
      const response = await this.#transport.request("turn/start", {
        threadId: this.#threadId,
        input: [{ type: "text", text: lastUserText(messages), text_elements: [] }],
        responsesapiClientMetadata: { source: "meetmate-discord-voice" },
      }) as CodexTurnStartResponse;
      if (typeof response.turn?.id !== "string" || response.turn.id.length === 0) {
        throw new Error("Codex app-server did not return a voice turn ID.");
      }
      turnId = response.turn.id;
      this.#onStage("turn-started");
      for (const item of pending) if (item.turnId === turnId) pushDelta(item.delta);
      pending.length = 0;
      const earlyCompletion = pendingCompletions.find((turn) => turn.id === turnId);
      if (earlyCompletion) completeTurn(earlyCompletion);
      pendingCompletions.length = 0;
      if (options.signal?.aborted) abort();
      for await (const chunk of queue) yield chunk;
    } catch (error) {
      if (!interruptRequested) reportFailure();
      throw error;
    } finally {
      if (!completed && !interruptRequested && turnId) {
        interruptRequested = true;
        this.#onStage("turn-interrupted");
        await this.#transport.request("turn/interrupt", { threadId: this.#threadId, turnId }).catch(() => undefined);
      }
      options.signal?.removeEventListener("abort", abort);
      unsubscribe();
      this.#active = false;
    }
  }
}
