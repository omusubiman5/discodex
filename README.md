# 🎙️ Discodex — Codex Discord Voice Bridge ✨

🌍 [English](README.en.md)

**スマホのDiscordから、自宅・作業PCのGPT Live（Codex Voice）を呼び出し、現在のCodexタスクを起動・接続・操作する**ためのローカル音声ブリッジです。独立したチャットボットではなく、DiscordをGPT Liveの遠隔入口にします。📱↔️💻

## 🧠 Project Raphael

Discodexは、DISCORDERを支援するAI Gaming Life Companion構想 **Project Raphael** のDiscord接続moduleです。ゲーム内助言、初心者onboarding、録画・比較・Eスポーツコーチ、許可済み外部作業、HAOS、Healthcare Adapter、Discordへの協力依頼を一つの正本にまとめています。

➡️ **[Project Raphaelの構想・完成体験・実行方針を読む](docs/PROJECT_RAPHAEL.md)**

## 🌟 特徴

- 📱 スマホのDiscordからGPT Live（Codex Voice）を呼び出す
- 🚀 Discordの `/connect` からCodex Voiceを準備し、同じタスクへ接続
- 🎛️ `/disconnect`、`/status`、`/gain` による限定された遠隔操作
- 🔊 Discord音声をCodexへ渡し、Codexの応答を同じ通話へ返送
- 🧑‍🏫 Codexへ司会を頼み、議題進行・論点整理・要約を会話内で支援
- 🔐 招待制サーバー、guild/channel/user allowlist、最小権限で接続範囲を限定
- 🛡️ Discord公式 `libdave` を必須化し、平文fallbackや独自暗号を禁止
- 🧼 token、Discord ID、発話本文をログへ残さないfail-closed設計
- 🧵 既に開いているCodex Desktopの対象タスクへ接続し、別セッションへ逸脱しない

> 📝 会議進行支援は可能ですが、複数話者の厳密な自動識別や議事録の自動保存は別機能です。

## 🖥️ 対応状況

| 環境 | 状態 | 内容 |
| --- | --- | --- |
| 🪟 Windows | ✅ 対応 | Discord制御、Codex Desktop接続、VB-CABLE音声経路、Relay UI、実通話ランナー |
| 🍎 macOS | 🧪 実機受入待ち | BlackHole/Core Audio経路、sender rollback、本番runner、Keychain、libdave build |
| 🐧 Ubuntu | ⏳ 予定 | GPT Live（Work / Codex Voice）のUbuntu公式対応後に開発・実機検証予定 |

macOS実通話経路は実装済みですが、Mac実機E2E受入は未完了です。受入matrixが完走するまではmacOS対応済みとは表記しません。実機手順は[macOS E2E Runbook](docs/MACOS_E2E_RUNBOOK.md)を参照してください。

Ubuntu向けDiscord/DAVE/Opus基盤は技術的に移植可能ですが、現在GPT Live（Work / Codex Voice）はUbuntu/Linux向けの公式デスクトップ機能として提供されていません。そのため、DiscodexのUbuntu版は現時点では未対応です。[OpenAIによるUbuntu対応](https://help.openai.com/en/articles/20001275/)後に、音声経路の実装と実機E2E検証を開始します。確認済みの技術課題は[技術・運用RunbookのUbuntu節](docs/DISCORD_VOICE_RUNBOOK.md#ubuntu-linux-support)へ統合しています。

## 🚀 起動場所（最初にここ）

### 🪟 Windows

1. Codex Desktopで対象タスクを開き、Voice Talkを開始します。
2. Explorerでrepository内の **`dist\Discodex Relay.lnk`** をダブルクリックします。これがWindows版の起動入口です。
3. Relayの `Prepare Codex` または `Start Relay` を1回押し、`RELAY READY` を確認します。
4. Discordの許可済みtext channelで `/status`、続けて `/connect` を実行します。

初回だけ、shortcutを作るためrepository rootのPowerShellで `npm run build:relay:windows` を実行します。詳しくは[WindowsでDiscodex Relayを準備](#-windowsでdiscodex-relayを準備)を参照してください。

### 🍎 macOS

1. Codex Desktopで対象タスクを開きます。
2. Finderでrepository内の **`dist/Discodex Relay.app`** をダブルクリックします。これがmacOS版の起動入口です。
3. Relayの `Prepare Codex` または `Start Relay` を1回押し、`RELAY READY` を確認します。必要なCodex再起動、loopback限定CDP、Core Audio経路、control起動はRelayが管理します。
4. Discordの許可済みtext channelで `/status`、続けて `/connect` を実行します。Voice Talkの開始も `/connect` が対象タスクへ行います。

初回だけ、appを作るためrepository rootのTerminalで `npm run build:relay:macos` を実行します。起動のたびにTerminal commandやtask IDを入力する必要はありません。

初回構築、Keychain、BlackHole、設定ファイル、終了・証跡検査は[macOSテスター向け](#-macosテスター向け)と[macOS E2E Runbook](docs/MACOS_E2E_RUNBOOK.md)を参照してください。

### 💤 遠隔待受中のスリープ

Windows／macOSとも、**Discodex Relayを開いている間はシステムのアイドルスリープを自動的に抑止**します。画面の自動消灯は妨げません。Relayを終了するとOS本来の電源設定へ戻ります。

ノートPCの蓋を閉じる操作、手動sleep／休止、shutdown、battery切れ、network切断はRelayから防止できません。遠隔接続を待つ間はAC電源へ接続し、蓋を開けたまま、安定したnetworkに接続してください。

### 📱 スマートフォン実機確認

- Android（Pixel）: Discordと同一Codex Voiceタスク間の双方向実通話を確認済み
- iPhone（Discord公式iOS client）: Discordと同一Codex Voiceタスク間の双方向実通話を2026-08-26に確認済み

PixelとiPhoneの両方で、スマートフォンのDiscord音声がCodexへ届き、Codexの応答音声がDiscordへ返る相互通話を確認しています。Pixelでは複数往復も確認済みです。端末ごとに未実施の耐久・音質試験まで自動的に検証済みとは扱いません。

## 🔁 動作の流れ

```text
📱 スマートフォンのDiscord
  ↕ Discord Voice / DAVE
🌉 Discodex（PC/Mac上のローカルブリッジ）
  ↕ OS音声adapter + Codex Desktop接続
🤖 現在のCodex Voiceタスク
```

## 📦 必要条件

- Node.js 26以降
- Discord Developer Portalで作成した専用Application／Botと、そのBot Token
- Botを導入する招待制Discordサーバーと、操作用text channel／通話用voice channel
- Discord公式DAVE対応のnative addon
- Codex Desktopと対象のVoice Talkタスク
- 🪟 Windows: VB-CABLE、ffmpeg、PowerShell
- 🍎 macOS: BlackHole 2ch、ffmpeg、Xcode Command Line Tools、CMake、Keychain（runner実装済み・実機受入待ち）
- 🐧 Ubuntu: GPT Live（Work / Codex Voice）の公式対応待ち。現時点ではサポート対象外

### 🤖 Discord Developer設定（必須）

リポジトリをcloneするだけではDiscordへ接続できません。利用者自身の[Discord Developer Portal](https://discord.com/developers/applications)で専用Applicationを1つ作成し、`Bot`ページでBot userとBot Tokenを発行して、`Installation`から自分の招待制serverへ導入します。

| 項目 | 必要な設定 |
| --- | --- |
| Install scopes | `bot`、`applications.commands` |
| Botのchannel権限 | `VIEW_CHANNEL`、`CONNECT`、`SPEAK`、`SEND_MESSAGES`、`READ_MESSAGE_HISTORY` |
| 操作利用者の権限 | 操作用text channelで`USE_APPLICATION_COMMANDS` |
| Privileged Gateway Intents | 不要。すべてOFFのまま使用 |
| local設定へ入れるID | guild、voice channel、text channel、許可するDiscord user |
| 秘密情報 | Bot Tokenだけ。WindowsはDPAPI、macOSはKeychainへ保存 |

別の「Discord API key」、Client Secret、OAuth user token、Webhook URL、Interactions Endpoint URLは不要です。Application IDは起動時にDiscord APIからBot identityとともに取得するため、手入力しません。DiscordのDeveloper Modeで取得した4種類のIDだけをGit対象外の`config/bridge.local.json`へ設定します。

DiscodexはDiscord REST API v10でguild commandを登録・readbackし、Gatewayでinteractionとvoice stateを受け、Voice Gateway v8、UDP、Opus、公式DAVEで通話します。起動後に`/connect`、`/disconnect`、`/status`、`/gain`が対象guildへ登録されます。

公式手順: [Discord Botの作成](https://docs.discord.com/developers/quick-start/getting-started) · [OAuth2と権限](https://docs.discord.com/developers/platform/oauth2-and-permissions) · [Voice接続](https://docs.discord.com/developers/topics/voice-connections)

## 🛠️ インストール

秘密情報をリポジトリへ保存しないでください。WindowsではDPAPI、macOSではKeychainを使用します。🔑

```powershell
git clone https://github.com/omusubiman5/discodex.git
cd discodex
npm ci
npm test
npm run preflight:discord
```

Botには上記の最小権限だけを許可します。guild、voice/text channel、許可userはGit対象外の `config/bridge.local.json` に設定し、bot tokenはWindowsではDPAPI、macOSではKeychainに保存します。JSON、`.env`、コマンド引数、チャットにtokenを書かないでください。

設定値、資格情報、公式libdave、障害調査は日英併記の 📘 [技術・運用Runbook](docs/DISCORD_VOICE_RUNBOOK.md) へ集約しています。日常の接続・復旧操作は以下のREADME内で完結します。

## 🪟 WindowsでDiscodex Relayを準備

WindowsのPC側操作アプリが **Discodex Relay** です。Relayは常駐serviceではなく、必要なときだけ利用者が起動します。

### VB-CABLEの入手先とライセンス

**この項目はWindows版Discodexだけが対象です。macOS版はBlackHole 2chを使用するため、VB-CABLEは不要です。** Windows版はVB-Audio Softwareの通常版 **VB-CABLE for Windows** を外部audio driverとして使用します。VB-CABLEはMITなどのopen-source licenseではなく、公式区分は **Donationware Simple** です。Discodexのrepository、release、installerにはVB-CABLE本体を同梱しません。利用者が公式配布元から直接入手し、VB-Audioの条件に同意して導入してください。

| 項目 | 内容 |
| --- | --- |
| 公式download・導入手順 | [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) |
| ライセンス説明 | [VB-Audio Licensing](https://vb-audio.com/Services/licensing.htm) |
| 通常版Windowsライセンス購入 | [VB-CABLE Windows WebShop](https://shop.vb-audio.com/en/win-apps/11-vb-cable.html) |
| 対象OS | **Windows版のみ**。macOS版Discodexの要件ではありません。 |
| 2026年8月28日時点の表示価格 | 通常版VB-CABLE for Windowsは **1 licenseあたりUS$5.00**。公式WebShopのUSD表示価格です。 |
| volume価格（同日時点） | 10 licenses: US$4.17/本、100: US$3.61/本、1,000: US$2.92/本、10,000: US$2.50/本。 |
| 課金形態 | 月額subscriptionではなく、任意額を選ぶdonationware方式。継続課金はありません。 |
| 個人の試用 | 全機能を試用でき、有用ならlicense支払いを求める方式です。MITのようなopen-source licenseではありません。 |
| 業務・法人・団体・server利用 | 公式条件では有償licenseが必要です。利用者数またはPC数に合わせて購入し、大量導入はvolume licensingを確認してください。 |
| 再配布 | Discodexは再配布しません。VB-CABLEを他製品へ同梱・再配布する場合は、VB-Audioのdistribution条件が別途適用されます。 |

個人のWindows PC 1台でDiscodexを使う場合、このprojectに必要なのは通常版VB-CABLE 1 licenseだけです。有償download型の **VB-CABLE A+B / C+D** は不要であり、通常版とは購入・再配布条件が異なります。価格、税、為替、licenseの単位、PC変更、再取得条件は変更される可能性があるため、決済時に公式WebShopの表示を必ず確認してください。

1. Node.js 26+、ffmpeg、VB-CABLE、Codex Desktopを用意します。
2. リポジトリのrootでRelayアプリを生成します。

   ```powershell
   npm run build:relay:windows
   ```

3. 生成された `dist\Discodex Relay.lnk` をダブルクリックします。
4. 主ボタンが `Prepare Codex` なら、それを1回押します。必要なCodex準備と安全確認はRelayが行います。`Start Relay` なら、それを1回押します。
5. `RELAY READY / VOICE DISCONNECTED / CODEX ROUTE READY` に相当する表示を確認します。Relay起動だけでDiscord Voiceには参加しません。

画面共有は現在の公開機能に含まれません。PC通常ユーザーアカウントをCodexが操作するprototypeはDiscordのSelf-Bot方針に適合しないため採用せず、bot-owned Go Liveは公式に公開・承認されたpublisher経路を確認できるまで保留しています。根拠と再開条件は [Project Raphael](docs/PROJECT_RAPHAEL.md) を参照してください。
6. `GPT Live → Discord output volume` を25〜100%で選び、`Apply` を押します。既定値は50%で、Discordへ送るCodex音声だけが対象です。

Windowsの既定マイクやスピーカーは変更しません。

## 📱 Discordから接続する

1. PCで対象のCodexタスクを開き、Discodex Relayを`READY`にします。
2. 許可済みのDiscordテキストチャネルで `/status` を実行し、`disconnected` かつ異常表示がないことを確認します。
3. 同じチャネルで `/connect` を1回実行します。Discodexは対象Codexタスク、単一runner/lock、Discord Voice Ready、DAVEを確認してから`Connected.`を返します。
4. スマホで許可済みの音声チャネルへ参加し、通常どおり話します。

`/connect`を連打しないでください。失敗した場合は、返された具体的な失敗理由と `/status` を確認します。

## 🖥️ PCの音声とマイクへ戻す

Discordの通話を終えてPCでCodex Voiceを使うときは、次の順番で操作します。

1. Discordの許可済みテキストチャネルで `/disconnect` を1回実行します。
2. `Disconnected.` の応答を確認します。
3. DiscodexがDiscord Voice退出、CodexのPCスピーカー再生、元の物理マイク、runner/lockを復元します。Codex Desktopと現在のタスク自体は終了しません。
4. Relayのcontrolも終了したい場合だけ、復元後にRelayアプリの `Stop Relay` を押します。

| 操作 | 役割 |
| --- | --- |
| Discord `/disconnect` | 通話切断とPC音声・物理マイクの復元 |
| Relay `Stop Relay` | 復元後のDiscord command control終了 |

runnerまたはlockが有効な間、Relayはアプリ終了やcontrol停止を拒否します。先に `/disconnect` を使ってください。

## 🍎 macOSテスター向け

macOS 13+（Apple Silicon / Intel）向けの実装は完了しており、現在は**Mac実機での最終受入待ち**です。実装済みの範囲は次のとおりです。

- BlackHole 2chを直接選択する専用Core Audio host（macOS全体の既定入出力は変更しません）
- 開いている対象CodexタスクのWebRTC senderだけを差し替え、`/disconnect` または異常時に元の物理マイクへ戻すattach/rollback
- macOS本番runner、Login Keychainからのtoken取得、Apple Silicon / Intel両対応の公式libdave build
- DAVE、双方向音声、2往復、ratchet/epoch、ログ秘匿を機械判定するE2E証跡検査

Windows用のVB-CABLEはmacOSでは使いません。macOS経路は **BlackHole 2ch + Core Audio** です。Windows上の自動テストはMac実機合格の代替にならないため、下記の受入が完了するまではWindows版と同じ「対応済み」表記にはしません。

### 必要なもの

- macOS 13以降、Node.js 26以降
- BlackHole 2ch（48,000 Hz・2ch）、ffmpeg、Xcode Command Line Tools、CMake
- Codex Desktopのマイク権限
- Login Keychainに保存したDiscord bot token
- `config/meetron-macos-live.example.json` をコピーした `runtime/meetron-macos-live.json`（許可するDiscord IDだけを設定）
- Windows Relayと共通の `runtime/discodex-relay.thread-id`（対象Codex task UUIDを1行で保存。起動時の手入力は不要）

### 初回構築と自動テスト

```zsh
git clone https://github.com/omusubiman5/discodex.git
cd discodex
npm ci
zsh scripts/build-libdave-addon-macos.sh
npm run build:coreaudio:macos
npm run build:relay:macos
npm test
npm run test:acceptance
```

### Codexとブリッジの起動

Windows版と同じくGUIから起動します。Codex Desktopで対象タスクを開き、Finderで次をダブルクリックします。

```zsh
dist/Discodex Relay.app
```

Relayの `Prepare Codex` または `Start Relay` を押し、許可済みDiscord text channelで `/status`、`/connect` の順に実行します。検証後は `/disconnect` を実行し、Relayを終了します。最新の自動保存証跡を検査する場合だけTerminalを使います。

```zsh
node scripts/verify-macos-e2e-evidence.mjs "$(ls -t outputs/discord-production-control-macos-*.jsonl | head -1)"
```

### 実機合格条件

- 外部Discordの声が、指定したCodexタスクだけへ届く
- その発話に対応するCodexの音声応答がDiscordへ戻る
- 2往復以上、割り込み発話、voice channel再参加が成功する
- DAVEが有効で、音漏れ、物理マイク混入、feedback、clippingがない
- `/disconnect` 後もCodex Voiceは生きたまま、元の物理マイク、runner、lockが復元される
- E2E証跡検査が成功し、token、Discord ID、発話本文、音声dataがログに含まれない

Keychain登録、設定ファイル、障害時の復旧、全チェック項目は[macOS E2E Runbook](docs/MACOS_E2E_RUNBOOK.md)を参照してください。

フィードバックには次の情報だけを含めてください。

- Macのモデル（Apple Silicon / Intel）、macOS、Node.js、ffmpegのversion
- 失敗したコマンドと、token・Discord ID・発話内容を除いたエラー
- 自動テストまでか、実Discord通話までか

token、Discord ID、招待URL、発話内容、音声dataはIssueやチャットへ貼らないでください。

## 💬 Discordコマンド

| コマンド | 動作 |
| --- | --- |
| `/connect` | 許可済み音声チャネルからCodex Voiceへ接続 |
| `/disconnect` | ブリッジ所有の経路だけを安全に切断 |
| `/status` | 接続、音声経路、DAVEの状態を表示 |
| `/gain` | 許可範囲内で返送音量を調整 |

Windowsでは同じ出力ゲインをDiscodex Relayのスライダーからも調整できます。

## 🧪 検証

```powershell
npm test
npm run test:acceptance
npm run preflight:discord
npm run dry-run:discord
```

自動テストは秘密情報や外部socketを使わず、安全境界、Discord制御、DAVE、音声codec、Windows Relay、macOS adapterを検証します。実通話の受入完了には対象OS上でのE2E証跡が必要です。

## 🔒 セキュリティ境界

- bot tokenを設定ファイル、ログ、Gitへ保存しない
- Discord ID、招待URL、音声、発話本文を監査ログへ出さない
- allowlist外のguild、channel、userからの操作を拒否
- DAVE無効化、平文fallback、別AIセッションへの代替を拒否
- ブリッジ停止時はCodex Desktop本体や現在のタスクを終了しない

詳細は🛡️ [技術・運用Runbookの安全・運用方針](docs/DISCORD_VOICE_RUNBOOK.md#security-policy)を参照してください。

## 📜 ライセンス

第三者コンポーネントとライセンスは[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に記載しています。
