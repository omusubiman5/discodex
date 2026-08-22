import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateConfig } from "../src/core/config.ts";
import { DiscordAdapter } from "../src/adapters/discord/discord-adapter.ts";
import { MeetAdapter } from "../src/adapters/meet/meet-adapter.ts";
import { DAVE_POLICY } from "../src/adapters/discord/dave-policy.ts";

async function config(transport: "discord" | "meet") {
  const raw = JSON.parse(await readFile(new URL("../config/bridge.example.json", import.meta.url), "utf8"));
  return validateConfig(raw, transport);
}

test("Discord plan uses least-privilege voice and text permissions", async () => {
  const plan = await new DiscordAdapter().plan(await config("discord"));
  assert.deepEqual(plan.requiredPermissions, [
    "VIEW_CHANNEL",
    "SEND_MESSAGES",
    "READ_MESSAGE_HISTORY",
    "USE_APPLICATION_COMMANDS",
    "CONNECT",
    "SPEAK",
  ]);
  assert.ok(!plan.requiredPermissions.includes("ADMINISTRATOR"));
  assert.ok(!plan.requiredPermissions.includes("MANAGE_GUILD"));
});

test("DAVE policy forbids custom crypto and plaintext fallback", () => {
  assert.equal(DAVE_POLICY.preferredProvider, "discord/libdave");
  assert.equal(DAVE_POLICY.allowCustomCryptography, false);
  assert.equal(DAVE_POLICY.allowUnencryptedFallback, false);
});

test("future Meet candidate remains isolated behind the transport contract", async () => {
  const plan = await new MeetAdapter().plan(await config("meet"));
  assert.equal(plan.transport, "meet");
  assert.equal(plan.dryRun, true);
  await assert.rejects(new MeetAdapter().connect(), /intentionally disabled/);
});
