#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runMeetronDesktopLive } from "./run-meetron-windows-live.mjs";

export function loadMeetronMacosLiveEnvironment(environment = process.env) {
  const deviceName = environment.CODEX_BRIDGE_VIRTUAL_AUDIO_DEVICE_NAME?.trim() || "BlackHole 2ch";
  if (!deviceName || deviceName.length > 128) throw new Error("CODEX_BRIDGE_VIRTUAL_AUDIO_DEVICE_NAME is invalid.");
  return {
    ...environment,
    CODEX_BRIDGE_VIRTUAL_AUDIO_DEVICE_NAME: deviceName,
    CODEX_BRIDGE_VIRTUAL_AUDIO_INPUT_LABEL: environment.CODEX_BRIDGE_VIRTUAL_AUDIO_INPUT_LABEL?.trim() || deviceName,
    CODEX_BRIDGE_MEETRON_RUNTIME_CONFIG: environment.CODEX_BRIDGE_MEETRON_RUNTIME_CONFIG || resolve("runtime/meetron-macos-live.json"),
  };
}

export function runMeetronMacosLive({ environment = process.env, signal, observer, gainProvider } = {}) {
  if (process.platform !== "darwin") throw new Error("The macOS live runner requires darwin.");
  return runMeetronDesktopLive({
    environment: loadMeetronMacosLiveEnvironment(environment),
    signal,
    observer,
    gainProvider,
    platform: "darwin",
    phase: "meetron-macos-live",
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runMeetronMacosLive().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "macOS live runner failed."}\n`);
    process.exitCode = 1;
  });
}
