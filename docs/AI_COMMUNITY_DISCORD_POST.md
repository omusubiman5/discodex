# 🎙️ Discodexを開発しました！Mac実機検証にご協力ください 🍎✨

AIコミュニティのみなさん、こんにちは！👋  
今回、成果物として **Discodex（Codex Discord Voice Bridge）** を開発しました。

## 🚀 Discodexとは？

**スマホのDiscordから、自宅や作業PCのGPT Live（Codex Voice）を呼び出して、現在のCodexタスクを起動・接続・操作する**ためのローカル音声ブリッジです。

DiscordをGPT Liveの遠隔入口として使い、スマートフォンからCodexと音声で会話できます。📱↔️💻🤖

### 🌟 主な機能

- 📱 スマホのDiscordからGPT Live（Codex Voice）を呼び出す
- 🎙️ Discord音声からCodexへ話しかける
- 🚀 Discordの `/connect` から現在のCodexタスクを起動・接続する
- 🔊 Codexの応答音声をDiscord通話へ返す
- 🎛️ `/disconnect`・`/status`・`/gain` で安全に操作する
- 🧑‍🏫 会議の司会、議題進行、論点整理、要約をCodexに依頼する
- 🔐 招待制サーバーとallowlistで利用者・チャンネルを制限する
- 🛡️ Discord公式DAVEを利用し、平文通信へのfallbackを禁止する
- 🧼 token・Discord ID・発話本文をログに残さない

> 📝 会議進行支援は可能ですが、複数話者の厳密な自動識別や議事録の自動保存は別機能です。

## 🖥️ 対応状況

- 🪟 **Windows:** 実装・実通話検証済み
- 🍎 **macOS:** 共通コア、Keychain、音声codecなどを実装し、自動テストにも合格していますが、**Mac実機での通話E2E検証は未完了**です

## 🙏 Mac実機検証を助けてください！

Macをお持ちの方に、セットアップと実通話テストへのご協力をお願いしたいです。

特に確認したい項目はこちらです👇

- 📦 `npm ci` と自動テストが正常に完了するか
- 🔑 macOS Keychainから資格情報を安全に取得できるか
- 🎧 ffmpegによるOpus/PCM音声処理が動作するか
- 🎙️ マイク権限・音声入出力・Core Audio周辺で問題がないか
- 🔄 DiscordからGPT Liveへの入力と、GPT LiveからDiscordへの返送が成立するか
- 📝 エラーや分かりにくいセットアップ手順がないか

⚠️ 現在、macOSの実通話ランナーは未完成部分があります。テスト中に問題が発生する前提で、ログからtoken・個人情報・Discord IDを除いたうえでフィードバックをお願いします。

## 🔗 リポジトリ

**GitHub:** https://github.com/omusubiman5/discodex

公開リポジトリとして、macOSの非接続テストから試せます。実Discord通話はREADMEとRunbookの安全gateを確認した場合だけ実施してください。

## 💬 ご協力いただける方へ

この投稿への返信またはDMで、次の情報をお知らせください。

- Macのモデル（Intel / Apple Silicon）
- macOSのバージョン
- Node.jsのバージョン
- 利用できる音声デバイス
- テスト可能な範囲（自動テストのみ / Discord実通話まで）

バグ報告、改善案、READMEへのフィードバックも大歓迎です！🐛💡  
ご協力よろしくお願いします！🙌✨
