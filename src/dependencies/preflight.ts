import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface DependencyManifest {
  evaluatedAt: string;
  libdave: {
    repository: string;
    commit: string;
    license: string;
    cryptoProvider: "discord/libdave";
    nativeCapi: boolean;
    publishedNodePackage: boolean;
    prebuiltWasmInRepository: boolean;
    wasmEnvironment: string;
    persistentKeys: boolean;
  };
  discordVoiceSdk: {
    package: string;
    observedVersion: string;
    observedNodeEngine: string;
    daveProvider: string;
    decision: string;
    reason: string;
  };
  node: { projectMinimum: string };
  windowsNativeBuild: { required: string[]; optional: string[]; dependencyBootstrap: string };
  macosNativeBuild: { required: string[]; optional: string[]; dependencyBootstrap: string };
}

export interface PreflightCheck {
  id: string;
  status: "pass" | "blocked" | "warning";
  detail: string;
}

export interface DependencyPreflightReport {
  mode: "token-free-preflight";
  state: "ready" | "blocked";
  platform: NodeJS.Platform;
  checks: PreflightCheck[];
  blockers: string[];
  guarantees: string[];
}

function parseVersion(version: string): number[] {
  return version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

function commandPath(command: string, platform: NodeJS.Platform): string | null {
  const finder = platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).find(Boolean) ?? null;
}

function gitHead(path: string): string | null {
  const result = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function loadDependencyManifest(projectRoot: string): DependencyManifest {
  return JSON.parse(readFileSync(join(projectRoot, "config", "dependencies.json"), "utf8"));
}

export function runDependencyPreflight(
  projectRoot: string,
  options: { platform?: NodeJS.Platform; nodeVersion?: string } = {},
): DependencyPreflightReport {
  const manifest = loadDependencyManifest(projectRoot);
  const platform = options.platform ?? process.platform;
  const nodeVersion = options.nodeVersion ?? process.version;
  const checks: PreflightCheck[] = [];

  checks.push({
    id: "node-runtime",
    status: versionAtLeast(nodeVersion, manifest.node.projectMinimum) ? "pass" : "blocked",
    detail: `Node ${nodeVersion}; project minimum is ${manifest.node.projectMinimum}.`,
  });

  const toolchain = platform === "darwin" ? manifest.macosNativeBuild : manifest.windowsNativeBuild;
  for (const command of toolchain.required) {
    const resolved = commandPath(command, platform);
    checks.push({
      id: `toolchain-${command}`,
      status: resolved ? "pass" : "blocked",
      detail: resolved ? `${command} resolved locally.` : `${command} is required but was not found.`,
    });
  }

  const checkout = join(projectRoot, "work", "dependency-probes", "libdave");
  const head = gitHead(checkout);
  checks.push({
    id: "libdave-pinned-checkout",
    status: head === manifest.libdave.commit ? "pass" : "blocked",
    detail: head
      ? `Checkout HEAD is ${head}; expected ${manifest.libdave.commit}.`
      : "The isolated official libdave checkout is missing.",
  });

  const vcpkgMarker = join(checkout, "cpp", "vcpkg", ".git");
  checks.push({
    id: "libdave-vcpkg-submodule",
    status: existsSync(vcpkgMarker) ? "pass" : "blocked",
    detail: existsSync(vcpkgMarker)
      ? "libdave vcpkg submodule is initialized."
      : "libdave vcpkg submodule is not initialized; native dependencies cannot build yet.",
  });

  checks.push({
    id: "official-libdave-policy",
    status: manifest.libdave.cryptoProvider === "discord/libdave" ? "pass" : "blocked",
    detail: "Only discord/libdave is accepted; custom crypto and plaintext fallback remain forbidden.",
  });
  checks.push({
    id: "discordjs-voice-fit",
    status: "blocked",
    detail: `${manifest.discordVoiceSdk.package}@${manifest.discordVoiceSdk.observedVersion} uses ${manifest.discordVoiceSdk.daveProvider}; it is reference-only until an official-libdave injection boundary exists.`,
  });
  checks.push({
    id: "official-wasm-node-fit",
    status: "blocked",
    detail: "Official WASM is not prebuilt in the repository and its current build target is ENVIRONMENT=web, so Node loading is unproven.",
  });

  const blockers = checks.filter((check) => check.status === "blocked").map((check) => check.detail);
  return {
    mode: "token-free-preflight",
    state: blockers.length === 0 ? "ready" : "blocked",
    platform,
    checks,
    blockers,
    guarantees: [
      "No Discord bot token or OAuth credential was read.",
      "No Discord API, Gateway, Voice Gateway, or UDP connection was opened.",
      "No package was installed and no external Discord resource was changed.",
      "The official libdave checkout is isolated under ignored work/.",
    ],
  };
}
