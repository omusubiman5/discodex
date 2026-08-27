# Discodex technical and operations runbook / 技術・運用Runbook

This is the single technical source for installation, Discord configuration, architecture, security, DAVE, operations, troubleshooting, platform support, and acceptance. The product connects Discord audio to the **current GPT Live/Codex task**; it is not a standalone bot brain.

本書は、導入、Discord設定、設計、安全境界、DAVE、運用、障害対応、OS対応、受入条件をまとめた唯一の技術正本です。製品はDiscord音声を**現在のGPT Live／Codexタスク**へ接続するもので、独立したbot brainではありません。

## Contents / 目次

- [Product boundary / 製品境界](#product-boundary)
- [Discord Developer setup / Discord Developer設定](#discord-developer-setup)
- [Install and credentials / 導入と資格情報](#install-and-credentials)
- [Architecture and protocol / 設計とprotocol](#architecture-and-protocol)
- [Security policy / 安全・運用方針](#security-policy)
- [Operation and recovery / 接続・切断・復元](#operation-and-recovery)
- [DAVE build and integration / DAVE build・統合](#dave-integration)
- [4006 incident / 4006障害](#voice-4006)
- [Ubuntu / Linux support](#ubuntu-linux-support)
- [Real E2E acceptance / 実通話受入](#real-e2e-acceptance)

<a id="product-boundary"></a>

## Product boundary / 製品境界

```text
Smartphone Discord
  ↕ Discord Gateway + Voice Gateway v8 + UDP/RTP + Opus + DAVE
Discodex local bridge
  ↕ isolated OS audio route + exact-task non-owning attachment
Current GPT Live / Codex Voice task
```

**日本語:** 対象は単一利用者、単一host、単一の招待制Discord server、単一の選択済みCodexタスクです。別ChatGPT会話、echo、固定応答、別STT／text／TTS pipelineへ代替しません。bridgeはforeground Codex realtime callへstart／stop／reconnectを送らず、既存callへ非所有attachします。

**English:** The boundary is one user, one host, one private Discord server, and one selected Codex task. A different ChatGPT conversation, echo, fixed response, or alternate STT/text/TTS pipeline is not a substitute. The bridge attaches non-owningly and never sends start, stop, or reconnect to the foreground Codex realtime call.

### Supported environments / 対応環境

| Platform | Current status / 現状 | Requirements / 必要条件 |
| --- | --- | --- |
| Windows 11 x64 | Supported and live-E2E verified / 対応・実通話確認済み | Node.js 26+, ffmpeg, VB-CABLE, PowerShell, CMake, MSVC Build Tools, Windows SDK |
| macOS 13+ arm64/x64 | Partial; real Core Audio E2E pending / 部分対応・実機E2E待ち | Node.js 26+, ffmpeg, Keychain, Xcode Command Line Tools, CMake |
| Ubuntu/Linux | Unsupported until official GPT Live support / GPT Live公式対応待ち | See [Ubuntu gate](#ubuntu-linux-support) |

Official `discord/libdave` is mandatory. Plaintext fallback, custom cryptography, unpinned builds, and alternate AI sessions are prohibited.

Discord公式`libdave`を必須とし、平文fallback、独自暗号、未固定build、別AI sessionを禁止します。

<a id="discord-developer-setup"></a>

## Discord Developer setup / Discord Developer設定

**日本語:** cloneだけでは接続できません。[Discord Developer Portal](https://discord.com/developers/applications)で専用Application／Botを1つ作成し、自分の招待制serverへ導入します。

**English:** A clone alone cannot connect. Create one dedicated Application/Bot in the [Discord Developer Portal](https://discord.com/developers/applications) and install it into your private server.

| Item / 項目 | Required / 必須設定 |
| --- | --- |
| Install scopes | `bot`, `applications.commands` |
| Bot permissions | `VIEW_CHANNEL`, `CONNECT`, `SPEAK`, `SEND_MESSAGES`, `READ_MESSAGE_HISTORY` |
| Operator permission | `USE_APPLICATION_COMMANDS` in the control text channel / 操作用text channel |
| Privileged intents | None; leave disabled / 不要・OFF |
| Non-secret IDs | guild, voice channel, text channel, allowlisted user |
| Secret | Bot Token only / Bot Tokenのみ |

No separate Discord API key, Client Secret, OAuth user token, webhook, or Interactions Endpoint is required. The Application ID is resolved from the authenticated bot at startup. Never grant `ADMINISTRATOR`, `MANAGE_*`, `MOVE_MEMBERS`, or `MUTE_MEMBERS`.

別のDiscord API key、Client Secret、OAuth user token、webhook、Interactions Endpointは不要です。Application IDは起動時に認証済みbotから取得します。`ADMINISTRATOR`、`MANAGE_*`、`MOVE_MEMBERS`、`MUTE_MEMBERS`は付与しません。

Copy the tracked template and edit only non-secret identifiers. / tracked templateをコピーし、非秘密IDだけを編集します。

```powershell
Copy-Item config\bridge.example.json config\bridge.local.json
```

The local file is ignored by Git. Never put a token in JSON, `.env`, argv, logs, issues, or chat. Application commands are registered and read back through Discord REST API v10 when control starts.

local fileはGit対象外です。tokenをJSON、`.env`、argv、log、Issue、chatへ入れません。application commandはcontrol起動時にDiscord REST API v10で登録・readbackされます。

Official references / 公式資料:

- [Building your first Discord Bot](https://docs.discord.com/developers/quick-start/getting-started)
- [OAuth2 and permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions)
- [Application commands](https://docs.discord.com/developers/interactions/application-commands)
- [Voice connections](https://docs.discord.com/developers/topics/voice-connections)

<a id="install-and-credentials"></a>

## Install and credentials / 導入と資格情報

```powershell
git clone https://github.com/omusubiman5/discodex.git
cd discodex
npm ci
npm test
npm run preflight:discord
npm run dry-run:discord
```

`preflight:discord` and `dry-run:discord` open no Discord API, Gateway, Voice Gateway, or UDP connection and read no credential. A blocked result before live configuration is expected fail-closed behavior.

`preflight:discord`と`dry-run:discord`はDiscord API、Gateway、Voice Gateway、UDPへ接続せず、資格情報も読みません。実接続設定前のblockedは正常なfail-closedです。

### Windows credential / Windows資格情報

Use the current-user `WindowsDpapiCredentialProvider`. It stores only DPAPI ciphertext under `%LOCALAPPDATA%\CodexVoiceBridge\secrets`. Provision from an interactive local setup process; the runtime leases the decrypted token only while authenticating and disposes its reference afterward.

current-userの`WindowsDpapiCredentialProvider`を使用します。保存されるのは`%LOCALAPPDATA%\CodexVoiceBridge\secrets`配下のDPAPI暗号文だけです。interactiveなlocal setupから登録し、runtimeは認証中だけ復号tokenをleaseして終了時に参照を破棄します。

### macOS credential / macOS資格情報

Store a generic password with service `codex-discord-voice-bridge.bot-token` and account `discord-bot` in Login Keychain. Use Keychain Access or an interactive `/usr/bin/security add-generic-password` invocation that does not place the secret in argv.

Login Keychainへservice `codex-discord-voice-bridge.bot-token`、account `discord-bot`のgeneric passwordとして保存します。Keychain Access、またはsecretをargvへ出さないinteractiveな`/usr/bin/security add-generic-password`を使います。

If a token leaks, reset it first in Discord Developer Portal, replace the local secret, verify rejection of the old token, then restart control. Never attach either value to evidence.

token漏洩時はDeveloper Portalで先にresetし、local secretを交換し、旧tokenが拒否されることを確認してからcontrolを再起動します。新旧tokenを証拠へ含めません。

<a id="architecture-and-protocol"></a>

## Architecture and protocol / 設計とprotocol

### Core responsibilities / 共通コア

- **Session orchestration:** validates exact task, allowlist, duration, and legal state transitions. / 対象task、allowlist、期限、状態遷移を検証。
- **Audio routing:** keeps Discord→Codex and Codex→Discord separate, rejects self-loop, and records reversible state. / 双方向routeを分離し、自己loopを拒否して復元状態を保持。
- **Command policy:** exposes only `/connect`, `/disconnect`, `/status`, `/gain`. / 4つの限定commandだけを公開。
- **Diagnostics:** distinguishes connected from functional and emits sanitized state/counts only. / 接続と機能成立を分離し、sanitize済み状態・件数だけを出力。
- **OS adapters:** contain WASAPI/VB-CABLE, Core Audio, secret-store, and process differences outside the shared core. / OS固有差分をadapterへ隔離。

### Discord voice sequence / Discord Voice接続順序

1. Connect Main Gateway and request one exact guild/channel Voice State Update.
2. Correlate matching Voice State Update and Voice Server Update; never cache endpoint or short-lived voice token.
3. Connect Voice Gateway v8 and Identify with the official maximum DAVE protocol version.
4. Complete UDP discovery and choose supported RTP transport encryption.
5. Route DAVE MLS external sender, proposal, commit, welcome, prepare, ready, and execute through official libdave.
6. Start Opus/RTP only after the matching Execute Transition.
7. On speech end, send five official Opus silence frames, then Speaking=0.
8. On stop, block output, leave voice, close media, destroy DAVE, restore route, dispose credential, and release the atomic lock.

日本語要約: Main Gatewayの2eventを同一guild/channel/sessionで照合し、Voice Gateway v8、UDP discovery、transport暗号、DAVE transitionの順に進めます。一致するExecute Transition前はaudioを送りません。終了時はsilence frame、Speaking終了、voice退出、DAVE破棄、route復元、lock解放の順です。

### Audio path / 音声経路

```text
Discord UDP/RTP → transport decrypt → DAVE decrypt → Opus decode
  → isolated CABLE render → existing Codex sender input

Existing Codex WebRTC audio → direct receiver/process capture → PCM gain/limiter
  → persistent Opus encode → DAVE encrypt → RTP transport encrypt → Discord UDP
```

The Windows path changes only the exact call's track and never changes global Console, Multimedia, or Communications defaults. The original physical track is retained for atomic rollback.

Windows経路は対象callのtrackだけを変更し、globalなConsole／Multimedia／Communications既定値を変更しません。元physical trackをatomic rollback用に保持します。

<a id="security-policy"></a>

## Security policy / 安全・運用方針

### Trusted / 信頼する

- User-managed host and OS account / 利用者管理host・OS account
- Selected Codex task / 選択済みCodex task
- Private guild and exact guild/channel/user allowlist / 招待制guildと完全一致allowlist
- Loopback-only local control / loopback限定local control
- Official libdave session after completed DAVE transition / DAVE transition完了後の公式libdave session

### Not trusted / 信頼しない

- Display names, role names, voice identity, wake phrase, invite URL alone
- A single `connected` display, a lock file alone, or stale process state
- Endpoint names without stable identity
- CDP or control ports reachable outside loopback
- DAVE version zero, downgrade, incomplete transition, or plaintext media

表示名、role名、声紋、呼びかけ語、招待URLだけでは認証しません。`connected`表示やlock fileだけをhealthとみなしません。stable identityのないendpoint、loopback外のcontrol、DAVE未成立／downgrade／平文mediaを信頼しません。

### Mandatory behavior / 必須動作

- Fail closed before network activity on task, route, identity, credential, DAVE, runner, or lock ambiguity.
- Keep one control, one runner, one atomic lock, one voice session, and one media socket.
- Never log tokens, Discord IDs, invite URLs, transcripts, audio, MLS payloads, keys, usernames, or profile paths.
- Apply bounded output gain and limiter; stop on clipping, feedback, or unrelated PC audio.
- Preserve the foreground Codex call and restore only bridge-owned state.
- Require existing Codex authorization boundaries for deletion, deployment, publication, messages, purchases, credentials, firewall, drivers, reboot, and shutdown.

task、route、identity、credential、DAVE、runner、lockが曖昧ならnetwork前にfail-closedします。control／runner／lock／voice session／media socketは各1件です。秘密・識別子・会話・audioをlogへ出さず、gain／limiterを適用し、foreground Codex callを維持してbridge所有状態だけを復元します。破壊的・外部操作は既存Codex承認境界を維持します。

<a id="operation-and-recovery"></a>

## Operation and recovery / 接続・切断・復元

### Start and connect / 起動・接続

1. Open the exact Codex task and activate its existing Voice Talk call. / 対象Codex taskで既存Voice Talk callを有効化。
2. Start `Discodex Relay.lnk`; prepare Codex only if Relay reports that route preparation is needed. / Relayを起動し、必要表示時だけCodex準備。
3. Require `control=1`, `runner=0`, `lock=false`, exact task, one sender, valid CABLE endpoints, and registered commands. / 単一性と対象一致を確認。
4. In the allowlisted text channel, run `/status`, then `/connect` once. / 許可text channelで`/status`後に`/connect`を1回。
5. Treat `Connected.` as valid only after Discord Voice Ready, target voice state, UDP discovery, and DAVE readiness. / 全join gate成立後だけConnected扱い。

### Disconnect and restore / 切断・復元

1. Run `/disconnect` once.
2. Confirm Discord voice leave and zero further RTP.
3. Confirm the original physical Codex input track and PC playback are restored.
4. Confirm runner=0 and lock released; leave the Codex task/call itself running.
5. Use Relay `Stop Relay` only after restoration if command control is no longer needed.

`/disconnect`を1回実行し、voice退出、RTP停止、元physical inputとPC再生の復元、runner 0、lock解放を確認します。Codex task/call自体は終了しません。control不要時だけ最後にRelayの`Stop Relay`を使います。

### Reconnect / 再接続

One recoverable Voice WebSocket interruption may use Voice Resume opcode 7 with the same session and last sequence, accepting opcode 9 Resumed while retaining valid UDP/DAVE state. A second failure stops the bridge. Participant rejoin replaces that participant's SSRC and ratchet context only. Epoch transitions preserve the MLS group and activate only a matching prepared transition.

recoverableなVoice WebSocket切断は1回だけ同一session／last sequenceでOpcode 7 Resumeし、Opcode 9 Resumedを確認します。2回目は停止します。participant rejoinでは対象SSRC／ratchetだけを更新し、epoch transitionはMLS groupを保持して一致transitionだけを有効化します。

<a id="dave-integration"></a>

## DAVE build and integration / DAVE build・統合

### Adopted boundary / 採用境界

Official `discord/libdave` is the only crypto engine. A thin N-API addon may expose lifecycle and frame operations but no raw key getter. Required gates are pinned-source reproducibility, official tests/vectors, positive protocol version, downgrade rejection, reconnect/participant/epoch handling, crash-first audio stop, and license/SBOM inclusion.

公式`discord/libdave`だけを暗号engineにします。薄いN-API addonはlifecycleとframe操作だけを公開し、raw key getterを持ちません。固定source再現build、公式test/vector、正version、downgrade拒否、reconnect／participant／epoch、crash時のaudio先行停止、license／SBOMをgateにします。

### Reproducible Windows probe / Windows再現probe

- Date: 2026-08-22
- libdave commit: `52cd56dc550f447fb354b3a06c9e2d2e2a4309c6`
- vcpkg submodule: `16c71a39e5a0fc0bdb3fad03beef8f38ee00ee3b`
- Official `bootstrap-vcpkg.bat -disableMetrics`: PASS
- Source modifications and system installs: none / なし

The first official MSVC probe stopped before source compilation because Visual Studio C++, MSBuild, and the Windows SDK were absent. The auxiliary MinGW probe built OpenSSL/gtest/nlohmann-json/Catch2, then stopped in MLS++ because GCC 16.1 promoted `maybe-uninitialized` to `-Werror`. MinGW was never accepted as proof of the official path.

初回公式MSVC probeはVisual Studio C++、MSBuild、Windows SDK不在でsource compile前に停止しました。補助MinGW probeは依存build後、MLS++の`maybe-uninitialized`が`-Werror`となり停止し、公式経路の証拠には採用していません。

### Native loader result / native loader結果

Evidence ID: `native-addon-loader-pass`

- `node --test tests/native-addon.test.ts`: valid/invalid deterministic loader cases PASS.
- `node work/node-native-binding-probe/load-probe.cjs`: `maxProtocolVersion: 1`, `sessionLifecycle: true`.
- Loader accepts only a `.node` addon, positive protocol version, and passing lifecycle; malformed/false/throw fails closed.
- Returned metadata contains provider, transport, version, and lifecycle status only; no key material.

この証拠はNode load/probe seamの成立を示します。production MLS message、Opus marshalling、Discord credential、Gateway／UDP、実音声は別gateです。

### macOS build / macOS build

Build the pinned official library and addon for the real architecture (`arm64-osx` or `x64-osx`) and current Node ABI. Set `CODEX_BRIDGE_LIBDAVE_ADDON_PATH` only in the bridge process. A Windows artifact or unit test does not prove macOS E2E.

実architecture（`arm64-osx`／`x64-osx`）と現在のNode ABI向けに固定公式library/addonをbuildし、`CODEX_BRIDGE_LIBDAVE_ADDON_PATH`はbridge processだけへ設定します。Windows artifactやunit testをmacOS E2Eの代替にしません。

<a id="voice-4006"></a>

## Voice 4006 incident / Voice 4006障害

### Root cause / 根本原因

Two concurrent live-call processes used the same bot identity. The second Voice session superseded the first, and Discord closed the old session with code 4006. This was a missing cross-process ownership lock, not a libdave failure. A separate RTP-size defect then treated encrypted RTP extension data as unencrypted AAD, blocking DAVE decrypt after UDP receive.

同じbot identityで2つのlive-call processが競合し、後発sessionが先行sessionを無効化してDiscordが4006でcloseしました。原因はcross-process ownership lock欠落であり、libdaveではありません。その後、暗号化されたRTP extension dataを未暗号AADとして扱う別不具合も判明しました。

### Fix and regression / 修正と回帰

- Acquire `runtime/live-call.lock` before credential or network activity; reject overlap locally.
- Authenticate the fixed RTP header, CSRCs, and extension preamble while decrypting extension data with media payload.
- Emit sanitized `udp-discovered`, `ready`, `udp-received`, `dave-decrypted`, `pcm-generated`, `response-encoded`, and `response-sent` stages.
- Keep the historical echo/counter run only as transport regression evidence; it is not product acceptance.

credential／networkより前にatomic lockを取得し、重複をlocal拒否します。RTP extension境界を修正し、sanitize済みstageを記録します。旧echo／counter結果はtransport回帰証拠に限定し、製品合格には使いません。

| Symptom / 症状 | First check / 最初の確認 | Recovery / 復旧 |
| --- | --- | --- |
| Voice close 4006 | runner PID, lock owner, Voice session time | stop superseded owner; one fresh handoff |
| UDP without DAVE decrypt | RTP extension/AAD and ratchet | fail closed; pass transport regression before retry |
| Active-writer conflict | second app-server/process | use Desktop-owned attachment; never fork |
| No Codex output | exact receiver, non-silent PCM, RTP send | restore direct route; no text/TTS/echo substitute |
| DAVE transition failure | sanitized opcode/state | leave, destroy native state, fresh join; no plaintext |

<a id="ubuntu-linux-support"></a>

## Ubuntu / Linux support

**Status / 状態:** Unsupported. The Discord/DAVE/Opus core is portable in principle, but GPT Live (Voice in Work/Codex) is not currently an official Ubuntu/Linux desktop capability. Work begins only after [official OpenAI support](https://help.openai.com/en/articles/20001275/) defines the supported task and audio boundary.

未対応です。Discord／DAVE／Opus coreには移植可能部分がありますが、GPT Live（Work／Codex Voice）はUbuntu/Linux向け公式desktop機能ではありません。[OpenAI公式対応](https://help.openai.com/en/articles/20001275/)でtaskとaudio境界が定義された後に開始します。

Remaining implementation gates / 残る実装gate:

1. OS-independent runner contract instead of the Windows runner import.
2. PipeWire/PulseAudio per-stream attach/restore without global defaults.
3. Secret Service/libsecret production credential provider.
4. Explicit Linux preflight/toolchain/native-addon branch.
5. Linux Relay/package and rollback procedure.
6. Real architecture/Node ABI libdave build and lifecycle.
7. Source-isolated multi-turn E2E, rejoin, epoch transition, gain/clip, cleanup.

Windows PowerShell/VB-CABLE, unit tests, unofficial UI automation, and alternate STT/text/TTS must not be presented as Ubuntu support.

Windows PowerShell／VB-CABLE、unit test、非公式UI自動化、別STT／text／TTSをUbuntu対応の代替にしません。

<a id="real-e2e-acceptance"></a>

## Real E2E acceptance / 実通話受入

Run the same observable matrix on every claimed OS. / 対応を主張する各OSで同じmatrixを実施します。

1. Fresh install and OS secret retrieval under the intended user. / 新規導入と対象userでのsecret取得。
2. Exact current Codex task and retained context. / 現在taskと既存context保持。
3. Real external Discord speech reaches Codex through the isolated route. / 外部Discord発話が分離route経由でCodexへ到達。
4. A causally corresponding Codex response reaches Discord clearly without echo, stale UI audio, or physical-mic contamination. / 内容対応応答がecho・古いUI音声・物理mic混入なしで明瞭に返る。
5. Multiple turns, barge-in, disconnect/rejoin, one bounded resume, and DAVE epoch transition. / 複数turn、割込み、再参加、bounded resume、epoch transition。
6. Output gain and limiter prevent clipping. / gainとlimiterで音割れ防止。
7. Disconnect restores the physical route, leaves foreground Codex alive, releases runner/lock, and disposes secrets. / 切断でphysical route復元、Codex維持、runner/lock解放、secret破棄。
8. Logs contain no secret, identifier, transcript, audio, key, or plaintext fallback. / logに秘密・識別子・本文・audio・key・平文fallbackなし。

### Verified clients / 確認済みclient

| Client | Verified result / 確認結果 |
| --- | --- |
| Android / Pixel | Bidirectional live voice and multi-turn through a Windows host / Windows hostで双方向・複数往復 |
| iPhone / official Discord iOS | Bidirectional live voice confirmed 2026-08-26 / 2026-08-26双方向確認 |

Do not downgrade the iPhone result to connection-only, and do not infer unrecorded endurance/reconnect/audio-quality results. Unit tests, bot presence, echo, counters, or zero 4006 cannot replace observable product E2E.

iPhone結果を接続確認だけへ後退させず、未記録の耐久・再接続・音質まで推定しません。unit test、bot表示、echo、counter、4006ゼロは製品E2Eの代替になりません。

## Official references / 公式参照

- [Discord Gateway](https://docs.discord.com/developers/events/gateway)
- [Discord Voice connections](https://docs.discord.com/developers/topics/voice-connections)
- [Discord permissions](https://docs.discord.com/developers/topics/permissions)
- [Discord application commands](https://docs.discord.com/developers/interactions/application-commands)
- [DAVE protocol](https://daveprotocol.com/)
- [Discord libdave](https://github.com/discord/libdave)
