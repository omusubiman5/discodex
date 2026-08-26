import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDiscordBotCredentialProvider,
  EnvironmentCredentialProvider,
  MacosKeychainCredentialProvider,
  type BotCredentialProvider,
  type CredentialLease,
  useCredential,
  WindowsDpapiCredentialProvider,
} from "../src/core/credentials.ts";

function trackingProvider(): {
  provider: BotCredentialProvider;
  disposed: () => boolean;
} {
  let wasDisposed = false;
  const lease: CredentialLease = {
    async use<T>(consumer: (credential: string) => Promise<T>): Promise<T> {
      if (wasDisposed) throw new Error("Credential lease is disposed.");
      return consumer("unit-test-only");
    },
    dispose(): void {
      wasDisposed = true;
    },
  };
  return {
    provider: {
      storage: "development-environment",
      async acquire(): Promise<CredentialLease> {
        return lease;
      },
    },
    disposed: () => wasDisposed,
  };
}

test("development credential is leased without being logged and cannot be reused after disposal", async () => {
  const variable = "CODEX_BRIDGE_TEST_TOKEN";
  process.env[variable] = "unit-test-only";
  try {
    const lease = await new EnvironmentCredentialProvider(variable).acquire();
    assert.equal(await lease.use(async (value) => value.length), 14);
    lease.dispose();
    await assert.rejects(lease.use(async () => 0), /disposed/);
  } finally {
    delete process.env[variable];
  }
});

test("development credential provider fails when the local variable is absent", async () => {
  delete process.env.CODEX_BRIDGE_MISSING_TOKEN;
  await assert.rejects(
    new EnvironmentCredentialProvider("CODEX_BRIDGE_MISSING_TOKEN").acquire(),
    /is not set/,
  );
});

test("scoped credential use disposes the lease after success", async () => {
  const tracked = trackingProvider();
  assert.equal(await useCredential(tracked.provider, async (value) => value.length), 14);
  assert.equal(tracked.disposed(), true);
});

test("scoped credential use disposes the lease when the consumer fails", async () => {
  const tracked = trackingProvider();
  await assert.rejects(
    useCredential(tracked.provider, async () => {
      throw new Error("consumer failed");
    }),
    /consumer failed/,
  );
  assert.equal(tracked.disposed(), true);
});

test("Windows DPAPI provider stores ciphertext, reads a scoped lease, and deletes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdvb-dpapi-"));
  const provider = new WindowsDpapiCredentialProvider("unit-test", root);
  const synthetic = "synthetic-secret-never-log";
  try {
    await provider.store(synthetic);
    const protectedFile = await readFile(join(root, "unit-test.dpapi"), "ascii");
    assert.ok(protectedFile.length > 0);
    assert.equal(protectedFile.includes(synthetic), false);
    const lease = await provider.acquire();
    assert.equal(await lease.use(async (value) => value === synthetic), true);
    lease.dispose();
    await assert.rejects(lease.use(async () => true), /disposed/);
    await provider.delete();
    await assert.rejects(provider.acquire(), /not configured/);
  } finally {
    await provider.delete();
    await rmdir(root);
  }
});

test("Windows DPAPI provider fails closed for corrupt protected data without echoing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cdvb-dpapi-corrupt-"));
  const provider = new WindowsDpapiCredentialProvider("unit-test", root);
  try {
    await writeFile(join(root, "unit-test.dpapi"), "not-valid-dpapi", "ascii");
    await assert.rejects(provider.acquire(), (error: Error) => {
      assert.match(error.message, /corrupt or unavailable/);
      assert.doesNotMatch(error.message, /not-valid-dpapi/);
      return true;
    });
  } finally {
    await provider.delete();
    await rmdir(root);
  }
});

test("production selection defaults to Windows DPAPI and environment fallback is explicit", () => {
  const production = createDiscordBotCredentialProvider({ platform: "win32", windowsRoot: "C:\\synthetic-only" });
  const development = createDiscordBotCredentialProvider({ platform: "win32", mode: "development-environment" });
  assert.equal(production.storage, "windows-dpapi-current-user");
  assert.equal(development.storage, "development-environment");
  assert.throws(
    () => createDiscordBotCredentialProvider({ platform: "win32", mode: "unknown" }),
    /Unsupported Discord credential provider mode/,
  );
});

test("macOS Keychain provider reads through security without putting the credential in argv", async () => {
  const calls: string[][] = [];
  const provider = new MacosKeychainCredentialProvider("unit-service", "unit-account", async (args) => {
    calls.push([...args]);
    return "synthetic-keychain-secret";
  });
  const lease = await provider.acquire();
  assert.equal(await lease.use(async (value) => value.length), 25);
  lease.dispose();
  await assert.rejects(lease.use(async () => 0), /disposed/);
  await provider.delete();
  assert.deepEqual(calls, [
    ["find-generic-password", "-w", "-s", "unit-service", "-a", "unit-account"],
    ["delete-generic-password", "-s", "unit-service", "-a", "unit-account"],
  ]);
  assert.equal(calls.flat().includes("synthetic-keychain-secret"), false);
});

test("production selection uses macOS Keychain and rejects cross-platform forced modes", () => {
  assert.equal(createDiscordBotCredentialProvider({ platform: "darwin" }).storage, "macos-keychain");
  assert.throws(() => createDiscordBotCredentialProvider({ platform: "darwin", mode: "windows-dpapi-current-user" }), /requires Windows/);
  assert.throws(() => createDiscordBotCredentialProvider({ platform: "win32", mode: "macos-keychain" }), /requires macOS/);
});
