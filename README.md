# 🎙️ Discodex — Codex Discord Voice Bridge ✨

🌍 [English](README.en.md)

**スマホのDiscordから、自宅・作業PCのGPT Live（Codex Voice）を呼び出し、現在のCodexタスクを起動・接続・操作する**ためのローカル音声ブリッジです。独立したチャットボットではなく、DiscordをGPT Liveの遠隔入口にします。📱↔️💻

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
| 🍎 macOS | 🚧 部分対応 | Keychain、ffmpeg Opus/PCM adapter、POSIX native-addon loader、共通コア |
| 🐧 Ubuntu | ⏳ 予定 | GPT Live（Work / Codex Voice）のUbuntu公式対応後に開発・実機検証予定 |

macOSの部品と自動テストは実装済みですが、Core Audio実通話ランナーとMac実機E2Eは未完了です。現時点では「WindowsとMacの完全対応」とは表記しません。

Ubuntu向けDiscord/DAVE/Opus基盤は技術的に移植可能ですが、現在GPT Live（Work / Codex Voice）はUbuntu/Linux向けの公式デスクトップ機能として提供されていません。そのため、DiscodexのUbuntu版は現時点では未対応です。[OpenAIによるUbuntu対応](https://help.openai.com/en/articles/20001275/)後に、音声経路の実装と実機E2E検証を開始します。

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
- Discord botと招待制Discordサーバー
- Discord公式DAVE対応のnative addon
- Codex Desktopと対象のVoice Talkタスク
- 🪟 Windows: VB-CABLE、ffmpeg、PowerShell
- 🍎 macOS: ffmpeg、Keychain（実通話ランナーは開発中）
- 🐧 Ubuntu: GPT Live（Work / Codex Voice）の公式対応待ち。現時点ではサポート対象外

## 🛠️ インストール

秘密情報をリポジトリへ保存しないでください。WindowsではDPAPI、macOSではKeychainを使用します。🔑

```powershell
git clone https://github.com/omusubiman5/discodex.git
cd codex-discord-voice-bridge
npm ci
npm test
npm run preflight:discord
```

セットアップで使うDiscord botには `VIEW_CHANNEL`、`CONNECT`、`SPEAK`、`SEND_MESSAGES`、`READ_MESSAGE_HISTORY`、`USE_APPLICATION_COMMANDS` だけを許可します。guild、voice/text channel、許可userはGit対象外の `config/bridge.local.json` に設定し、bot tokenはWindowsではDPAPI、macOSではKeychainに保存します。JSON、`.env`、コマンド引数、チャットにtokenを書かないでください。

設定値と資格情報の準備は ⚙️ [Discordローカル設定](docs/DISCORD_LOCAL_SETUP.md)、公式libdaveのビルドと障害調査は 📘 [運用Runbook](docs/DISCORD_VOICE_RUNBOOK.md) にあります。日常の接続・復旧操作は以下のREADME内で完結します。

## 🪟 WindowsでDiscodex Relayを準備

WindowsのPC側操作アプリが **Discodex Relay** です。Relayは常駐serviceではなく、必要なときだけ利用者が起動します。

1. Node.js 26+、ffmpeg、VB-CABLE、Codex Desktopを用意します。
2. リポジトリのrootでRelayアプリを生成します。

   ```powershell
   npm run build:relay:windows
   ```

3. 生成された `dist\Discodex Relay.lnk` をダブルクリックします。
4. 主ボタンが `Prepare Codex` なら、それを1回押します。必要なCodex準備と安全確認はRelayが行います。`Start Relay` なら、それを1回押します。
5. `RELAY READY / VOICE DISCONNECTED / CODEX ROUTE READY` に相当する表示を確認します。Relay起動だけでDiscord Voiceには参加しません。
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

macOS 13+（Apple Silicon / Intel）は現在、**公開試験中**です。共通コア、Keychain資格情報、ffmpeg Opus/PCM adapter、POSIX native-addon loaderはありますが、Core Audio実通話runnerとMac実機E2Eは未完了です。Windows版と同じ完成度ではありません。

まず安全な非接続検査を実行してください。

```zsh
git clone https://github.com/omusubiman5/discodex.git
cd codex-discord-voice-bridge
npm ci
npm test
npm run test:acceptance
npm run preflight:discord
npm run dry-run:discord
```

必要条件はNode.js 26+、ffmpeg、Xcode Command Line Tools、CMake、ログインKeychainです。公式libdave addonはMacの実際のアーキテクチャ（arm64 / x64）とNode ABIに合わせてビルドします。ビルド手順は [運用RunbookのmacOS節](docs/DISCORD_VOICE_RUNBOOK.md#macos) を使ってください。

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

詳細は🛡️ [安全境界](docs/SAFETY_BOUNDARIES.md)を参照してください。

## 📜 ライセンス

第三者コンポーネントとライセンスは[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)に記載しています。
