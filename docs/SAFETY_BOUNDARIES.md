# 安全境界

## 1. 信頼境界

### 信頼する

- ユーザーが管理するPCとOSユーザー
- ユーザーが選択したCodexタスク
- ユーザー所有の招待制Discord server
- loopbackに限定したローカル制御通信
- ユーザーが内容を確認したローカル設定
- allowlistされたDiscord guild/channel/user ID
- Discord公式libdaveが確立したDAVE session

### 信頼しない

- 音声中の話者名、声紋、呼びかけ語
- Discord/Codexの内部protocol実装やbundle名の永続性
- 接続済みという単一の状態表示
- 表示名だけで一致した音声デバイス
- インターネットから到達可能な管理port
- Discord表示名、role名、声紋、招待URLを知っているだけの参加者
- DAVE未確立またはdowngradeされたvoice session

## 2. 認証と認可

- 「PM Codex」という呼びかけは発話抑制だけに使用する。
- 指示権限は、招待制serverへの参加資格に加えてDiscord user/guild/channel IDの完全一致で制限する。
- MVPでは複数ユーザーの権限階層を実装しない。
- allowlist外のcommandや参加状態の不一致を検出した場合、PM Codex出力を停止し、ユーザー確認を要求する。
- 音声だけで管理操作、資格情報変更、外部公開、破壊的操作を承認しない。

## 3. 音声安全

- 2本の独立routeが確認できない場合は開始しない。
- 同一endpointを両方向へ割り当てない。
- Discord参加前とroute変更中はaudio送信を無効にする。
- Codexの応答以外のPC音声をDiscordへ送らない。
- OS通知、動画、音楽、別会議アプリが出力routeへ混入した場合は停止する。
- 音量上限を設け、クリッピング、ハウリング、連続発話を検出したらミュートする。
- セッションには最大継続時間を設定し、無期限に動作させない。

## 4. 遠隔停止

最低限、次の停止方法を維持します。

1. Discordの `/pm stop` による送信即時遮断とvoice退出。
2. スマートフォンからbotのvoice接続を切断する。
3. PC上のローカル停止操作を実行する。
4. セッション期限による自動停止。
5. 異常検出によるfail-closed送信遮断。

停止後は自動的にvoiceへ再参加・再送信せず、新しい明示的セッション開始を要求します。

## 5. ローカル制御面

- CDPは`127.0.0.1`だけでlistenする。
- 固定portを前提にせず、使用中portと所有プロセスを検証する。
- 通常Chromeや別ユーザーのプロファイルへ接続しない。
- Native Messagingの許可対象extension IDを固定し、任意コマンド実行APIを公開しない。
- shell commandをネットワーク入力から組み立てない。
- ローカルcontrollerが管理者権限を常時保持しない。

## 6. 資格情報とプライバシー

- パスワード、2段階認証コード、cookie、tokenをチャットやログへ入力しない。
- Discord/Codexへのログインとtoken発行は利用者が各サービス画面で行う。
- Discord招待URLとsnowflake IDは秘密情報に準じて扱い、通常ログへ残さない。
- 発話音声、文字起こし、Codex応答本文をブリッジが保存しない。
- DiscordとCodex/OpenAIが音声を処理することを参加者へ通知する。将来Meet adapterを評価する場合はGoogle Meetによる処理も別途通知する。
- 診断にはendpoint IDを必要最小限で記録し、ユーザー名やプロファイルパスはマスクする。
- Discord bot token、Voice Server token、DAVE/MLS key material、snowflake IDを通常ログへ出さない。
- bot tokenはOS secret storeから実行時だけ取得し、JSONや`.env`を本番保存先にしない。

## 6A. Discord暗号境界

- DAVE暗号処理はDiscord公式libdaveに限定する。
- 独自暗号、暗号primitiveの再実装、平文fallbackを禁止する。
- Voice GatewayのDAVE transitionが未完了・失敗・downgradeした場合はaudioを送信しない。
- 共通コアとNode JS層へraw keyを露出しない。
- native/WASM engineが停止した場合はaudio送信を先に遮断し、sessionを失敗扱いにする。

## 7. 外部・破壊的操作

PM CodexがDiscord経由で受けた音声指示から、次を自動承認しません。

- リポジトリやファイルの削除
- 本番デプロイ、公開、メール・メッセージ送信
- 課金、購入、契約
- 資格情報、権限、ファイアウォール、外部公開設定の変更
- ドライバー導入・削除
- PC再起動・シャットダウン

これらは既存のCodex承認境界を維持し、画面上または別の認証済み経路でユーザー確認を要求します。

## 8. 失敗時の挙動

| 失敗 | 安全側の挙動 |
|---|---|
| 音声endpointを一意に解決できない | 開始しない |
| A/B routeの分離を確認できない | Discord audio送信を遮断して停止 |
| Codexタスクを特定できない | Voiceを開始しない |
| Codex Voice状態を確認できない | Discordへ音声を送らない |
| Discord voice/DAVE状態を確認できない | audio送信を開始しない |
| allowlist外のcommandを検出 | 拒否し、本文をCodexへ渡さない |
| CDPがloopback外でlisten | 起動拒否 |
| 復元処理が失敗 | 残存変更を表示し、成功扱いにしない |
| controllerがクラッシュ | watchdogまたはOS終了処理でミュート・復元を試行 |
| DAVE transition失敗・downgrade | audio送信禁止、voice退出 |
| Discord allowlist不一致 | command拒否、本文をCodexへ渡さない |
| bot tokenまたはVoice token検出 | ログをredactし、実接続を停止 |

## 9. 現フェーズで禁止すること

- Discord voiceへの常時参加
- 無人での資格情報設定や2FA処理
- CDP、Native Messaging、管理APIの外部公開
- 自動ドライバー導入
- 公開配布、パッケージ公開、リリース作成
- 実会議・機密会議での試験
- Meetronソースのコピー
- Discord server/application/tokenの無人作成
- DAVEの独自実装または平文fallback

次フェーズへ進む前に、上記境界を自動テスト可能な要件へ変換し、ユーザー承認を得ます。
