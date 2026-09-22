#!/usr/bin/env node
import { inspectRelaySetup } from "../src/core/relay-setup.mjs";

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || value === undefined || values.has(name)) {
    process.stderr.write("Relay setup arguments are invalid.\n");
    process.exit(1);
  }
  values.set(name, value);
}

function required(name) {
  const value = values.get(name);
  if (!value) throw new Error("Relay setup arguments are invalid.");
  return value;
}

function boolean(name) {
  const value = required(name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("Relay setup arguments are invalid.");
}

try {
  const setup = inspectRelaySetup({
    runtimeConfigFile: required("--runtime-config"),
    taskFile: required("--task-file"),
    credentialConfigured: boolean("--credential-ready"),
    audioDeviceConfigured: boolean("--audio-ready"),
    audioDeviceMissingCode: required("--audio-code"),
    audioFormatVerificationRequired: boolean("--audio-format-verification-required"),
  });
  process.stdout.write(`${JSON.stringify({ ...setup, secretOutput: false, identifierOutput: false })}\n`);
} catch {
  process.stderr.write("Relay setup inspection failed.\n");
  process.exit(1);
}
