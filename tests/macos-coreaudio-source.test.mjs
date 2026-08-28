import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("macOS Core Audio host selects one process-local output and bounds scheduled PCM", async () => {
  const source = await readFile(new URL("../native/macos/Sources/DiscodexCoreAudioHost/main.swift", import.meta.url), "utf8");
  assert.match(source, /filter \{ deviceName\(\$0\) == expected \}\.single/);
  assert.match(source, /kAudioOutputUnitProperty_CurrentDevice/);
  assert.match(source, /DispatchSemaphore\(value: 8\)/);
  assert.match(source, /completionCallbackType: \.dataPlayedBack/);
  assert.match(source, /standardOutput\.write\(Data\("READY\\n"\.utf8\)\)/);
  assert.doesNotMatch(source, /kAudioHardwarePropertyDefault(?:Input|Output)Device/);
});

test("macOS libdave build is pinned and runs official C API plus Node lifecycle probes", async () => {
  const source = await readFile(new URL("../scripts/build-libdave-addon-macos.sh", import.meta.url), "utf8");
  assert.match(source, /52cd56dc550f447fb354b3a06c9e2d2e2a4309c6/);
  assert.match(source, /--target libdave capi_test/);
  assert.match(source, /load-probe\.cjs/);
  assert.match(source, /arm64-osx/);
  assert.match(source, /x64-osx/);
});
