import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CredentialLease {
  use<T>(consumer: (credential: string) => Promise<T>): Promise<T>;
  dispose(): void;
}

export interface BotCredentialProvider {
  readonly storage: "windows-credential-manager" | "windows-dpapi-current-user" | "macos-keychain" | "development-environment";
  acquire(): Promise<CredentialLease>;
}

const DEFAULT_WINDOWS_TARGET = "codex-discord-voice-bridge.bot-token";
const DEFAULT_MACOS_SERVICE = "codex-discord-voice-bridge.bot-token";
const DEFAULT_MACOS_ACCOUNT = "discord-bot";

const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
if ([string]::IsNullOrEmpty($plain)) { throw 'Credential input is empty.' }
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
try {
  $protected = [Security.Cryptography.ProtectedData]::Protect(
    $bytes,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::Out.Write([Convert]::ToBase64String($protected))
} finally {
  [Array]::Clear($bytes, 0, $bytes.Length)
  $plain = $null
}
`;

const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd()
$protected = [Convert]::FromBase64String($encoded)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $protected,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
try {
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
} finally {
  [Array]::Clear($bytes, 0, $bytes.Length)
}
`;

async function runDpapi(script: string, input: string): Promise<string> {
  if (process.platform !== "win32") throw new Error("Windows DPAPI is available only on Windows.");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.once("error", () => reject(new Error("Windows DPAPI operation failed.")));
    child.once("close", (code) => {
      const output = Buffer.concat(stdout);
      const value = output.toString("utf8");
      output.fill(0);
      stdout.forEach((chunk) => chunk.fill(0));
      if (code !== 0) reject(new Error("Windows DPAPI operation failed."));
      else resolve(value);
    });
    child.stdin.end(input, "utf8");
  });
}

function assertTarget(target: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(target)) throw new Error("Credential target is invalid.");
}

function defaultWindowsSecretRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is unavailable for the Windows secret store.");
  return join(localAppData, "CodexVoiceBridge", "secrets");
}

export async function useCredential<T>(
  provider: BotCredentialProvider,
  consumer: (credential: string) => Promise<T>,
): Promise<T> {
  const lease = await provider.acquire();
  try {
    return await lease.use(consumer);
  } finally {
    lease.dispose();
  }
}

export class EnvironmentCredentialProvider implements BotCredentialProvider {
  readonly storage = "development-environment" as const;
  readonly #variableName: string;

  constructor(variableName = "CODEX_BRIDGE_DISCORD_BOT_TOKEN") {
    this.#variableName = variableName;
  }

  async acquire(): Promise<CredentialLease> {
    const credential = process.env[this.#variableName];
    if (!credential) throw new Error(`${this.#variableName} is not set in this process.`);
    let disposed = false;
    return {
      async use<T>(consumer: (value: string) => Promise<T>): Promise<T> {
        if (disposed) throw new Error("Credential lease is disposed.");
        return consumer(credential);
      },
      dispose(): void {
        disposed = true;
      },
    };
  }
}

export class WindowsDpapiCredentialProvider implements BotCredentialProvider {
  readonly storage = "windows-dpapi-current-user" as const;
  readonly #path: string;

  constructor(target = DEFAULT_WINDOWS_TARGET, root = defaultWindowsSecretRoot()) {
    assertTarget(target);
    this.#path = join(root, `${target}.dpapi`);
  }

  async store(credential: string): Promise<void> {
    if (!credential) throw new Error("Credential must not be empty.");
    const protectedValue = await runDpapi(PROTECT_SCRIPT, credential);
    const temporaryPath = `${this.#path}.${process.pid}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(temporaryPath, protectedValue, { encoding: "ascii", flag: "wx" });
    await rename(temporaryPath, this.#path);
  }

  async delete(): Promise<void> {
    try {
      await unlink(this.#path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async acquire(): Promise<CredentialLease> {
    let protectedValue: string;
    try {
      protectedValue = await readFile(this.#path, "ascii");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Windows DPAPI credential is not configured.");
      }
      throw new Error("Windows DPAPI credential cannot be read.");
    }
    let credential: string;
    try {
      credential = await runDpapi(UNPROTECT_SCRIPT, protectedValue);
    } catch {
      throw new Error("Windows DPAPI credential is corrupt or unavailable to the current user.");
    }
    if (!credential) throw new Error("Windows DPAPI credential is empty.");
    let disposed = false;
    return {
      async use<T>(consumer: (value: string) => Promise<T>): Promise<T> {
        if (disposed) throw new Error("Credential lease is disposed.");
        return consumer(credential);
      },
      dispose(): void {
        disposed = true;
        credential = "";
      },
    };
  }
}

export type MacosSecurityRunner = (args: readonly string[]) => Promise<string>;

async function runMacosSecurity(args: readonly string[]): Promise<string> {
  if (process.platform !== "darwin") throw new Error("macOS Keychain is available only on macOS.");
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.once("error", () => reject(new Error("macOS Keychain operation failed.")));
    child.once("close", (code) => {
      const output = Buffer.concat(stdout);
      const value = output.toString("utf8").replace(/[\r\n]+$/, "");
      output.fill(0);
      stdout.forEach((chunk) => chunk.fill(0));
      if (code !== 0) reject(new Error("macOS Keychain operation failed."));
      else resolve(value);
    });
  });
}

export class MacosKeychainCredentialProvider implements BotCredentialProvider {
  readonly storage = "macos-keychain" as const;
  readonly #service: string;
  readonly #account: string;
  readonly #runner: MacosSecurityRunner;

  constructor(service = DEFAULT_MACOS_SERVICE, account = DEFAULT_MACOS_ACCOUNT, runner: MacosSecurityRunner = runMacosSecurity) {
    assertTarget(service);
    assertTarget(account);
    this.#service = service;
    this.#account = account;
    this.#runner = runner;
  }

  async delete(): Promise<void> {
    await this.#runner(["delete-generic-password", "-s", this.#service, "-a", this.#account]);
  }

  async acquire(): Promise<CredentialLease> {
    let credential: string;
    try { credential = await this.#runner(["find-generic-password", "-w", "-s", this.#service, "-a", this.#account]); }
    catch { throw new Error("macOS Keychain credential is not configured or unavailable to the current user."); }
    if (!credential) throw new Error("macOS Keychain credential is empty.");
    let disposed = false;
    return {
      async use<T>(consumer: (value: string) => Promise<T>): Promise<T> {
        if (disposed) throw new Error("Credential lease is disposed.");
        return consumer(credential);
      },
      dispose(): void { disposed = true; credential = ""; },
    };
  }
}

export interface CredentialProviderSelectionOptions {
  mode?: string;
  platform?: NodeJS.Platform;
  windowsRoot?: string;
}

export function createDiscordBotCredentialProvider(
  options: CredentialProviderSelectionOptions = {},
): BotCredentialProvider {
  const mode = options.mode ?? process.env.CODEX_BRIDGE_CREDENTIAL_PROVIDER;
  const platform = options.platform ?? process.platform;
  if (mode === "development-environment") return new EnvironmentCredentialProvider();
  if (mode && mode !== "windows-dpapi-current-user" && mode !== "macos-keychain") {
    throw new Error("Unsupported Discord credential provider mode.");
  }
  if (mode === "windows-dpapi-current-user" && platform !== "win32") throw new Error("Windows DPAPI credential provider requires Windows.");
  if (mode === "macos-keychain" && platform !== "darwin") throw new Error("macOS Keychain credential provider requires macOS.");
  if (platform === "win32") {
    return new WindowsDpapiCredentialProvider(DEFAULT_WINDOWS_TARGET, options.windowsRoot ?? defaultWindowsSecretRoot());
  }
  if (platform === "darwin") return new MacosKeychainCredentialProvider();
  throw new Error("No production Discord credential provider is configured for this platform.");
}
