# Discord最小PoC

## 目的

外出先のユーザーがスマートフォンから専用Discord voice channelへ入り、PC上のPM Codexへ音声指示を送り、応答を聞けることをE2E目標とします。Google MeetはMVP対象外で、同じ共通contractを検証する将来adapter候補に限ります。

## 専用Discord構成

- 招待制の専用serverを1つ使用する。
- voice channelとtransport control channelを用途別に分ける。開発作業の振り分けやプロジェクト通知には使用しない。
- 指示を許可するDiscord user ID、guild ID、channel IDを明示allowlistにする。
- botは通常メンバーを管理せず、対象channel以外を閲覧しない。
- server/application/tokenの作成はローカルprobe合格後にユーザーが行う。

最小bot権限は `VIEW_CHANNEL`、`CONNECT`、`SPEAK`、`SEND_MESSAGES`、`READ_MESSAGE_HISTORY`、`USE_APPLICATION_COMMANDS` です。`ADMINISTRATOR`、`MANAGE_*`、`MOVE_MEMBERS`、`MUTE_MEMBERS` は要求しません。

## Voice接続順序

1. Main Gatewayへ接続し、botのVoice State Updateを要求する。
2. Voice State UpdateとVoice Server Updateからsession、endpoint、短命tokenを得る。
3. endpoint/tokenを永続化せず、Voice Gateway v8へ接続する。
4. Identifyで `max_dave_protocol_version` を通知する。
5. UDP discoveryとtransport選択を行い、RTP送受信を確立する。
6. Discordから届くDAVE transition/MLS opcodeを公式libdaveへ渡す。
7. DAVE session確立を確認してからaudioを有効化する。
8. 送信前にSpeaking opcodeを送り、Opus frameをRTPで送る。
9. 終了時にまず送信を遮断し、voice stateを解除してkey materialを破棄する。

DAVE transitionが失敗、downgrade、unknown protocol、key不整合になった場合は音声を開始しません。平文へfallbackしません。

## 音声境界

```text
Discord encrypted UDP -> DAVE decrypt -> RTP/Opus decode
  -> remoteToCodex isolated endpoint -> PM Codex input

PM Codex output -> codexToRemote isolated endpoint
  -> Opus encode -> DAVE encrypt -> Discord encrypted UDP
```

受信者ごとのSSRC、sequence、timestamp、packet loss、jitterをmedia層が扱い、暗号鍵はlibdaveだけが扱います。共通コアは暗号primitiveやraw keyへ触れません。

## テキスト制御

- `connect`: allowlistユーザーが明示的に音声transportを開始する。
- `status`: 音声経路、Codex task、session期限のredacted状態を返す。
- `disconnect`: audio送信を即時遮断してsession終了を開始する。
- `gain`: 安全範囲内でCodexからDiscordへの出力gainを変更する。

application commandを使い、一般message本文の監視を避けます。これにより広いMESSAGE_CONTENT intentをMVP要件にしません。

## Token保護

- リポジトリ、JSON、`.env`、ログ、diagnostic bundleへ保存しない。
- WindowsはCredential Manager/DPAPI、macOSはKeychainを本番adapter境界とする。
- process環境変数は、ユーザーが明示した開発時の一時fallbackだけにする。
- stdout、例外、Voice Gateway payloadをredactする。
- token漏洩時はDiscord Developer Portalで直ちにresetし、旧tokenを無効化する。

## 検証フェーズ

### P0: ローカル契約

現在のdry-run、config、DAVE policy、permission、redaction試験。network socketを開かない。

### P1: libdave build probe

Windows x64とmacOS Apple Silicon/Intelで公式libdaveを固定commitからbuildし、公式test vectorとC API lifecycleを確認する。Node addonまたはWASM wrapperでkey materialをJSへ露出せずencrypt/decryptできることを確認する。

### P2: ユーザー所有test server

ユーザーが専用server/application/tokenを作成後、voice接続とDAVE negotiationだけを短時間試験する。Codexや実会話は接続しない。

### P3: 一方向audio

固定tone/既知Opus sampleで受信と送信を別々に検証し、自己入力、別channel漏洩、平文送信がないことをpacket/状態レベルで確認する。

### P4: PM Codex E2E

スマートフォンを携帯回線にし、allowlist userが20件の音声指示を実行する。誤作動時の `disconnect`、bot切断、PCローカル停止を確認する。

## 採否条件

両OSで公式libdaveがbuildでき、Voice Gateway v8のDAVE transitionと統合でき、Node境界でraw keyを扱わず、平文fallbackなしで双方向音声が成立した場合だけDiscord音声PoCを採用します。どれかが満たせなければDiscord実接続を止め、暗号を自作せず公式実装の更新を待ちます。
