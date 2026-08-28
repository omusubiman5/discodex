# 🎙️ Discodex — Codex Discord Voice Bridge ✨

🌸 [日本語](README.md)

Discodex is a local voice bridge that lets you **call GPT Live (Codex Voice) from Discord on your phone**, then start, connect to, and operate the current Codex task on your home or workstation computer. It does not create a separate chatbot—Discord becomes a remote entry point to GPT Live. 📱↔️💻

## 🧠 Project Raphael

Discodex is the Discord connection module for **Project Raphael**, an AI Gaming Life Companion platform supporting the human DISCORDER. The single canonical brief covers in-game guidance, onboarding, recording and esports coaching, authorized external work, HAOS, the Healthcare Adapter, safety boundaries, and the Discord partnership request.

➡️ **[Read the Project Raphael concept, complete experience, and execution policy](docs/PROJECT_RAPHAEL.md)**

## 🌟 Highlights

- 📱 Call GPT Live (Codex Voice) from Discord on your phone
- 🚀 Prepare Codex Voice and attach to the same task with Discord `/connect`
- 🎛️ Bounded remote controls through `/disconnect`, `/status`, and `/gain`
- 🔊 Route Discord speech into Codex and return Codex audio to the same call
- 🧑‍🏫 Ask Codex to facilitate a meeting with agenda guidance, topic organization, and summaries
- 🔐 Restrict access with a private server, guild/channel/user allowlists, and least privilege
- 🛡️ Require Discord's official `libdave`; reject plaintext fallback and custom cryptography
- 🧼 Fail closed without logging tokens, Discord IDs, or transcript content
- 🧵 Attach to the selected task in the existing Codex Desktop session

> 📝 Meeting facilitation is supported conversationally. Strict automatic speaker identification and automatic minutes storage are separate capabilities.

## 🖥️ Platform status

| Platform | Status | Included |
| --- | --- | --- |
| 🪟 Windows | ✅ Supported | Discord controls, Codex Desktop attachment, VB-CABLE routing, Relay UI, and live-call runner |
| 🍎 macOS | 🧪 Awaiting real-Mac acceptance | BlackHole/Core Audio route, sender rollback, production runner, Keychain, and libdave build |
| 🐧 Ubuntu | ⏳ Planned | Development and real-device validation will begin after GPT Live (Voice in Work/Codex) officially supports Ubuntu |

The macOS live-call path is implemented, but real-Mac end-to-end acceptance is not complete. This release does not claim macOS support until the acceptance matrix passes. See the [macOS E2E Runbook](docs/MACOS_E2E_RUNBOOK.md).

The Discord/DAVE/Opus foundation is technically portable to Ubuntu, but GPT Live (Voice in Work/Codex) is not currently offered as an official Ubuntu/Linux desktop capability. Discodex therefore does not support Ubuntu yet. Linux audio routing and real E2E validation are planned after [official Ubuntu support becomes available](https://help.openai.com/en/articles/20001275/). Confirmed technical gaps are consolidated in the [Ubuntu section of the technical and operations runbook](docs/DISCORD_VOICE_RUNBOOK.md#ubuntu-linux-support).

### 📱 Real-device smartphone checks

- Android (Pixel): bidirectional live voice between Discord and the same Codex Voice task verified
- iPhone (official Discord iOS client): bidirectional live voice between Discord and the same Codex Voice task verified on 2026-08-26

On both Pixel and iPhone, Discord speech reached Codex and the Codex response audio returned through Discord. Multi-turn conversation was also verified on Pixel. This does not automatically claim device-specific endurance or audio-quality checks that were not separately performed.

## 🔁 Data flow

```text
📱 Discord on a phone
  ↕ Discord Voice / DAVE
🌉 Discodex local bridge on the computer
  ↕ OS audio adapter + Codex Desktop attachment
🤖 Current Codex Voice task
```

## 📦 Requirements

- Node.js 26 or later
- A dedicated Application/Bot created in the Discord Developer Portal, plus its Bot Token
- A private Discord server with one text control channel and one voice channel
- A native addon backed by Discord's official DAVE implementation
- Codex Desktop and the target Voice Talk task
- 🪟 Windows: VB-CABLE, ffmpeg, and PowerShell
- 🍎 macOS: ffmpeg and Keychain; the live-call runner is still in development
- 🐧 Ubuntu: waiting for official GPT Live (Voice in Work/Codex) support; currently unsupported

### 🤖 Required Discord Developer setup

Cloning the repository alone cannot connect to Discord. Create one dedicated Application in the [Discord Developer Portal](https://discord.com/developers/applications), add a bot user and issue its Bot Token on the `Bot` page, then install it into your private server from `Installation`.

| Item | Required setting |
| --- | --- |
| Install scopes | `bot`, `applications.commands` |
| Bot channel permissions | `VIEW_CHANNEL`, `CONNECT`, `SPEAK`, `SEND_MESSAGES`, `READ_MESSAGE_HISTORY` |
| Operator permission | `USE_APPLICATION_COMMANDS` in the text control channel |
| Privileged Gateway Intents | None; leave all of them disabled |
| IDs stored in local config | guild, voice channel, text channel, and allowlisted Discord user |
| Secret | Bot Token only; store it in DPAPI on Windows or Keychain on macOS |

No separate “Discord API key,” Client Secret, OAuth user token, Webhook URL, or Interactions Endpoint URL is required. The Application ID is resolved from Discord together with the bot identity at startup and is not entered manually. Only the four IDs copied with Discord Developer Mode belong in the Git-ignored `config/bridge.local.json`.

Discodex uses Discord REST API v10 to register and read back guild commands, Gateway for interactions and voice state, and Voice Gateway v8 with UDP, Opus, and official DAVE for calls. After control starts, `/connect`, `/disconnect`, `/status`, and `/gain` are registered in the target guild.

Official setup references: [Build your first Discord bot](https://docs.discord.com/developers/quick-start/getting-started) · [OAuth2 and permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions) · [Voice connections](https://docs.discord.com/developers/topics/voice-connections)

## 🛠️ Installation

Never store secrets in the repository. Production credentials use DPAPI on Windows and Keychain on macOS. 🔑

```powershell
git clone https://github.com/omusubiman5/discodex.git
cd discodex
npm ci
npm test
npm run preflight:discord
```

Grant the bot only the least-privilege permissions listed above. Put the guild, voice/text channel, and allowlisted user IDs in the ignored `config/bridge.local.json`. Store the bot token in DPAPI on Windows or Login Keychain on macOS—never in JSON, `.env`, command-line arguments, logs, or chat.

Configuration, credentials, official libdave, and diagnosis are consolidated in the bilingual 📘 [technical and operations runbook](docs/DISCORD_VOICE_RUNBOOK.md). Normal connection and recovery remain below so users do not need to assemble the basic workflow from separate documents.

## 🪟 Prepare Discodex Relay on Windows

**Discodex Relay** is the PC-side control app. It is not an always-on service; the user starts it only when needed.

### Where to get VB-CABLE and how it is licensed

**This section applies only to Discodex on Windows. The macOS path uses BlackHole 2ch and does not require VB-CABLE.** Windows uses VB-Audio Software's standard **VB-CABLE for Windows** as an external audio driver. VB-CABLE is not distributed under MIT or another open-source license; its official classification is **Donationware Simple**. Discodex does not bundle VB-CABLE in this repository, releases, or installers. Each user must obtain it directly from VB-Audio and accept VB-Audio's terms.

| Item | Details |
| --- | --- |
| Official download and installation | [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) |
| Licensing policy | [VB-Audio Licensing](https://vb-audio.com/Services/licensing.htm) |
| Standard Windows license purchase | [VB-CABLE Windows WebShop](https://shop.vb-audio.com/en/win-apps/11-vb-cable.html) |
| OS scope | **Windows only**. VB-CABLE is not a requirement for Discodex on macOS. |
| Displayed price on August 28, 2026 | **US$5.00 per license** for standard VB-CABLE for Windows, as displayed by the official WebShop in USD. |
| Volume prices on that date | 10 licenses: US$4.17 each; 100: US$3.61; 1,000: US$2.92; 10,000: US$2.50. |
| Payment model | Donationware with a selectable contribution, not a monthly subscription. There is no recurring charge. |
| Individual evaluation | All functions can be evaluated, with license payment expected when the software is useful. This is not an open-source license such as MIT. |
| Professional, business, organization, or server use | VB-Audio requires a paid license. Purchase for the applicable number of users or PCs; consult volume licensing for larger deployments. |
| Redistribution | Discodex does not redistribute it. Bundling or redistributing VB-CABLE with another product is subject to VB-Audio's separate distribution conditions. |

One standard VB-CABLE license is sufficient for Discodex on one personal Windows PC. The paid-download **VB-CABLE A+B / C+D** packages are not required and have different purchase and redistribution rules. Prices, tax, exchange rates, license scope, PC changes, and replacement-download terms may change; always confirm the official WebShop at checkout.

1. Install Node.js 26+, ffmpeg, VB-CABLE, and Codex Desktop.
2. Build the Relay entry point from the repository root:

   ```powershell
   npm run build:relay:windows
   ```

3. Double-click `dist\Discodex Relay.lnk`.
4. If the main button says `Prepare Codex`, press it once. Relay performs the required Codex preparation and safety checks. If it says `Start Relay`, press it once.
5. Confirm the equivalent of `RELAY READY / VOICE DISCONNECTED / CODEX ROUTE READY`. Starting Relay alone does not join Discord Voice.
6. Set `GPT Live → Discord output volume` between 25% and 100%, then press `Apply`. The default is 50%, and the setting affects only Codex audio sent to Discord.

Discodex does not change the Windows default microphone or speaker.

## 📱 Connect from Discord

1. Open the target Codex task on the PC and make Discodex Relay `READY`.
2. Run `/status` in the allowlisted Discord text channel. Confirm it is disconnected without a degraded state.
3. Run `/connect` once in the same channel. Discodex validates the exact Codex task, single runner/lock, Discord Voice Ready, and DAVE before replying `Connected.`
4. Join the allowlisted voice channel from the phone and speak normally.

Do not repeatedly submit `/connect`. If it fails, use the specific returned failure and `/status` to identify the failed gate.

## 🖥️ Return audio and microphone control to the PC

When the Discord call is finished and you want to use Codex Voice on the PC again:

1. Run `/disconnect` once in the allowlisted Discord text channel.
2. Wait for the `Disconnected.` response.
3. Discodex leaves Discord Voice, restores Codex playback on the PC, restores the original physical microphone, and releases the runner/lock. Codex Desktop and the current task remain open.
4. Only if you also want to stop command control, press `Stop Relay` in the Relay app after restoration.

| Action | Purpose |
| --- | --- |
| Discord `/disconnect` | End the call and restore PC audio plus the physical microphone |
| Relay `Stop Relay` | Stop Discord command control after restoration |

Relay refuses to close or stop control while a runner or lock is active. Use `/disconnect` first.

## 🍎 macOS acceptance testing

The macOS 13+ implementation for Apple Silicon and Intel is complete and is now **awaiting final acceptance on a real Mac**. It includes:

- A dedicated Core Audio host that selects BlackHole 2ch without changing the macOS system defaults
- Exact-task WebRTC sender replacement with physical-microphone rollback on `/disconnect` or failure
- A macOS production runner, Login Keychain token provider, and official-libdave builds for Apple Silicon and Intel
- An E2E evidence verifier for DAVE, bidirectional audio, two round trips, ratchet/epoch activity, and log sanitation

The Windows-only VB-CABLE path is not used on macOS. The Mac path is **BlackHole 2ch + Core Audio**. Windows automation cannot replace real-Mac acceptance, so macOS will not be marked equivalent to the Windows release until the gates below pass.

### Requirements

- macOS 13 or later and Node.js 26 or later
- BlackHole 2ch at 48,000 Hz/stereo, ffmpeg, Xcode Command Line Tools, and CMake
- Microphone permission for Codex Desktop
- The Discord bot token stored in Login Keychain
- `runtime/meetron-macos-live.json`, copied from `config/meetron-macos-live.example.json`, containing only the approved Discord IDs

### First build and automated checks

```zsh
git clone https://github.com/omusubiman5/discodex.git
cd discodex
npm ci
zsh scripts/build-libdave-addon-macos.sh
npm run build:coreaudio:macos
npm test
npm run test:acceptance
```

### Start Codex and the bridge

Launch Codex with loopback-only CDP, open the exact task under test, and start Voice Talk.

```zsh
open -na "Codex" --args --remote-debugging-address=127.0.0.1 --remote-debugging-port=9224
mkdir -p outputs
zsh scripts/run-discodex-macos.sh EXACT_CODEX_TASK_ID 2>&1 | tee outputs/macos-live-e2e.jsonl
```

Run `/status` and then `/connect` in the allowlisted Discord text channel. After testing, run `/disconnect`, press `Ctrl-C` in the terminal, and verify the evidence:

```zsh
node scripts/verify-macos-e2e-evidence.mjs outputs/macos-live-e2e.jsonl
```

### Real-Mac acceptance gates

- External Discord speech reaches only the selected Codex task
- The causally corresponding Codex voice response returns to Discord
- At least two round trips, barge-in, and voice-channel rejoin succeed
- DAVE remains enabled, with no leakage, physical-microphone contamination, feedback, or clipping
- `/disconnect` leaves Codex Voice alive and restores the physical microphone, runner, and lock
- The E2E evidence verifier passes without tokens, Discord IDs, transcript text, or audio data in logs

See the [macOS E2E Runbook](docs/MACOS_E2E_RUNBOOK.md) for Keychain setup, configuration, recovery, and the full acceptance matrix.

When reporting results, include only:

- Mac model (Apple Silicon or Intel), macOS, Node.js, and ffmpeg versions
- The failed command and a sanitized error without tokens, Discord IDs, or transcript content
- Whether testing reached automated checks or a real Discord call

Never post tokens, Discord IDs, invite URLs, transcripts, or audio data in an issue or chat.

## 💬 Discord commands

| Command | Behavior |
| --- | --- |
| `/connect` | Connect the approved voice channel to Codex Voice |
| `/disconnect` | Safely stop only bridge-owned routing |
| `/status` | Report connection, audio-route, and DAVE state |
| `/gain` | Adjust return audio within the approved range |

On Windows, the same output gain is also available from the Discodex Relay slider.

## 🧪 Verification

```powershell
npm test
npm run test:acceptance
npm run preflight:discord
npm run dry-run:discord
```

Automated tests use no real credentials or external sockets. They cover safety boundaries, Discord controls, DAVE, audio codecs, the Windows Relay, and macOS adapters. Product acceptance still requires OS-specific end-to-end evidence.

## 🔒 Security boundaries

- Never store the bot token in configuration, logs, or Git
- Never emit Discord IDs, invite URLs, audio, or transcript text in audit logs
- Reject commands outside the configured guild, channel, and user allowlists
- Reject disabled DAVE, plaintext fallback, and alternate AI-session substitution
- Stopping the bridge must not stop Codex Desktop or the current task

See the 🛡️ [security policy in the technical and operations runbook](docs/DISCORD_VOICE_RUNBOOK.md#security-policy) for details.

## 📜 Licenses

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party components and license notices.
