# Project goals

## Discord Voice entry

The primary user journey is: a user joins a private Discord voice channel from a phone, speaks to the bridge running on a Windows or macOS workstation, and receives the PM Codex voice response through Discord. Google Meet remains only a future transport adapter candidate.

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
