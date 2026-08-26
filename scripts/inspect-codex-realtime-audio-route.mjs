const endpoint = process.env.CODEX_DESKTOP_DEBUGGER_ENDPOINT;
const applyCable = process.argv.includes("--apply-cable-input");
const applyPhysical = process.argv.includes("--apply-physical-input");
const applyGraph = process.argv.includes("--apply-cable-graph-input");
const reconcilePhysical = process.argv.includes("--reconcile-physical-input");
const trace = process.env.CODEX_ROUTE_TRACE === "1";
import { selectIdentityScopedTargets } from "./route-target-scope.mjs";
const traceStartedAt = Date.now();
const traceMark = (stage, fields = {}) => {
  if (trace) console.error(JSON.stringify({ stage, elapsedMs: Date.now() - traceStartedAt, ...fields, secretOutput: false, identifierOutput: false }));
};
if ([applyCable, applyPhysical, applyGraph, reconcilePhysical].filter(Boolean).length > 1) throw new Error("Only one Codex input route mutation may be requested.");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint ?? "")) throw new Error("Loopback Codex debugger endpoint is required.");

let nextId = 0;
async function withCdp(url, operation) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const contexts = new Map();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Codex renderer CDP connection timed out.")), 2_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.executionContextCreated") {
      contexts.set(message.params.context.id, message.params.context);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error("Codex renderer CDP request failed."));
    else entry.resolve(message.result);
  });
  const call = (method, params = {}, timeoutMs = 8_000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Codex renderer CDP request timed out."));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try { return await operation(call, contexts); } finally { socket.close(); }
}

traceMark("target-list-start");
const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
traceMark("target-list-complete", { count: targets.length });
// Select the renderer belonging to this task before opening a CDP socket.  A
// Desktop window can expose several unrelated pages; querying their WebRTC
// prototypes is both unnecessary and (for some pages) very slow.  The host
// publishes the task identity on the target metadata when available.
const taskIdentity = process.env.CODEX_THREAD_ID;
const identityCandidates = selectIdentityScopedTargets(targets, taskIdentity);
// Never broaden the search when identity is absent.  An unscoped CDP query
// could attach to another renderer and is therefore unsafe even read-only.
const scopedTargets = taskIdentity ? identityCandidates : [];
traceMark("target-scope-selected", { count: scopedTargets.length, identityMatched: identityCandidates.length > 0 });
const candidates = [];
for (const [targetIndex, target] of scopedTargets.entries()) {
  if (!target.webSocketDebuggerUrl || !["page", "webview"].includes(target.type)) continue;
  traceMark("target-open-start", { targetIndex, type: target.type });
  const result = await withCdp(target.webSocketDebuggerUrl, async (call, contexts) => {
    await call("Runtime.enable");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const contextOwners = await Promise.all([...contexts.values()].map(async (context) => {
      const contextId = context.id;
      const evaluated = await call("Runtime.evaluate", {
        contextId,
        expression: "({ hasRtc: typeof RTCPeerConnection === 'function' })",
        returnByValue: true,
      }).catch(() => null);
      if (!evaluated?.result.value?.hasRtc) return null;
      const prototype = await call("Runtime.evaluate", { contextId, expression: "RTCPeerConnection.prototype" }).catch(() => null);
      if (!prototype?.result.objectId) return null;
      traceMark("peer-query-start", { targetIndex, defaultWorld: context.auxData?.isDefault === true });
      const queried = await call("Runtime.queryObjects", { prototypeObjectId: prototype.result.objectId }, 20_000).catch(() => null);
      traceMark("peer-query-complete", { targetIndex, defaultWorld: context.auxData?.isDefault === true });
      if (!queried?.objects.objectId) return null;
      const ownership = await call("Runtime.callFunctionOn", {
        objectId: queried.objects.objectId,
        functionDeclaration: `function() {
          const peers = this.filter((peer) => ['connected', 'connecting'].includes(peer.connectionState));
          const live = peers.flatMap((peer) => peer.getSenders()).filter((sender) => sender.track?.kind === 'audio' && sender.track.readyState === 'live').length;
          return { live, rollback: Boolean(globalThis.__codexBridgeAudioGraphRollback || globalThis.__codexBridgeAudioRollback) };
        }`,
        returnByValue: true,
      }).catch(() => null);
      return (ownership?.result.value?.live ?? 0) > 0 || ownership?.result.value?.rollback === true
        ? { instances: queried, contextId }
        : null;
    }));
    const owners = contextOwners.filter(Boolean);
    if (owners.length > 1) throw new Error("Multiple Codex renderer contexts own audio senders.");
    const instances = owners[0]?.instances;
    const selectedContextId = owners[0]?.contextId;
    if (!instances?.objects.objectId || selectedContextId === undefined) return null;
    let destinationInstances;
    let audioContextInstances;
    if (applyGraph) {
      const destinationPrototype = await call("Runtime.evaluate", { contextId: selectedContextId, expression: "MediaStreamAudioDestinationNode.prototype" });
      if (destinationPrototype.result.objectId) {
        const queried = await call("Runtime.queryObjects", { prototypeObjectId: destinationPrototype.result.objectId });
        destinationInstances = queried.objects.objectId;
      }
      const audioContextPrototype = await call("Runtime.evaluate", { contextId: selectedContextId, expression: "AudioContext.prototype" });
      if (audioContextPrototype.result.objectId) {
        const queried = await call("Runtime.queryObjects", { prototypeObjectId: audioContextPrototype.result.objectId });
        audioContextInstances = queried.objects.objectId;
      }
    }
    traceMark("sender-inspect-start", { targetIndex, mode: applyCable ? "cable" : applyPhysical ? "physical" : applyGraph ? "graph" : reconcilePhysical ? "reconcile" : "inspect" });
    const inspected = await call("Runtime.callFunctionOn", {
      objectId: instances.objects.objectId,
      functionDeclaration: `async function(mode, destinationNodes, audioContexts) {
        const peers = this.filter((peer) => ['connected', 'connecting'].includes(peer.connectionState));
        const rollback = globalThis.__codexBridgeAudioGraphRollback ?? globalThis.__codexBridgeAudioRollback;
        const peerEntries = peers.flatMap((peer) => peer.getSenders().map((sender) => ({ peer, sender })));
        const live = peerEntries
          .filter(({ sender }) => sender.track?.kind === 'audio' && sender.track.readyState === 'live');
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cable = devices.filter((device) => device.kind === 'audioinput' && device.label === 'CABLE Output (VB-Audio Virtual Cable)');
        const before = live.filter(({ sender }) => sender.track.getSettings?.().deviceId === cable[0]?.deviceId).length;
        const currentTrackLabel = live.length === 1 ? live[0].sender.track.label : undefined;
        const previousTrackLabel = mode === 'cable' ? currentTrackLabel : undefined;
        if (mode === 'cable') {
          const alreadyTarget = live.length === 1 && live[0].sender.track.getSettings?.().deviceId === cable[0]?.deviceId;
          if (live.length !== 1 || cable.length !== 1 || alreadyTarget || before === 1 || globalThis.__codexBridgeAudioRollback) {
            return { peers: peers.length, liveAudioSenders: live.length, cableDevices: cable.length, beforeCable: before, applied: false };
          }
          const replacement = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: cable[0].deviceId } } });
          const nextTrack = replacement.getAudioTracks()[0];
          if (!nextTrack || nextTrack.getSettings?.().deviceId !== cable[0].deviceId) {
            replacement.getTracks().forEach((track) => track.stop());
            throw new Error('Replacement capture track identity mismatch.');
          }
          const previous = live[0].sender.track;
          globalThis.__codexBridgeAudioRollback = { sender: live[0].sender, track: previous };
          try {
            await live[0].sender.replaceTrack(nextTrack);
          } catch (error) {
            delete globalThis.__codexBridgeAudioRollback;
            nextTrack.stop();
            throw error;
          }
        } else if (mode === 'graph') {
          const rollback = globalThis.__codexBridgeAudioRollback;
          const destinations = [...(destinationNodes ?? [])].filter((destination) =>
            destination.stream?.getAudioTracks?.().includes(rollback?.track));
          const allContexts = [...(audioContexts ?? [])].filter((context) => context.state !== 'closed');
          const contexts = allContexts.filter((context) => context.state === 'running');
          if (live.length !== 1 || before !== 1 || !rollback || rollback.sender !== live[0].sender ||
              rollback.track?.readyState !== 'live' || destinations.length > 1 || globalThis.__codexBridgeAudioGraphRollback) {
            return {
              peers: peers.length, liveAudioSenders: live.length, cableDevices: cable.length, beforeCable: before, applied: false,
              graphDestinationNodes: destinationNodes?.length ?? 0,
              graphMatchingDestinations: destinations.length,
              graphAudioContexts: contexts.length,
              graphNonClosedAudioContexts: allContexts.length,
              rollbackAvailable: Boolean(rollback),
            };
          }
          const cableStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: cable[0].deviceId } } });
          const cableTrack = cableStream.getAudioTracks()[0];
          if (!cableTrack || cableTrack.getSettings?.().deviceId !== cable[0].deviceId) {
            cableStream.getTracks().forEach((track) => track.stop());
            throw new Error('CABLE graph track identity mismatch.');
          }
          const ownedContext = destinations.length === 0 ? new AudioContext({ sampleRate: 48000 }) : undefined;
          if (ownedContext?.state === 'suspended') await ownedContext.resume();
          const destination = destinations[0] ?? ownedContext.createMediaStreamDestination();
          const source = destination.context.createMediaStreamSource(cableStream);
          source.connect(destination);
          const directCableTrack = live[0].sender.track;
          const graphTrack = destination.stream.getAudioTracks()[0];
          try {
            await live[0].sender.replaceTrack(graphTrack);
          } catch (error) {
            source.disconnect();
            cableStream.getTracks().forEach((track) => track.stop());
            throw error;
          }
          directCableTrack.stop();
          globalThis.__codexBridgeAudioGraphRollback = {
            source, stream: cableStream, sender: rollback.sender,
            originalTrack: rollback.track, graphTrack,
            destination: destinations.length === 0 ? destination : undefined,
            context: ownedContext,
            mode: destinations.length === 1 ? 'existing-destination' : 'isolated-destination',
          };
          delete globalThis.__codexBridgeAudioRollback;
        } else if (mode === 'physical') {
          const graphRollback = globalThis.__codexBridgeAudioGraphRollback;
          const directRollback = globalThis.__codexBridgeAudioRollback;
          const graphOwner = graphRollback && peerEntries.find(({ sender }) => sender === graphRollback.sender);
          const directOwner = directRollback && peerEntries.find(({ sender }) => sender === directRollback.sender);
          const graphUsable = Boolean(graphRollback && graphOwner?.sender.track === graphRollback.graphTrack && graphRollback.originalTrack?.readyState === 'live');
          const directUsable = Boolean(directRollback && directOwner && directRollback.track?.readyState === 'live');
          if (graphUsable) {
            const ownsIsolatedGraphTrack = graphRollback.graphTrack !== graphRollback.originalTrack;
            if (ownsIsolatedGraphTrack) await graphOwner.sender.replaceTrack(graphRollback.originalTrack);
            graphRollback.source.disconnect();
            graphRollback.stream.getTracks().forEach((track) => track.stop());
            // In existing-destination mode graphTrack is the Codex-owned
            // original sender track. Stopping it terminates the foreground
            // voice input after bridge cleanup.
            if (ownsIsolatedGraphTrack) graphRollback.graphTrack.stop();
            await graphRollback.context?.close();
            delete globalThis.__codexBridgeAudioGraphRollback;
            delete globalThis.__codexBridgeAudioRollback;
          } else if (directUsable) {
            const cableTrack = directOwner.sender.track;
            await directOwner.sender.replaceTrack(directRollback.track);
            cableTrack.stop();
            delete globalThis.__codexBridgeAudioRollback;
            // A failed earlier graph generation may coexist with the usable
            // direct marker. It no longer owns the sender and must not shadow
            // future cleanup attempts.
            if (graphRollback) {
              try { graphRollback.source?.disconnect(); } catch {}
              graphRollback.stream?.getTracks?.().forEach((track) => track.stop());
              if (graphRollback.graphTrack !== graphRollback.originalTrack &&
                  graphRollback.graphTrack !== cableTrack &&
                  graphRollback.graphTrack !== directRollback.track) graphRollback.graphTrack?.stop();
              try { await graphRollback.context?.close(); } catch {}
              delete globalThis.__codexBridgeAudioGraphRollback;
            }
          } else {
            return {
              peers: peers.length, liveAudioSenders: live.length, cableDevices: cable.length, beforeCable: before, applied: false,
              graphAttached: Boolean(graphRollback), rollbackPrepared: Boolean(graphRollback || directRollback),
              restoreOwnerFound: Boolean(graphOwner || directOwner), restoreTrackMatched: Boolean(graphUsable || directUsable),
              restoreOriginalLive: Boolean(graphRollback?.originalTrack?.readyState === 'live' || directRollback?.track?.readyState === 'live'),
            };
          }
        } else if (mode === 'reconcile') {
          // Renderer reloads can discard the in-memory rollback object while
          // leaving the bridge-owned CABLE track on the live sender. Recover
          // only that exact orphaned state, using the unchanged OS default
          // capture device. Never guess when another sender/route is present.
          const staleGraph = globalThis.__codexBridgeAudioGraphRollback;
          const staleDirect = globalThis.__codexBridgeAudioRollback;
          const graphOwner = staleGraph && peerEntries.find(({ sender }) => sender === staleGraph.sender);
          const directOwner = staleDirect && peerEntries.find(({ sender }) => sender === staleDirect.sender);
          const usableRollback = Boolean(
            (staleGraph && graphOwner?.sender.track === staleGraph.graphTrack && staleGraph.originalTrack?.readyState === 'live') ||
            (staleDirect && directOwner && staleDirect.track?.readyState === 'live')
          );
          if (live.length !== 1 || before !== 1 || usableRollback) {
            return {
              peers: peers.length, liveAudioSenders: live.length, cableDevices: cable.length, beforeCable: before, applied: false,
              graphAttached: Boolean(staleGraph), rollbackPrepared: Boolean(staleGraph || staleDirect),
              reconcileLiveSenderCount: live.length, reconcileCableSenderCount: before,
              reconcileRollbackUsable: usableRollback,
              restoreOwnerFound: Boolean(graphOwner || directOwner),
              restoreTrackMatched: Boolean(staleGraph && graphOwner?.sender.track === staleGraph.graphTrack),
              restoreOriginalLive: Boolean(staleGraph?.originalTrack?.readyState === 'live' || staleDirect?.track?.readyState === 'live'),
            };
          }
          const replacement = await navigator.mediaDevices.getUserMedia({ audio: true });
          const physicalTrack = replacement.getAudioTracks()[0];
          const physicalDeviceId = physicalTrack?.getSettings?.().deviceId;
          if (!physicalTrack || physicalTrack.readyState !== 'live' ||
              physicalDeviceId === cable[0]?.deviceId || physicalTrack.label === cable[0]?.label) {
            replacement.getTracks().forEach((track) => track.stop());
            throw new Error('Default capture device is not a unique non-CABLE physical input.');
          }
          const orphanedCableTrack = live[0].sender.track;
          await live[0].sender.replaceTrack(physicalTrack);
          orphanedCableTrack.stop();
          if (staleGraph) {
            try { staleGraph.source?.disconnect(); } catch {}
            staleGraph.stream?.getTracks?.().forEach((track) => track.stop());
            if (staleGraph.graphTrack !== staleGraph.originalTrack &&
                staleGraph.graphTrack !== orphanedCableTrack &&
                staleGraph.graphTrack !== physicalTrack) staleGraph.graphTrack?.stop();
            try { await staleGraph.context?.close(); } catch {}
            delete globalThis.__codexBridgeAudioGraphRollback;
          }
          if (staleDirect) {
            if (staleDirect.track !== physicalTrack) staleDirect.track?.stop();
            delete globalThis.__codexBridgeAudioRollback;
          }
        }
        const after = live.filter(({ sender }) => sender.track?.getSettings?.().deviceId === cable[0]?.deviceId).length;
        let outboundPacketsSent = 0;
        let outboundBytesSent = 0;
        let outboundAudioEnergy = 0;
        let outboundSamplesDuration = 0;
        let mediaSourceAudioLevel = 0;
        let mediaSourceAudioEnergy = 0;
        if (live.length === 1) {
          const stats = await live[0].sender.getStats().catch(() => null);
          for (const report of stats?.values?.() ?? []) {
            if (report.type === 'outbound-rtp' && report.kind === 'audio') {
              outboundPacketsSent += Number(report.packetsSent ?? 0);
              outboundBytesSent += Number(report.bytesSent ?? 0);
              outboundAudioEnergy += Number(report.totalAudioEnergy ?? 0);
              outboundSamplesDuration += Number(report.totalSamplesDuration ?? 0);
            }
            if (report.type === 'media-source' && report.kind === 'audio') {
              mediaSourceAudioLevel = Math.max(mediaSourceAudioLevel, Number(report.audioLevel ?? 0));
              mediaSourceAudioEnergy += Number(report.totalAudioEnergy ?? 0);
            }
          }
        }
        const graphAttached = Boolean(globalThis.__codexBridgeAudioGraphRollback);
        const graphRollback = globalThis.__codexBridgeAudioGraphRollback;
        const graphHealth = graphRollback ? {
          graphContextState: graphRollback.context?.state ?? graphRollback.destination?.context?.state,
          graphSourceTrackState: graphRollback.stream?.getAudioTracks?.()[0]?.readyState,
          graphDestinationTrackState: graphRollback.graphTrack?.readyState,
          graphSenderMatched: live.length === 1 && graphRollback.sender === live[0].sender && live[0].sender.track === graphRollback.graphTrack,
        } : {};
        const targetApplied = mode === 'cable' ? after === 1 : mode === 'graph' ? after === 0 && graphAttached : (mode === 'physical' || mode === 'reconcile') ? after === 0 && !graphAttached : false;
        return {
          peers: peers.length, liveAudioSenders: live.length, cableDevices: cable.length, beforeCable: before, afterCable: after,
          applied: mode !== 'inspect' && targetApplied, currentTrackLabel, previousTrackLabel,
          trackEnabled: live.length === 1 ? live[0].sender.track.enabled : undefined,
          trackMuted: live.length === 1 ? live[0].sender.track.muted : undefined,
          peerConnectionState: live.length === 1 ? live[0].peer.connectionState : undefined,
          outboundPacketsSent, outboundBytesSent, outboundAudioEnergy, outboundSamplesDuration,
          mediaSourceAudioLevel, mediaSourceAudioEnergy,
          rollbackPrepared: Boolean(globalThis.__codexBridgeAudioRollback) || graphAttached,
          graphAttached, graphMode: globalThis.__codexBridgeAudioGraphRollback?.mode,
          ...graphHealth,
        };
      }`,
      arguments: [
        { value: applyCable ? "cable" : applyPhysical ? "physical" : applyGraph ? "graph" : reconcilePhysical ? "reconcile" : "inspect" },
        destinationInstances ? { objectId: destinationInstances } : { value: null },
        audioContextInstances ? { objectId: audioContextInstances } : { value: null },
      ],
      awaitPromise: true,
      returnByValue: true,
    });
    traceMark("sender-inspect-complete", { targetIndex });
    return inspected.result.value ?? null;
  }).catch(() => null);
  traceMark("target-complete", { targetIndex, foundLiveSender: Boolean(result?.liveAudioSenders) });
  if (result?.liveAudioSenders || result?.rollbackAvailable) {
    candidates.push(result);
  }
}

const liveAudioSenders = candidates.reduce((sum, candidate) => sum + candidate.liveAudioSenders, 0);
const cableSenders = candidates.reduce((sum, candidate) => sum + (candidate.afterCable ?? candidate.beforeCable), 0);
const applied = candidates.some((candidate) => candidate.applied);
const graphAttached = candidates.some((candidate) => candidate.graphAttached);
const graphDestinationNodes = candidates.reduce((sum, candidate) => sum + (candidate.graphDestinationNodes ?? 0), 0);
const graphMatchingDestinations = candidates.reduce((sum, candidate) => sum + (candidate.graphMatchingDestinations ?? 0), 0);
const graphAudioContexts = candidates.reduce((sum, candidate) => sum + (candidate.graphAudioContexts ?? 0), 0);
const previousTrackLabels = [...new Set(candidates.map((candidate) => candidate.previousTrackLabel).filter(Boolean))];
const currentTrackLabels = [...new Set(candidates.map((candidate) => candidate.currentTrackLabel).filter(Boolean))];
const report = {
  candidateTargets: candidates.length,
  liveAudioSenders,
  cableSenders,
  physicalOrOtherSenders: liveAudioSenders - cableSenders,
  applied,
  graphAttached,
  graphDestinationNodes,
  graphMatchingDestinations,
  graphAudioContexts,
  graphMode: candidates.map((candidate) => candidate.graphMode).find(Boolean),
  graphContextState: candidates.map((candidate) => candidate.graphContextState).find(Boolean),
  graphSourceTrackState: candidates.map((candidate) => candidate.graphSourceTrackState).find(Boolean),
  graphDestinationTrackState: candidates.map((candidate) => candidate.graphDestinationTrackState).find(Boolean),
  graphSenderMatched: candidates.length === 1 ? candidates[0].graphSenderMatched : undefined,
  trackEnabled: candidates.length === 1 ? candidates[0].trackEnabled : undefined,
  trackMuted: candidates.length === 1 ? candidates[0].trackMuted : undefined,
  peerConnectionState: candidates.length === 1 ? candidates[0].peerConnectionState : undefined,
  outboundPacketsSent: candidates.reduce((sum, candidate) => sum + (candidate.outboundPacketsSent ?? 0), 0),
  outboundBytesSent: candidates.reduce((sum, candidate) => sum + (candidate.outboundBytesSent ?? 0), 0),
  outboundAudioEnergy: candidates.reduce((sum, candidate) => sum + (candidate.outboundAudioEnergy ?? 0), 0),
  outboundSamplesDuration: candidates.reduce((sum, candidate) => sum + (candidate.outboundSamplesDuration ?? 0), 0),
  mediaSourceAudioLevel: Math.max(0, ...candidates.map((candidate) => candidate.mediaSourceAudioLevel ?? 0)),
  mediaSourceAudioEnergy: candidates.reduce((sum, candidate) => sum + (candidate.mediaSourceAudioEnergy ?? 0), 0),
  rollbackAvailable: candidates.some((candidate) => candidate.rollbackPrepared || candidate.rollbackAvailable),
  restoreOwnerFound: candidates.length === 1 ? candidates[0].restoreOwnerFound : undefined,
  restoreTrackMatched: candidates.length === 1 ? candidates[0].restoreTrackMatched : undefined,
  restoreOriginalLive: candidates.length === 1 ? candidates[0].restoreOriginalLive : undefined,
  reconcileLiveSenderCount: candidates.length === 1 ? candidates[0].reconcileLiveSenderCount : undefined,
  reconcileCableSenderCount: candidates.length === 1 ? candidates[0].reconcileCableSenderCount : undefined,
  reconcileRollbackUsable: candidates.length === 1 ? candidates[0].reconcileRollbackUsable : undefined,
  currentTrackLabel: currentTrackLabels.length === 1 ? currentTrackLabels[0] : undefined,
  previousTrackLabel: previousTrackLabels.length === 1 ? previousTrackLabels[0] : undefined,
  exactCurrentCodexTask: scopedTargets.length >= 1,
  secretOutput: false,
  identifierOutput: false,
};
console.log(JSON.stringify(report));
if (
  liveAudioSenders !== 1 ||
  (applyCable && (!applied || cableSenders !== 1 || previousTrackLabels.length !== 1)) ||
  (applyGraph && (!applied || cableSenders !== 0 || !graphAttached)) ||
  ((applyPhysical || reconcilePhysical) && (!applied || cableSenders !== 0))
) process.exitCode = 1;
