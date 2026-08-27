import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CurrentCodexTaskTextProvider } from "../src/core/current-codex-task-text-provider.ts";
import { DesktopOwnedCodexAppServerTransport } from "../src/core/codex-app-server-rpc.ts";
import { runDiscordScreenShareAction } from "../src/core/discord-screen-share-control.ts";

const action = process.argv[2];
if (action !== "start" && action !== "stop") {
  process.stderr.write("A fixed screen-share action (start or stop) is required.\n");
  process.exit(2);
}

const taskFile = resolve("runtime/discodex-relay.thread-id");
const threadId = readFileSync(taskFile, "utf8").trim();
if (!/^[0-9a-f-]{20,}$/i.test(threadId)) {
  process.stderr.write("The fixed Codex task identity is unavailable.\n");
  process.exit(2);
}

const transport = new DesktopOwnedCodexAppServerTransport({ threadId });
const timeout = new AbortController();
const timer = setTimeout(() => timeout.abort(), 90_000);
try {
  await transport.connect();
  const provider = new CurrentCodexTaskTextProvider({ threadId, transport });
  const result = await runDiscordScreenShareAction(action, provider, timeout.signal);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 3;
} catch {
  process.stderr.write("The fixed screen-share operation did not reach a confirmed Discord UI state.\n");
  process.exitCode = 3;
} finally {
  clearTimeout(timer);
  transport.close();
}
