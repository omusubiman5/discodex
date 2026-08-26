const endpoint = process.env.CODEX_DESKTOP_DEBUGGER_ENDPOINT;
const taskIdentity = process.env.CODEX_THREAD_ID;
const presenceOnly = process.argv.includes("--presence-only");
import { selectIdentityScopedTargets } from "./route-target-scope.mjs";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint ?? "")) throw new Error("Loopback Codex debugger endpoint is required.");

let requestId = 0;
async function inspectTarget(target, index) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const contexts = new Map();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP connection timeout.")), 2_000);
    socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.executionContextCreated") {
      contexts.set(message.params.context.id, message.params.context);
      return;
    }
    const pendingRequest = pending.get(message.id);
    if (!pendingRequest) return;
    pending.delete(message.id);
    message.error ? pendingRequest.reject(new Error(`CDP request failed [${pendingRequest.method}:${message.error.code ?? "unknown"}].`)) : pendingRequest.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP request timeout [${method}].`)); }, 8_000);
    pending.set(id, {
      method,
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await call("Runtime.enable");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const metrics = await call("Performance.enable").then(() => call("Performance.getMetrics"));
    const processId = metrics.metrics?.find((metric) => metric.name === "ProcessID")?.value;
    const contextReports = [];
    for (const context of contexts.values()) {
      const evaluated = await call("Runtime.evaluate", {
        contextId: context.id,
        expression: `({
          hasRtc: typeof RTCPeerConnection === 'function',
          hasMediaTrack: typeof MediaStreamTrack === 'function',
          domAudioElements: document.querySelectorAll('audio').length,
          domLiveAudioTracks: [...document.querySelectorAll('audio')].flatMap((element) => [...(element.srcObject?.getAudioTracks?.() ?? [])]).filter((track) => track.readyState === 'live').length,
        mediaDevices: Boolean(navigator.mediaDevices)
        , voiceActive: [...document.querySelectorAll("button,[role=button]")].some((element) => {
          const label = [element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-testid")].filter(Boolean).join(" ");
          return /(end|stop).*(voice|call)|(voice|call).*(end|stop)|音声チャットを終了|通話を終了|マイク.*ミュート/i.test(label);
        })
        })`,
        returnByValue: true,
      }).catch(() => null);
      const value = evaluated?.result?.value;
      if (!value) continue;
      let peerInstances = 0;
      let livePeerAudioSenders = 0;
      let livePeerAudioReceivers = 0;
      let liveAudioTracks = 0;
      if (value.hasRtc && !presenceOnly) {
        const prototype = await call("Runtime.evaluate", { contextId: context.id, expression: "RTCPeerConnection.prototype" });
        if (prototype.result.objectId) {
          const instances = await call("Runtime.queryObjects", { prototypeObjectId: prototype.result.objectId });
          if (instances.objects.objectId) {
            const peers = await call("Runtime.callFunctionOn", {
              objectId: instances.objects.objectId,
              functionDeclaration: `function() {
                const peers = this.filter((peer) => ['connected', 'connecting'].includes(peer.connectionState));
                return {
                  peerInstances: this.length,
                  livePeerAudioSenders: peers.flatMap((peer) => peer.getSenders()).filter((sender) => sender.track?.kind === 'audio' && sender.track.readyState === 'live').length,
                  livePeerAudioReceivers: peers.flatMap((peer) => peer.getReceivers()).filter((receiver) => receiver.track?.kind === 'audio' && receiver.track.readyState === 'live').length,
                  transceivers: peers.flatMap((peer) => peer.getTransceivers()).map((transceiver) => ({
                    direction: transceiver.direction,
                    currentDirection: transceiver.currentDirection,
                    senderKind: transceiver.sender.track?.kind,
                    receiverKind: transceiver.receiver.track?.kind,
                    receiverState: transceiver.receiver.track?.readyState,
                  })),
                };
              }`,
              returnByValue: true,
            });
            peerInstances = peers.result.value?.peerInstances ?? 0;
            livePeerAudioSenders = peers.result.value?.livePeerAudioSenders ?? 0;
            livePeerAudioReceivers = peers.result.value?.livePeerAudioReceivers ?? 0;
          }
        }
      }
      if (value.hasMediaTrack && !presenceOnly) {
        const prototype = await call("Runtime.evaluate", { contextId: context.id, expression: "MediaStreamTrack.prototype" });
        if (prototype.result.objectId) {
          const instances = await call("Runtime.queryObjects", { prototypeObjectId: prototype.result.objectId });
          if (instances.objects.objectId) {
            const tracks = await call("Runtime.callFunctionOn", {
              objectId: instances.objects.objectId,
              functionDeclaration: "function() { return this.filter((track) => track.kind === 'audio' && track.readyState === 'live').length; }",
              returnByValue: true,
            });
            liveAudioTracks = tracks.result.value ?? 0;
          }
        }
      }
      contextReports.push({
        defaultWorld: context.auxData?.isDefault === true,
        peerInstances,
        livePeerAudioSenders,
        livePeerAudioReceivers,
        liveAudioTracks,
        domAudioElements: value.domAudioElements,
        domLiveAudioTracks: value.domLiveAudioTracks,
        mediaDevices: value.mediaDevices,
        voiceActive: value.voiceActive === true,
      });
    }
    return {
      targetIndex: index,
      type: target.type,
      rendererProcessId: Number.isSafeInteger(processId) ? processId : undefined,
      executionContexts: contextReports.length,
      peerInstances: contextReports.reduce((sum, report) => sum + report.peerInstances, 0),
      livePeerAudioSenders: contextReports.reduce((sum, report) => sum + report.livePeerAudioSenders, 0),
      livePeerAudioReceivers: contextReports.reduce((sum, report) => sum + report.livePeerAudioReceivers, 0),
      liveAudioTracks: contextReports.reduce((sum, report) => sum + report.liveAudioTracks, 0),
      domAudioElements: Math.max(0, ...contextReports.map((report) => report.domAudioElements)),
      domLiveAudioTracks: Math.max(0, ...contextReports.map((report) => report.domLiveAudioTracks)),
      hasMediaDevicesContext: contextReports.some((report) => report.mediaDevices),
      voiceActive: contextReports.some((report) => report.voiceActive),
    };
  } finally {
    socket.close();
  }
}

const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const inspectable = selectIdentityScopedTargets(targets, taskIdentity);
const reports = [];
for (let index = 0; index < inspectable.length; index += 1) {
  reports.push(await inspectTarget(inspectable[index], index).catch((error) => ({ targetIndex: index, type: inspectable[index].type, inspectionFailed: true, error: error instanceof Error ? error.message : "unknown" })));
}
console.log(JSON.stringify({
  targets: reports,
  totalLivePeerAudioSenders: reports.reduce((sum, report) => sum + (report.livePeerAudioSenders ?? 0), 0),
  totalLivePeerAudioReceivers: reports.reduce((sum, report) => sum + (report.livePeerAudioReceivers ?? 0), 0),
  totalLiveAudioTracks: reports.reduce((sum, report) => sum + (report.liveAudioTracks ?? 0), 0),
  voiceActive: reports.some((report) => report.voiceActive === true),
  secretOutput: false,
  identifierOutput: false,
}));
