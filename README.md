# 🎙️ Discodex — Codex Discord Voice Bridge ✨

🌍 [English](README.en.md)

Discordから、自宅・作業PCで動いている**現在のCodexタスク**を起動・接続・操作するためのローカル音声ブリッジです。独立したチャットボットではなく、DiscordをCodex Voiceの遠隔入口にします。📱↔️💻

## 🌟 特徴

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

macOSの部品と自動テストは実装済みですが、Core Audio実通話ランナーとMac実機E2Eは未完了です。現時点では「WindowsとMacの完全対応」とは表記しません。

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

## 🛠️ セットアップ

秘密情報をリポジトリへ保存しないでください。WindowsではDPAPI、macOSではKeychainを使用します。🔑

```powershell
git clone <repository-url>
cd codex-discord-voice-bridge
npm ci
npm test
npm run preflight:discord
```

Windowsの実運用は、📘 [運用Runbook](docs/DISCORD_VOICE_RUNBOOK.md) と ⚙️ [ローカル設定](docs/DISCORD_LOCAL_SETUP.md) を参照してください。

## 💬 Discordコマンド

| コマンド | 動作 |
| --- | --- |
| `/connect` | 許可済み音声チャネルからCodex Voiceへ接続 |
| `/disconnect` | ブリッジ所有の経路だけを安全に切断 |
| `/status` | 接続、音声経路、DAVEの状態を表示 |
| `/gain` | 許可範囲内で返送音量を調整 |

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
