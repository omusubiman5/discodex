import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("production entrypoint constructs the control runtime and does not register startup tasks", async () => {
  const source = await readFile(new URL("../scripts/run-discord-production-control.mjs", import.meta.url), "utf8");
  assert.match(source, /createProductionDiscordControlRuntime/);
  assert.match(source, /runDiscordApplicationCommandGateway/);
  assert.match(source, /createDiscordBotCredentialProvider/);
  assert.match(source, /validateConfig/);
  assert.doesNotMatch(source, /schtasks|Task Scheduler|HKCU|RunOnce/i);
});
