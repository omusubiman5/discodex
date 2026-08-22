import { createRequire } from "node:module";
import { extname, resolve } from "node:path";

const nativeRequire = createRequire(import.meta.url);

export interface OfficialLibdaveNativeProbeResult {
  readonly provider: "discord/libdave";
  readonly transport: "native-capi";
  readonly maxProtocolVersion: number;
  readonly sessionLifecycle: true;
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
