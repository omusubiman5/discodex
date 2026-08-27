# Discord Voice operator runbook

This is the operator entry point for the direct-audio Discord bridge. The product is Discord audio connected to the **current GPT Live/Codex task**, not a standalone bot brain. This file is an operating procedure, not a status tracker.

## Document index

- Product and security policy: `PROJECT_POLICY.md`, `SAFETY_BOUNDARIES.md`
- Protocol design: `DISCORD_POC.md`, `DAVE_EVALUATION.md`, `MINIMAL_DESIGN.md`
- Local Discord setup: `DISCORD_LOCAL_SETUP.md`
- Canonical product boundary: `PROJECT_GOALS.md`, `MINIMAL_DESIGN.md`
- 4006 diagnosis: `DISCORD_VOICE_4006_CAUSE_INVESTIGATION.md`, `DISCORD_VOICE_4006_FIX_REPORT.md`
- Release trace: `DISCORD_VOICE_RELEASE_PLAN.md`

## Supported environments and prerequisites

| Requirement | Windows | macOS |
|---|---|---|
| OS | Windows 11 x64 | macOS 13+, Apple Silicon or Intel |
| Runtime | Node.js 26+, npm, ffmpeg | Node.js 26+, npm, ffmpeg |
| Native build | CMake, MSVC Build Tools, Windows SDK | Xcode Command Line Tools, CMake |
| Secret store | Current-user DPAPI provider | Login Keychain provider |
| Codex | Desktop signed in; target task already materialized | Desktop signed in; target task already materialized |
| Discord | Private guild/channel, dedicated application, minimal bot permissions | same |

Official `discord/libdave` is mandatory. Never fall back to plaintext, a private crypto implementation, a different GPT session, or an echo/fixed response.

## Install and preflight

From the repository root:

```powershell
npm install
npm test
npm run preflight:discord
npm run dry-run:discord
```

On macOS use the same commands in `zsh`. Install ffmpeg with the local package manager and verify `ffmpeg -version`. The native addon must be built for the current Node ABI and architecture. A missing addon, ffmpeg, credential, target, or DAVE capability is a fail-closed result.

On macOS set `CODEX_BRIDGE_LIBDAVE_ADDON_PATH` in the bridge process to the absolute path of the locally built/signed `.node` addon. Do not point it at an x64 binary on arm64 or vice versa. `MacosFfmpegOpusCodec` and `MacosKeychainCredentialProvider` are the production OS adapter boundaries; their unit passes are not a substitute for the real macOS E2E gate.

Build the pinned official library and addon on macOS from the repository root (replace `arm64-osx` with `x64-osx` on Intel):

```zsh
git -C work/dependency-probes/libdave submodule update --init --recursive
work/dependency-probes/libdave/cpp/vcpkg/bootstrap-vcpkg.sh -disableMetrics
make -C work/dependency-probes/libdave/cpp cclean
make -C work/dependency-probes/libdave/cpp BUILD_TYPE=Release
cmake -S work/node-native-binding-probe -B work/node-native-binding-probe/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DLIBDAVE_STATIC_LIBRARY="$PWD/work/dependency-probes/libdave/cpp/build/libdave.a" \
  -DCMAKE_TOOLCHAIN_FILE="$PWD/work/dependency-probes/libdave/cpp/vcpkg/scripts/buildsystems/vcpkg.cmake" \
  -DVCPKG_MANIFEST_DIR="$PWD/work/dependency-probes/libdave/cpp/vcpkg-alts/openssl_3" \
  -DVCPKG_TARGET_TRIPLET=arm64-osx
cmake --build work/node-native-binding-probe/build --config Release
export CODEX_BRIDGE_LIBDAVE_ADDON_PATH="$PWD/work/node-native-binding-probe/build/libdave_node_probe.node"
node -e 'const b=require(process.env.CODEX_BRIDGE_LIBDAVE_ADDON_PATH); if (!(b.maxProtocolVersion > 0 && b.sessionLifecycle())) process.exit(1)'
```

The addon resolves Node-API symbols with `GetProcAddress` on Windows and `dlsym(RTLD_DEFAULT, ...)` on macOS/POSIX. A successful Windows rebuild does not prove the macOS artifact; capture the macOS architecture, addon load, and lifecycle result in its real-host evidence.

Copy `config/bridge.example.json` to ignored `config/bridge.local.json` and fill only the allowlisted guild/channel/user identifiers. Never put the token in JSON, `.env`, argv, logs, or chat.

## Credentials

### Windows

Use `WindowsDpapiCredentialProvider.store()` from an interactive local setup process. It writes only current-user DPAPI ciphertext below `%LOCALAPPDATA%\CodexVoiceBridge\secrets`. The running bridge reads it through a scoped lease and clears its in-process reference on disposal.

### macOS

Create a generic password named `codex-discord-voice-bridge.bot-token` for account `discord-bot` in the login Keychain. Use Keychain Access, or run `/usr/bin/security add-generic-password -U -s codex-discord-voice-bridge.bot-token -a discord-bot -w` interactively so the secret is not placed in argv. The bridge uses `MacosKeychainCredentialProvider` and `/usr/bin/security find-generic-password -w`; stdout is held only for the scoped lease.

Rotate a leaked token in Discord Developer Portal first, replace the local secret, verify the old token is rejected, then restart. Do not include either token in evidence.

## Current Codex task binding

The Windows product path is a non-owning attachment to the one already-active Codex realtime call. `CODEX_THREAD_ID` is verified against the current Desktop task, but the bridge never sends `thread/realtime/start`, `thread/realtime/stop`, or `thread/realtime/reconnect`. Discord audio is rendered to `CABLE Input`; the existing Codex WebRTC audio sender is switched with `RTCRtpSender.replaceTrack()` to the exact `CABLE Output` capture device. Codex process-loopback output is captured from the exact Desktop process tree and returned to Discord.

This path contains no alternate STT/text/TTS pipeline, fixed response, echo brain, second ChatGPT conversation, or second task. The old owned-realtime and text-agent paths remain regression surfaces only and are rejected by the logged runner's source gate.

## Start, join, status, leave, and stop

1. Confirm no recorded `runtime/live-call.lock` owner is alive. Remove a stale lock only through the built-in lock acquisition path.
2. Confirm the target private channel and allowlist, credential provider, native libdave, VB-CABLE endpoints, and exact current Codex task binding.
3. Confirm exactly one active Codex WebRTC audio sender exists and is still using a non-CABLE input. Set `CODEX_THREAD_ID` and the numeric-loopback `CODEX_DESKTOP_DEBUGGER_ENDPOINT`, then start exactly one runner with `scripts/run-meetron-windows-live-logged.ps1`.
4. The wrapper atomically changes only that call's sender to `CABLE Output`, launches the locked runner, and restores the original physical input in `finally`. It never changes Windows Console, Multimedia, or Communications defaults. No active sender, multiple senders, an identity mismatch, or an unrecoverable prior route fails before Discord networking.
5. A ready status requires exact task identity, the per-call CABLE sender, Discord join, UDP discovery, and DAVE active. Bot presence or transport counters alone are not ready evidence.
5. Status output may contain state names and bounded counts only. It must not contain tokens, identifiers, transcripts, audio, MLS payloads, or keys.
6. Stop in this order: block new Discord output, send the five Discord Opus silence frames and Speaking=0, leave Discord voice, close UDP/Gateway, destroy DAVE state, stop the Windows audio host, restore the original per-call physical input track, release credential lease and runner lock. The foreground Codex realtime call remains active throughout.

The runner emits sanitized state and bounded frame/level counters. A causal product turn requires an external Discord SSRC, authenticated DAVE decrypt, non-silent PCM written to the cable, a new Codex output interval after that input interval, non-silent process-loopback PCM, Opus/DAVE/RTP send, and intelligible playback at the external Discord participant. Counters without source isolation, old Codex output, self-loop audio, or a response caused by a physical microphone are not acceptance evidence.

## Barge-in and reconnect

Discord input is continuously routed to the existing Codex sender; Codex owns its realtime VAD, turn boundaries, and barge-in. The bridge never calls a Codex realtime lifecycle method.

For one recoverable Discord Voice WebSocket interruption, send Voice Resume opcode 7 with the same Voice session and last `seq_ack`, accept opcode 9 Resumed, and retain UDP/DAVE media state. Recovery is bounded to one attempt; another failure stops the bridge without touching the Codex call. Participant rejoin replaces its SSRC mapping and DAVE decrypt context. A DAVE epoch transition greater than one preserves the MLS group, processes the new commit/welcome, and activates only the matching prepared transition. Outbound and per-SSRC inbound Opus codecs persist for the media stream; speech end sends five Opus silence frames before Speaking=0.

## Logs and health

Healthy runtime state is one runner lock, one direct-audio bridge, one verified Codex task binding, one Discord voice session, one UDP media socket, and DAVE active. Logs are JSONL state transitions only and must pass redaction tests. Check process/lock/socket identity together; a lock file alone is not health.

Treat these as unhealthy: stale PID, overlapping runner, occupied-target discovery timeout, Voice close, repeated reconnect, missing output audio, `codex-input-failed`, missing exact-task lifecycle stages, mismatched Codex turn notifications, active-writer from a second app-server, plaintext fallback, or any secret/identifier/audio bytes in output. An occupied-target timeout is a Discord presence gate, not a silent-microphone diagnosis; do not relaunch repeatedly or create a second runner.

## 4006 and common failures

| Symptom | Direct check | Recovery |
|---|---|---|
| Voice close 4006 | Compare runner PID, lock owner, and Voice session creation time | stop the superseded process, acquire one lock, request a fresh handoff |
| UDP received but no DAVE decrypt | Verify RTP extension/AAD parsing and current ratchet | fail closed; rebuild/restart after transport regression passes |
| Codex active-writer conflict | Confirm a second app-server was spawned | attach through the Desktop-owned injected RPC transport; never fork |
| DAVE transition failure | Inspect sanitized opcode/state only | leave, destroy native state, fresh join; no plaintext fallback |
| No Codex audio output | Confirm the exact-task WebRTC receiver, direct-audio sink, non-silent PCM, and Discord RTP send markers | restore the same direct route; do not substitute text/TTS, echo, or a standalone model |
| macOS Keychain denied | Run a local `security find-generic-password` check as the same user | unlock/authorize login Keychain, then retry the same issue |

See the two 4006 documents in the index for the corrected race analysis. Zero 4006 is transport health, not product completion.

## Rollback and upgrade

Before upgrade, record the current Node ABI, pinned libdave commit, addon architecture, Codex Desktop/app-server protocol schema, ffmpeg version, and passing regression commands without secrets. Stop the bridge cleanly and preserve the prior native addon/package lock.

Upgrade one boundary at a time: Node dependencies, libdave/native addon, Codex Desktop WebRTC attachment, then the Windows audio host. Rebuild and run unit/transport regressions after each. Runtime rollback stops only the bridge, restores the original per-call physical input track, and verifies Windows global capture defaults were unchanged. Package rollback restores the prior package lock/native addon and reruns tests before a fresh Discord/DAVE join. Never stop/restart the foreground Codex realtime call, and never roll back to plaintext, an unpinned libdave build, or an alternate speech/text/TTS path.

## Real E2E acceptance

Run only after all internal implementation gates pass. Perform the same observable matrix on Windows and macOS with a separate verifier:

1. Fresh setup/install and OS secret retrieval under the intended user.
2. Start from a materialized current Codex task; verify the exact task identity and existing context are retained.
3. Join the private Discord channel and exchange real participant speech in both directions.
4. Ask a context-dependent question and invoke an existing skill/tool; observe the same task use its prior context and capability.
5. Barge in during output and observe queued Discord speech stop promptly, with the next utterance handled.
6. Exercise explicit stop and verify Voice leave, zero further audio, disposed secrets, destroyed DAVE state, and released lock.
7. Restart and force one recoverable network interruption; verify reconnect uses the same task and fresh Discord/DAVE state.
8. Review sanitized logs and health; no secret, identifier, transcript, raw audio, key, or plaintext fallback may appear.

### Verified mobile Discord clients

| Client | Verified result | Evidence scope |
| --- | --- | --- |
| Android / Pixel | Bidirectional Discord speech → Codex → Discord response; multi-turn conversation | Windows-hosted Discodex live E2E |
| iPhone / official Discord iOS client | Bidirectional Discord speech → Codex → Discord response | Live E2E confirmed on 2026-08-26 |

Do not downgrade the iPhone result to connection-only: bidirectional voice was explicitly accepted. Conversely, do not infer unrecorded device-specific endurance, reconnect, or audio-quality results from the bidirectional acceptance alone.

Windows-only, macOS-only, unit tests, Bot presence, audible echo, fixed responses, transport counters, or zero 4006 cannot close the product acceptance requirements.
