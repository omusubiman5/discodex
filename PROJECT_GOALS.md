# Project goals

## Discord Voice entry {#discord-voice-entry}

The primary user journey is: a user joins a private Discord voice channel from a phone, speaks to the bridge running on a Windows or macOS workstation, and receives the PM Codex voice response through Discord. Google Meet remains only a future transport adapter candidate.

```pm-parent-goal
{"goal_id":"codex-discord-voice-entry","project_id":"codex-discord-voice-bridge","objective":"Private Discord voiceからWindows/macOS上のPM Codexへ安全な双方向音声入口を提供する","acceptance_conditions":["official libdaveのみを使う","credentialを会話・ログ・Gitへ露出しない","WindowsとmacOSでDAVE暗号化join/send/receiveを検証する","独立監査PASSを記録する"],"state":"in_progress","evidence":["git:a88e356","bead:cdvb-enj.31:capi-9-of-9","bead:cdvb-enj.32:node-native-load-session-pass","docs/BEADS_RUN_RESULT.md","bead:cdvb-enj.36:cycle0-metadata-remediation","bead:cdvb-enj.37:native-addon-loader-pass"],"source_file":"PROJECT_GOALS.md","source_anchor":"discord-voice-entry","expected_blob_sha":"7e5ac918e5033eccc8489631750e3684a1d71f9c","epic_issue_id":"cdvb-enj","child_issue_ids":["cdvb-enj.1","cdvb-enj.2","cdvb-enj.3","cdvb-enj.4","cdvb-enj.5","cdvb-enj.6","cdvb-enj.7","cdvb-enj.8","cdvb-enj.9","cdvb-enj.10","cdvb-enj.11","cdvb-enj.12","cdvb-enj.13","cdvb-enj.14","cdvb-enj.15","cdvb-enj.16","cdvb-enj.17","cdvb-enj.18","cdvb-enj.19","cdvb-enj.20","cdvb-enj.21","cdvb-enj.22","cdvb-enj.23","cdvb-enj.24","cdvb-enj.25","cdvb-enj.26","cdvb-enj.27","cdvb-enj.28","cdvb-enj.29","cdvb-enj.30","cdvb-enj.31","cdvb-enj.32","cdvb-enj.33","cdvb-enj.34","cdvb-enj.35","cdvb-enj.36","cdvb-enj.37"],"cycle0":{"state":"ready_for_independent_audit","execution_children":36,"metadata_valid":36,"child_state_counts":{"closed":6,"deferred":23,"open":7,"in_progress":0},"active_exception_labels":0,"unresolved_server_issue_ids":["cdvb-enj.29","cdvb-enj.35"]},"cycle1":{"state":"implementation_continues_server_nonblocking","execution_children":37,"metadata_valid":37,"child_state_counts":{"closed":7,"deferred":23,"open":7,"in_progress":0},"native_addon_issue_id":"cdvb-enj.37","unresolved_server_issue_ids":["cdvb-enj.29","cdvb-enj.35"]}}
```

Canonical tracking:

- PM reference: `PM-024`
- Beads epic: `cdvb-enj` (`identity:cdvb-voice-poc-v1`)
- Project repository: `C:\Projects\codex-discord-voice-bridge`
- Originating Codex task: `REDACTED_CODEX_TASK_ID_1`

Current evidence:

- Common core and fail-closed DAVE session tests: `npm test`, 36/36 passing at commit `a88e356`.
- Official `discord/libdave` source is fixed at `52cd56dc550f447fb354b3a06c9e2d2e2a4309c6`.
- Windows static build completed with MSVC 19.44 and Windows SDK 10.0.26100.0.
- Official C API executable passed 9/9; tracked by `cdvb-enj.31`.
- A thin N-API feasibility addon loads the official library, reports protocol version 1, and completes a session lifecycle; tracked by `cdvb-enj.32`.
- Credentials and external Discord access are deliberately outside those probes.

Release completion conditions:

1. The production Node binding safely marshals MLS messages and Opus frames through official libdave; no custom cryptography is permitted.
2. Main Gateway and Voice Gateway correlation, heartbeat/resume, UDP discovery, DAVE transition, and fail-closed audio gating pass deterministic tests.
3. A local secret provider supplies credentials without committing, logging, or placing tokens in conversation; guild/user/channel allowlists deny by default.
4. One bounded DAVE-encrypted join/send/receive smoke test succeeds in the private test channel on Windows, followed by the equivalent macOS adapter check.
5. Audit events contain no Discord identifiers or secrets, and the independent audit issue records PASS.

Beads server boundary:

- `bd serve` binds only to `127.0.0.1:17839`; LAN binding is prohibited.
- Its write-capable HTTP API is never the public PM display surface. PM aggregation uses `bd --readonly query`.
- Server start/health/restart is a PM tracking gate only. A stopped server does not block Discord Voice implementation or release evidence stored in the database.
