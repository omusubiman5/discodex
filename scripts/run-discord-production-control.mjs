#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { validateConfig } from "../src/core/config.ts";
import { createDiscordBotCredentialProvider, useCredential } from "../src/core/credentials.ts";
import { createProductionDiscordControlRuntime } from "../src/adapters/discord/production-control-runtime.ts";
import { resolveApprovedGuildControlScope, runDiscordApplicationCommandGateway } from "../src/adapters/discord/application-command-runtime.ts";

const configPath = process.env.CODEX_BRIDGE_CONFIG || resolve("config/bridge.example.json");
const raw = JSON.parse(await readFile(configPath, "utf8"));
const stdinMode = process.argv.includes("--stdin");
process.stdout.write(`${JSON.stringify({ state: stdinMode ? "stdin-ready" : "registering-discord-ui", controls: ["connect", "disconnect", "status", "gain"], secretOutput: false, identifierOutput: false })}\n`);

// Local stdin adapter for the already-authorized interaction seam. It never
// accepts credentials or writes host startup state.
if (stdinMode) {
  const config = validateConfig(raw).discord;
  const runtime = createProductionDiscordControlRuntime(config);
  for await (const line of process.stdin) {
    if (!line.trim()) continue;
    try {
      const interaction = JSON.parse(line);
      const result = runtime.controls.handle(interaction);
      process.stdout.write(`${JSON.stringify({ ok: result.ok, message: result.message, secretOutput: false, identifierOutput: false })}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({ ok: false, message: "Interaction rejected.", secretOutput: false, identifierOutput: false })}\n`);
    }
  }
} else {
  const provider = createDiscordBotCredentialProvider();
  await useCredential(provider, async (credential) => {
    const runtimeConfigPath = process.env.CODEX_BRIDGE_MEETRON_RUNTIME_CONFIG
      || resolve(process.platform === "darwin" ? "runtime/meetron-macos-live.json" : "runtime/meetron-windows-live.json");
    if (!existsSync(runtimeConfigPath)) throw new Error("The approved Discord runtime target is not configured.");
    const stored = JSON.parse(await readFile(runtimeConfigPath, "utf8"));
    const controlScope = await resolveApprovedGuildControlScope(credential, stored.discordGuildId);
    const config = validateConfig({ ...raw, discord: { ...raw.discord,
      guildId: stored.discordGuildId,
      voiceChannelId: stored.discordVoiceChannelId,
      textChannelId: controlScope.textChannelId,
      allowedUserIds: [controlScope.ownerId],
    } }).discord;
    const runtime = createProductionDiscordControlRuntime(config);
    await runDiscordApplicationCommandGateway({
      credential,
      config,
      controls: runtime.controls,
      observer: (event) => process.stdout.write(`${JSON.stringify({ state: event.state, controls: ["connect", "disconnect", "status", "gain"], secretOutput: false, identifierOutput: false })}\n`),
    });
  });
}
