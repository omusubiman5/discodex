# macOS implementation and live-E2E handoff

Status: implementation candidate complete; real-Mac acceptance is still required before macOS is marked supported.

## Implemented path

```text
Discord Opus/DAVE → PCM → discodex-coreaudio-host → exact BlackHole 2ch output
  → BlackHole 2ch Chromium input → exact foreground Codex WebRTC sender

Exact Codex WebRTC receiver → PCM → Opus/DAVE → Discord
```

The bridge never changes the global macOS input or output defaults. It selects one exact Core Audio device in its own host process, replaces only the selected Codex call sender, retains the original live track, and restores that track during `/disconnect` or failure cleanup.

## One-time Mac setup

1. Use macOS 13 or later and install Node.js 26+, Xcode Command Line Tools, CMake, ffmpeg, `pkg-config`, GNU make, and the official BlackHole 2ch driver. With Homebrew: `brew install cmake ffmpeg pkg-config make`.
   The build checks that `make --version` reports GNU Make. If it does not, select Homebrew GNU make before the build: `export PATH="$(brew --prefix make)/libexec/gnubin:$PATH"`.
2. Confirm Audio MIDI Setup shows exactly one device named `BlackHole 2ch`, configured for 48,000 Hz and two channels.
3. Keep the physical microphone as the macOS default input. The bridge selects BlackHole only for the exact Codex call.
4. Grant Codex Desktop microphone permission. Do not grant the terminal broader audio permissions unless macOS requests them for the bridge host.
5. Store the Discord token in Login Keychain under service `codex-discord-voice-bridge.bot-token`, account `discord-bot`.
6. Copy `config/meetron-macos-live.example.json` to `runtime/meetron-macos-live.json` and replace only the two non-secret Discord IDs.

[BlackHole's official repository](https://github.com/ExistentialAudio/BlackHole) documents the 2-channel Homebrew package as `brew install blackhole-2ch`.

## Build gates

From the repository root on the Mac:

```zsh
zsh scripts/build-libdave-addon-macos.sh
npm ci
npm test
npm run build:coreaudio:macos
npm run build:relay:macos
```

The libdave script checks out only commit `52cd56dc550f447fb354b3a06c9e2d2e2a4309c6`, initializes its pinned vcpkg submodule, builds the official C API and tests, builds the Node addon for the current architecture/ABI, and loads its lifecycle probe. Do not continue after any failed gate.

## Prepare Codex Desktop and start Relay

Store the exact task UUID once in `runtime/discodex-relay.thread-id`, matching the Windows Relay configuration. Open the target task in Codex Desktop, then double-click:

```zsh
dist/Discodex Relay.app
```

Press `Prepare Codex` or `Start Relay` and wait for `RELAY READY`. Relay owns the bounded Codex restart, loopback-only CDP launch, command-control process, and sanitized evidence files. Normal operation requires no Terminal command or task-ID argument.

In the allowlisted Discord text channel, run `/status`, then `/connect`. The control must not report `Connected.` until Voice Ready, UDP discovery, DAVE Execute Transition, Core Audio host startup, and exact-task attachment have all passed.

## Tonight's observable acceptance

Perform all items; connection alone is not acceptance.

1. Speak from an external Discord client and confirm the exact open Codex task receives the words.
2. Confirm the causally corresponding Codex voice response is audible in Discord.
3. Complete at least two turns, then test barge-in once.
4. Leave and rejoin the Discord voice channel; confirm the new SSRC/ratchet is used.
5. Cause one recoverable Voice WebSocket interruption if practical and confirm only one bounded Resume occurs.
6. Confirm there is no physical-microphone contamination, desktop-audio leakage, feedback, or clipping.
7. Run `/disconnect`; confirm Codex Voice remains alive and its physical microphone works again.
8. Confirm the runner exits, `runtime/live-call.lock` disappears, and no RTP is sent afterward.

After `/disconnect` has fully restored the route, close Discodex Relay. It stops command control only after confirming that no voice runner or lock remains.

Then run:

```zsh
node scripts/verify-macos-e2e-evidence.mjs "$(ls -t outputs/discord-production-control-macos-*.jsonl | head -1)"
```

The verifier requires DAVE decrypt, PCM generation, Codex input/output, Discord response send, ratchet/epoch activity, two causal round trips, zero Codex input failures, and sanitation markers. Audible quality, contamination, barge-in, and route restoration remain human-observed gates and must be recorded separately.

## Fail-closed recovery

- If attach fails, do not change global Sound settings to force it. Verify the exact `BlackHole 2ch` name, 48 kHz format, Codex microphone permission, and one foreground Voice Talk sender.
- If the native host fails, stop and rebuild it; do not substitute ffplay, system audio capture, text/TTS, or plaintext Discord audio.
- If restore fails, leave Discord, stop the control, and select the physical microphone inside a fresh Codex Voice call before retrying. Do not claim acceptance until automatic rollback passes.
