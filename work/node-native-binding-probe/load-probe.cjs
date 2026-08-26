"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const binding = require(path.join(__dirname, "build", "libdave_node_probe.node"));
assert.equal(Number.isInteger(binding.maxProtocolVersion), true);
assert.equal(binding.maxProtocolVersion > 0, true);
assert.equal(binding.sessionLifecycle(), true);
assert.equal(binding.sessionOpen(), true);
assert.equal(binding.sessionConfigure("REDACTED_DISCORD_ID_7", "REDACTED_DISCORD_ID_6"), true);
assert.equal(binding.sessionSetProtocolVersion(), true);
assert.equal(typeof binding.sessionSetExternalSender, "function");
const keyPackage = binding.sessionKeyPackage();
assert.equal(keyPackage === null || Buffer.isBuffer(keyPackage), true);
assert.equal(binding.sessionClose(), true);
process.stdout.write(JSON.stringify({
  loaded: true,
  node: process.version,
  napi: process.versions.napi,
  maxProtocolVersion: binding.maxProtocolVersion,
  sessionLifecycle: true,
  sessionConfigure: true,
  sessionSetProtocolVersion: true,
  keyPackageBoundary: Buffer.isBuffer(keyPackage) ? "native-buffer" : "fail-closed",
}) + "\n");
