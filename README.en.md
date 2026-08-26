# 🎙️ Discodex — Codex Discord Voice Bridge ✨

🌸 [日本語](README.md)

Discodex is a local voice bridge that lets you **call GPT Live (Codex Voice) from Discord on your phone**, then start, connect to, and operate the current Codex task on your home or workstation computer. It does not create a separate chatbot—Discord becomes a remote entry point to GPT Live. 📱↔️💻

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
| 🍎 macOS | 🚧 Partial | Keychain, ffmpeg Opus/PCM adapter, POSIX native-addon loader, and shared core |

The macOS components and automated tests are implemented, but the Core Audio live-call runner and real-Mac end-to-end acceptance are not complete. This release therefore does not claim full Windows and macOS support.

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
- A Discord bot and a private Discord server
- A native addon backed by Discord's official DAVE implementation
- Codex Desktop and the target Voice Talk task
- 🪟 Windows: VB-CABLE, ffmpeg, and PowerShell
- 🍎 macOS: ffmpeg and Keychain; the live-call runner is still in development

## 🛠️ Setup

Never store secrets in the repository. Production credentials use DPAPI on Windows and Keychain on macOS. 🔑

```powershell
git clone <repository-url>
cd codex-discord-voice-bridge
npm ci
npm test
npm run preflight:discord
```

For Windows production operation, see the 📘 [operations runbook](docs/DISCORD_VOICE_RUNBOOK.md) and ⚙️ [local Discord setup](docs/DISCORD_LOCAL_SETUP.md).

## 💬 Discord commands

| Command | Behavior |
| --- | --- |
| `/connect` | Connect the approved voice channel to Codex Voice |
| `/disconnect` | Safely stop only bridge-owned routing |
| `/status` | Report connection, audio-route, and DAVE state |
| `/gain` | Adjust return audio within the approved range |

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

See 🛡️ [Safety Boundaries](docs/SAFETY_BOUNDARIES.md) for details.

## 📜 Licenses

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party components and license notices.
