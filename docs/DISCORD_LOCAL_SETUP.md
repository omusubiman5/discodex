# Discord実接続のローカル設定

この手順は外部Discord設定を行う段階で使用します。tokenをチャット、issue、JSON、command lineへ貼り付けません。

運用全体の入口は `DISCORD_VOICE_RUNBOOK.md` です。本書はDiscordローカル設定の詳細だけを担当します。

## 現在実行できるtoken不要検査

```powershell
cd C:\Projects\codex-discord-voice-bridge
npm test
npm run preflight:discord
npm run dry-run:discord
```

preflightが`blocked`を返すのは、実接続を誤って開始しないための正常動作です。

## 非秘密設定

実接続gateが開いた後、tracked templateをlocal fileへコピーします。

```powershell
Copy-Item config\bridge.example.json config\bridge.local.json
```

`bridge.local.json`にはguild ID、voice/text channel ID、許可user IDだけを設定します。このfileは`.gitignore`対象です。bot tokenは入れません。

## Token

`.env.example`は変数名だけを示し、値は常に空です。`.env`はGit対象外ですが、正式な保存先にはしません。

- Windows正式経路: Credential Manager/DPAPI adapter
- macOS正式経路: Keychain adapter
- 開発fallback: 現在のprocessだけに設定した `CODEX_BRIDGE_DISCORD_BOT_TOKEN`

開発fallbackを使う場合もtokenをcommand line argumentへ書かず、チャットへ送らず、終了後にprocess環境を破棄します。bridgeはcredential lease内でIdentify payloadを送った後、token本文を監査eventへ渡しません。

## Bot最小権限

- `VIEW_CHANNEL`
- `CONNECT`
- `SPEAK`
- `SEND_MESSAGES`
- `READ_MESSAGE_HISTORY`
- `USE_APPLICATION_COMMANDS`

`ADMINISTRATOR`、`MANAGE_*`、`MUTE_MEMBERS`、`MOVE_MEMBERS`は付与しません。OAuth install scopeは `bot` と `applications.commands` だけです。

## 外部設定gate

最初の外部操作はDiscord Developer Portalで専用Applicationを1つ作成することだけです。Application作成後もtokenをこの会話へ貼らず、次の指示までserver作成・bot install・token発行をまとめて行いません。
