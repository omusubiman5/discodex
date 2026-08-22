import assert from "node:assert/strict";
import test from "node:test";
import { assertOfficialDaveBinding, type DaveBinding } from "../src/adapters/discord/dave-binding.ts";

test("DAVE binding accepts only the official provider", () => {
  const binding = { provider: "discord/libdave", transport: "native-capi" } as DaveBinding;
  assert.doesNotThrow(() => assertOfficialDaveBinding(binding));
  const rejected = { provider: "custom", transport: "native-capi" } as unknown as DaveBinding;
  assert.throws(() => assertOfficialDaveBinding(rejected), /official discord\/libdave/);
});

test("DAVE session contract exposes frame operations but no raw-key getter", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/adapters/discord/dave-binding.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /encryptOpus/);
  assert.match(source, /decryptOpus/);
  assert.doesNotMatch(source, /getRawKey|exportKey|rawKey/);
});
