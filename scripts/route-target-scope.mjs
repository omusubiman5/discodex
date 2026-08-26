export function selectIdentityScopedTargets(targets, taskIdentity) {
  if (!/^[0-9a-f-]{20,}$/i.test(taskIdentity ?? "")) return [];
  const desktopRenderers = targets.filter((target) => {
    if (target.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") return false;
    if (target.url === "app://-/index.html") return true;
    try {
      const url = new URL(target.url);
      return url.protocol === "app:"
        && url.hostname === "-"
        && url.pathname === "/index.html"
        && url.searchParams.get("initialRoute") === "/avatar-overlay";
    } catch {
      return false;
    }
  });
  // The task identity is verified separately through the Desktop-owned
  // app-server thread/read seam. Current Desktop builds move the active voice
  // peer into one owned avatar-overlay renderer. Querying every historical
  // RTCPeerConnection in the main renderer can take tens of seconds, so use
  // the unique media owner when present and fall back to main only before the
  // overlay exists. Unknown or duplicate app pages still fail closed.
  const main = desktopRenderers.filter((target) => target.url === "app://-/index.html");
  const overlays = desktopRenderers.filter((target) => target.url !== "app://-/index.html");
  if (main.length !== 1 || overlays.length > 1) return [];
  return overlays.length === 1 ? overlays : main;
}
