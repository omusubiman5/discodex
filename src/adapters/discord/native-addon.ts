import { createRequire } from "node:module";
import { extname, resolve } from "node:path";

const nativeRequire = createRequire(import.meta.url);

export interface OfficialLibdaveNativeProbeResult {
  readonly provider: "discord/libdave";
  readonly transport: "native-capi";
  readonly maxProtocolVersion: number;
  readonly sessionLifecycle: true;
}

export interface OfficialLibdaveNativeReadySession {
  readonly provider: "discord/libdave";
  readonly transport: "native-capi";
  readonly maxProtocolVersion: number;
  readonly state: "initialized";
  configure(groupId: string, userId: string): void;
  setProtocolVersion(version: number): void;
  setExternalSender(payload: Uint8Array): void;
  createKeyPackage(): Uint8Array;
  selectMediaRatchet(userId: string, ssrc: number): void;
  encryptOpus(ssrc: number, opusFrame: Uint8Array): Uint8Array;
  decryptOpus(ssrc: number, encryptedFrame: Uint8Array): Uint8Array;
  processProposals(payload: Uint8Array, recognizedUserIds: readonly string[]): Uint8Array | null;
  processCommit(payload: Uint8Array): "accepted" | "ignored" | "failed";
  processWelcome(payload: Uint8Array, recognizedUserIds: readonly string[]): "accepted" | "failed";
  reset(): void;
  isOpen(): boolean;
  close(): void;
}

export type NativeAddonLoader = (absolutePath: string) => unknown;

export function loadOfficialLibdaveNativeProbe(
  addonPath: string,
  loader: NativeAddonLoader = (absolutePath) => nativeRequire(absolutePath),
): OfficialLibdaveNativeProbeResult {
  if (extname(addonPath).toLowerCase() !== ".node") {
    throw new Error("Official libdave native addon path must end in .node.");
  }

  const loaded = loader(resolve(addonPath));
  if (typeof loaded !== "object" || loaded === null) {
    throw new Error("Official libdave native addon did not expose an object.");
  }

  const addon = loaded as Record<string, unknown>;
  if (!Number.isSafeInteger(addon.maxProtocolVersion) || Number(addon.maxProtocolVersion) <= 0) {
    throw new Error("Official libdave native addon reported an invalid protocol version.");
  }
  if (typeof addon.sessionLifecycle !== "function") {
    throw new Error("Official libdave native addon omitted the session lifecycle probe.");
  }

  let lifecyclePassed = false;
  try {
    lifecyclePassed = Reflect.apply(addon.sessionLifecycle, addon, []) === true;
  } catch (error) {
    throw new Error("Official libdave native session lifecycle probe threw.", { cause: error });
  }
  if (!lifecyclePassed) {
    throw new Error("Official libdave native session lifecycle probe failed closed.");
  }

  return Object.freeze({
    provider: "discord/libdave",
    transport: "native-capi",
    maxProtocolVersion: Number(addon.maxProtocolVersion),
    sessionLifecycle: true,
  });
}

export function openOfficialLibdaveNativeReadySession(
  addonPath: string,
  loader: NativeAddonLoader = (absolutePath) => nativeRequire(absolutePath),
): OfficialLibdaveNativeReadySession {
  if (extname(addonPath).toLowerCase() !== ".node") {
    throw new Error("Official libdave native addon path must end in .node.");
  }
  const loaded = loader(resolve(addonPath));
  if (typeof loaded !== "object" || loaded === null) throw new Error("Official libdave native addon did not expose an object.");
  const addon = loaded as Record<string, unknown>;
  if (!Number.isSafeInteger(addon.maxProtocolVersion) || Number(addon.maxProtocolVersion) <= 0) {
    throw new Error("Official libdave native addon reported an invalid protocol version.");
  }
  for (const name of ["sessionOpen", "sessionClose", "sessionIsOpen"] as const) {
    if (typeof addon[name] !== "function") throw new Error(`Official libdave native addon omitted ${name}.`);
  }
  if (Reflect.apply(addon.sessionOpen as Function, addon, []) !== true || Reflect.apply(addon.sessionIsOpen as Function, addon, []) !== true) {
    throw new Error("Official libdave native session initialization failed closed.");
  }
  let closed = false;
  const invokeRequired = (name: string, args: unknown[]): unknown => {
    if (closed) throw new Error("Official libdave native session is closed.");
    const operation = addon[name];
    if (typeof operation !== "function") throw new Error(`Official libdave native addon omitted ${name}.`);
    return Reflect.apply(operation, addon, args);
  };
  return Object.freeze({
    provider: "discord/libdave" as const,
    transport: "native-capi" as const,
    maxProtocolVersion: Number(addon.maxProtocolVersion),
    state: "initialized" as const,
    configure(groupId: string, userId: string): void {
      if (!/^\d{1,20}$/.test(groupId) || !/^\d{1,20}$/.test(userId)) {
        throw new Error("Official libdave native session identifiers are invalid.");
      }
      if (invokeRequired("sessionConfigure", [groupId, userId]) !== true) {
        throw new Error("Official libdave native session configuration failed closed.");
      }
    },
    setProtocolVersion(version: number): void {
      if (!Number.isSafeInteger(version) || version <= 0 || version > Number(addon.maxProtocolVersion)) {
        throw new Error("Official libdave native protocol version is invalid.");
      }
      if (invokeRequired("sessionSetProtocolVersion", [version]) !== true) {
        throw new Error("Official libdave native protocol version update failed closed.");
      }
    },
    setExternalSender(payload: Uint8Array): void {
      if (!(payload instanceof Uint8Array) || payload.length === 0) {
        throw new Error("Official libdave External Sender payload is empty.");
      }
      if (invokeRequired("sessionSetExternalSender", [Buffer.from(payload)]) !== true) {
        throw new Error("Official libdave External Sender update failed closed.");
      }
    },
    createKeyPackage(): Uint8Array {
      const value = invokeRequired("sessionKeyPackage", []);
      if (!(value instanceof Uint8Array) || value.length === 0) {
        throw new Error("Official libdave native key package generation failed closed.");
      }
      return Uint8Array.from(value);
    },
    selectMediaRatchet(userId: string, ssrc: number): void {
      if (!/^\d{1,20}$/.test(userId) || !Number.isSafeInteger(ssrc) || ssrc <= 0) throw new Error("DAVE media ratchet input is invalid.");
      if (invokeRequired("sessionSelectMediaRatchet", [userId, ssrc]) !== true) throw new Error("DAVE media ratchet transition failed closed.");
    },
    encryptOpus(ssrc: number, opusFrame: Uint8Array): Uint8Array {
      if (!Number.isSafeInteger(ssrc) || ssrc <= 0 || !(opusFrame instanceof Uint8Array) || opusFrame.length === 0) throw new Error("DAVE Opus encryption input is invalid.");
      const value = invokeRequired("sessionEncryptOpus", [ssrc, Buffer.from(opusFrame)]);
      if (!(value instanceof Uint8Array) || value.length === 0) throw new Error("DAVE Opus encryption failed closed.");
      return Uint8Array.from(value);
    },
    decryptOpus(ssrc: number, encryptedFrame: Uint8Array): Uint8Array {
      if (!Number.isSafeInteger(ssrc) || ssrc <= 0 || !(encryptedFrame instanceof Uint8Array) || encryptedFrame.length === 0) throw new Error("DAVE Opus decryption input is invalid.");
      const value = invokeRequired("sessionDecryptOpus", [ssrc, Buffer.from(encryptedFrame)]);
      if (!(value instanceof Uint8Array) || value.length === 0) throw new Error("DAVE Opus decryption failed closed.");
      return Uint8Array.from(value);
    },
    processProposals(payload: Uint8Array, recognizedUserIds: readonly string[]): Uint8Array | null {
      const value = invokeRequired("sessionProcessProposals", [Buffer.from(payload), [...recognizedUserIds]]);
      if (value === null) return null;
      if (!(value instanceof Uint8Array) || value.length === 0) throw new Error("Official libdave proposal processing failed closed.");
      return Uint8Array.from(value);
    },
    processCommit(payload: Uint8Array): "accepted" | "ignored" | "failed" {
      const value = invokeRequired("sessionProcessCommit", [Buffer.from(payload)]);
      if (value !== "accepted" && value !== "ignored" && value !== "failed") throw new Error("Official libdave commit result is invalid.");
      return value;
    },
    processWelcome(payload: Uint8Array, recognizedUserIds: readonly string[]): "accepted" | "failed" {
      return invokeRequired("sessionProcessWelcome", [Buffer.from(payload), [...recognizedUserIds]]) === true ? "accepted" : "failed";
    },
    reset(): void {
      if (invokeRequired("sessionReset", []) !== true) throw new Error("Official libdave native session reset failed closed.");
    },
    isOpen(): boolean {
      return !closed && Reflect.apply(addon.sessionIsOpen as Function, addon, []) === true;
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (Reflect.apply(addon.sessionClose as Function, addon, []) !== true) {
        throw new Error("Official libdave native session close failed.");
      }
    },
  });
}
