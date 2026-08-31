# Project goals

## Discord Voice entry {#discord-voice-entry}

The primary user journey is: a user joins a private Discord voice channel from a phone, speaks to the bridge running on a Windows or macOS workstation, and receives the Codex Voice response through Discord.

```project-goal
{"goal_id":"codex-discord-voice-entry","project_id":"codex-discord-voice-bridge","objective":"Private Discord voiceからWindows/macOS上のCodex Voiceへ安全な双方向音声入口を提供する","acceptance_conditions":["official libdaveのみを使う","credentialを会話・ログ・Gitへ露出しない","WindowsとmacOSでDAVE暗号化join/send/receiveを検証する","独立監査PASSを記録する"],"state":"in_progress","evidence":["git:a88e356","test:capi-9-of-9","test:node-native-load-session-pass","test:cycle0-metadata-remediation","test:native-addon-loader-pass"],"source_file":"PROJECT_GOALS.md","source_anchor":"discord-voice-entry"}
```

Project repository: `C:\Projects\codex-discord-voice-bridge`

Current evidence:

- Common core and fail-closed DAVE session tests: `npm test`, 36/36 passing at commit `a88e356`.
- Official `discord/libdave` source is fixed at `52cd56dc550f447fb354b3a06c9e2d2e2a4309c6`.
- Windows static build completed with MSVC 19.44 and Windows SDK 10.0.26100.0.
- Official C API executable passed 9/9.
- A thin N-API feasibility addon loads the official library, reports protocol version 1, and completes a session lifecycle.
- Credentials and external Discord access are deliberately outside those probes.

Release completion conditions:

1. The production Node binding safely marshals MLS messages and Opus frames through official libdave; no custom cryptography is permitted.
2. Main Gateway and Voice Gateway correlation, heartbeat/resume, UDP discovery, DAVE transition, and fail-closed audio gating pass deterministic tests.
3. A local secret provider supplies credentials without committing, logging, or placing tokens in conversation; guild/user/channel allowlists deny by default.
4. One bounded DAVE-encrypted join/send/receive smoke test succeeds in the private test channel on Windows, followed by the equivalent macOS adapter check.
5. Audit events contain no Discord identifiers or secrets, and an independent audit records PASS.
