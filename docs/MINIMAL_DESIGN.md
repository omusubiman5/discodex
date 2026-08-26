# 最小設計

## 1. システム境界

Codex Discord Voice BridgeはPC上で動作するローカルcontrollerです。DiscordとCodex Desktopの内部には組み込まず、transport、session、音声endpointを調整します。Google Meetは同じcontractへ適合できるかを将来検証するadapter候補です。

```text
[Smartphone Discord]
        |
        | selected transport
        v
[Discord adapter]
        | remote-to-Codex
        | Codex-to-remote
        v
[OS audio adapter: two isolated routes]
        |
        v
[Codex Desktop voice session / selected PM task]
```

## 2. 共通コア

共通コアはTypeScriptを第一候補とし、以下のOS非依存機能を持ちます。

### SessionOrchestrator

- 対象Codexタスク、Discord allowlist、セッション期限を検証する。
- adapterを順序付きで起動する。
- `idle -> planning -> ready -> starting -> active -> stopping -> stopped`を管理する。
- 計画にblockerがある場合は`blocked`へ遷移し、外部接続を開始しない。
- 明示開始、allowlist認可、明示停止が揃わない状態遷移を拒否する。

### AudioRouteModel

- `remoteToCodex`と`codexToRemote`を別endpointとして要求する。
- 同一endpointや物理スピーカーへの誤割当を拒否する。
- 保存した元設定と復元結果を追跡する。

### CodexController

- Codex Desktopの対象画面を特定する。
- 選択中タスクでVoice開始・停止を要求する。
- 音声入力・出力endpointとVoice状態を検証する。
- 非公開内部コマンドが見つからない場合は明示的に非対応とする。

### CommandPolicy

- 「PM Codex」への明示的な呼びかけを発話条件として設定する。
- 発話時間、無応答時間、セッション時間の上限を持つ。
- 呼びかけは認証に使用せず、Discord guild/channel/user IDの完全一致allowlistを信頼境界とする。
- 必須bot権限の欠落とadministrator/member管理権限の付与を拒否する。

### AuditLog

- 計画、開始、停止、command認可/拒否を連番付き構造化eventとして記録する。
- token、Discord ID、発話・応答本文はeventへ含めない。
- 現実装はmemory sinkとし、将来の永続化も同じ秘密非保持contractを要求する。

### Diagnostics

- Discord transport、DAVE、Codex bridge、Voice、A/B音声経路、ミュート、復元を個別表示する。
- 秘密情報と発話内容を収集しない。
- `connected`と`functional`を別状態として扱う。

## 3. Adapter契約

```ts
interface AudioAdapter {
  enumerateEndpoints(): Promise<AudioEndpoint[]>;
  resolveStableEndpoint(id: string): Promise<AudioEndpoint | null>;
  snapshotDefaults(): Promise<AudioDefaultsSnapshot>;
  assignRoutes(routes: RequestedRoutes): Promise<AppliedRoutes>;
  verifyIsolation(routes: AppliedRoutes): Promise<IsolationResult>;
  restore(snapshot: AudioDefaultsSnapshot): Promise<RestoreResult>;
}

interface PlatformAdapter {
  checkPermissions(): Promise<PermissionReport>;
  launchDedicatedChrome(options: ChromeLaunchOptions): Promise<BrowserHandle>;
  locateCodex(): Promise<CodexProcessInfo | null>;
  planInstallation(): Promise<InstallationPlan>; // 計画だけを返し、MVPでは自動実行しない
}

interface TransportAdapter {
  readonly kind: "discord" | "meet";
  plan(config: BridgeConfig): Promise<TransportPlan>;
  connect(): Promise<never>; // 現フェーズは外部接続をfail-closedで拒否
}
```

実装時は型を調整できますが、共通コアがCore Audio、WASAPI、レジストリ、shell scriptを直接呼ばない境界を維持します。

## 4. macOS adapter

- Core Audio UIDでendpointを識別する。
- 2本の独立loopback deviceを使用する。
- 音声ドライバー導入は署名・公証済みPKGを前提とし、ユーザー承認と再起動を要求する。
- 可能ならCodex/Chrome単位でendpointを設定する。
- アプリ単位指定が不可能な場合のみ、専用ユーザーで既定入出力を一時変更する。
- 終了時に元のUIDへ復元する。

Meetron Audioをそのまま取り込まず、必要なmacOS backendはライセンスを確認した独立実装または利用者導入済みデバイスへの接続として設計します。

## 5. Windows adapter

- MMDevice endpoint IDでendpointを識別する。
- 2本の独立したrender/capture pairを使用する。
- MVPでは利用者が明示的に導入した仮想音声デバイスを検出する。
- 自前SysVADドライバーの開発・署名・配布はMVP後の別工程とする。
- Windowsのマイクプライバシーとデスクトップアプリ許可を診断する。
- アプリ単位指定が不可能な場合は、専用ユーザーまたは専用PCで既定入出力を一時変更する。
- OS通知や他アプリ音声がDiscordへ漏れないよう、専用セッションと通知抑制を要求する。

## 6. 将来候補: Meet adapter

MeetはMVPやfallback transportではありません。将来評価する場合に限り、操作ロジックを共通化し、Chromeの起動・プロファイルパスだけをOS adapterへ委譲します。

- 専用Googleアカウントと専用Chromeプロファイルを使用する。
- CDPは`127.0.0.1`でランダムまたは設定済みlocal portに限定する。
- MeetのDOM/aria状態を確認し、参加、マイク、音声デバイスの結果を再検証する。
- 参加前はミュートを既定とする。
- 音声分離試験が成功するまで、自動アンミュートしない。

## 6A. Discord adapter

- Main Gateway、Voice Gateway v8、UDP/RTP、Opus、DAVE engineを別責務として分離する。
- DAVE engineはDiscord公式libdaveだけを使用し、共通コアやmedia層で暗号を実装しない。
- `connect`、`disconnect`、`status`、`gain` のapplication commandだけをtransport制御面とする。
- guild/channel/user allowlistと最小bot権限を接続前に検証する。
- Voice tokenとDAVE key materialを永続化せず、DAVE未確立時はaudioを送信しない。

詳細な順序と採否条件は `DISCORD_POC.md` と `DAVE_EVALUATION.md` に定義します。

## 7. 遠隔MVPフロー（Discord）

1. PC側で対象Codexタスクを選ぶ。
2. ユーザーが時間制限付きブリッジセッションを開始する。
3. ブリッジが権限、デバイス、Discord、DAVE、Codex Voiceを診断する。
4. 2本の音声経路を割り当て、無音・toneによる分離を確認する。
5. 専用Discord voice channelへbot participantとして入る。audio送信はまだ無効にする。
6. DAVEと音声分離の準備完了後だけaudio送信を有効にする。
7. ユーザーはスマートフォンの携帯回線から同じvoice channelへ参加する。
8. 「PM Codex」と呼びかけ、指示と応答を確認する。
9. `disconnect`、ユーザー操作、期限、異常のいずれかで停止する。
10. Discord送信遮断、voice退出、Codex Voice停止、音声設定復元の順で終了する。

## 8. 最小受け入れ試験

WindowsとmacOSの各環境で同じ試験を実施します。

### Audio-01 分離

- A/Bへ異なるtoneを流す。
- 逆流と自己入力がない。
- 10分間のハウリングが0件。

### Codex-01 現在タスク

- 選択済みPM CodexタスクでVoiceが開始する。
- 別タスクや新規タスクへ誤接続しない。

### Discord-01 安全参加

- allowlistされたguild/channel/userだけが指示できる。
- DAVEと分離の確認前はaudio送信が無効である。
- `disconnect` で2秒以内に出力が止まり、voiceから退出する。

### Remote-01 外出フロー

- スマートフォンのWi-Fiを切り、携帯回線から参加する。
- 20件中19件以上の指示でCodex応答がスマートフォンへ届く。
- 応答開始時間のp95が8秒以内。
- 30分の無指示状態で意図しない発話が0件。

### Recovery-01 復元

- 正常終了、Discord切断、DAVE失敗、Codex終了の各ケースで音声設定を復元する。
- 復元失敗を成功表示しない。
- 再実行時に前回の孤立プロセスやrouteを検出する。

## 9. 技術ゲートとフォールバック

### Gate A

Codex Desktop内で入力・出力endpointをアプリ単位に制御できるか。

### Gate B

できない場合、専用OSユーザー/専用PCの既定endpoint切替で他音声を漏らさず運用できるか。

### Gate C

両方が失敗した場合、直接Codex方式を停止する。ChatGPT Web VoiceまたはRealtime APIによる別会話は、現在のCodexタスクを引き継がない代替案として別途承認を得る。
