# Discodex Relay アプリ ユーザーニーズ

## 目的

Windows 利用時に `Discodex Relay.lnk` を必要時だけ起動し、ネイティブアプリ画面からRelayの起動・停止・状態確認と、GPT LiveからDiscordへ返す音声の出力音量を安全に調整する。Discordの `/connect`、`/disconnect`、`/status`、`/gain` は既存の操作面として併用する。

## 利用者の操作

1. `Discodex Relay.lnk` をダブルクリックする。
2. アプリの主ボタンを押す。Codex音声routeが未準備なら、Relayが利用者へ起動引数を要求せず、確認付きでCodex Desktopの再起動、local attachment endpoint検証、control Readyまでを一括実行する。
3. `GPT Live → Discord output volume` を25–100%の範囲で調整し、`Apply`で保存する。
4. Discord で `/connect`、`/disconnect`、`/status` を操作する。
5. 音声通話を切断後、必要ならアプリの `Stop Relay` でcontrolを停止する。

OS ログオン時の自動起動、Scheduled Task、Windows service、custom URI、別 bot は使用しない。

## 必須成果

- Relay は既存 `start-discord-production-control-current.ps1` だけを固定起動する。
- Relay 起動中の重複起動を mutex で拒否する。
- 既存 control、runner、lock がある場合は既存 fail-closed gateを維持する。
- Relay 自体は Discord token、task内容、音声dataを保持・表示しない。
- Relay は control の `discord-ui-ready` 確認後だけ成功を表示する。
- 利用者はdebugger port、loopback endpoint、process ID、起動commandを設定・入力しない。
- Codex Desktopの通常起動を検出した場合は、技術的なエラーをDiscordへ丸投げせず、Relayアプリ自身が準備操作を提供する。
- アプリはRelay状態、Discord voice接続状態、現在のGPT Live出力ゲインを表示する。
- 出力ゲインは既存の安全範囲25–100%、既定50%、true-peak limiter -1 dBTPを維持する。
- 保存したゲインは既存guild/channel scopeへ永続化し、runnerへ動的に反映する。
- voice runner/lockが有効な間はアプリ終了やcontrol停止を拒否する。
- Relay起動だけでは音声runnerやDiscord Voice joinを開始しない。
- `/connect` のみが既存 single runner/atomic lock 経路を開始する。
- Windows global audio defaults と foreground Codex realtime lifecycleを変更しない。

## 受入条件

Relayアプリからcontrolを一つだけReadyにでき、状態確認とGPT Live出力ゲイン調整ができる。Discordからconnect/status/gain/disconnectを操作できる。最終合格には実Discord Voiceの双方向会話、再参加、クリッピングのない明瞭な返信、route rollbackが必要である。
