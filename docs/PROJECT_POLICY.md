# プロジェクト方針

## 1. 目的

Codex Discord Voice Bridgeの目的は、外出中のユーザーがスマートフォンの招待制Discord voice channelから、自宅または作業PC上のPM Codexへ安全に音声指示を送り、応答を聞けるようにすることです。Google MeetはMVP対象外の将来adapter候補です。

会議ボット一般、録音サービス、音声監視基盤を作ることは目的ではありません。最初は単一ユーザー、単一PC、単一の招待制Discord server、単一の選択済みCodexタスクに限定します。

## 2. 優先順位

判断が競合する場合は、次の順序を使用します。

1. ユーザーと会議参加者の安全・同意
2. 即時停止と音声遮断
3. 音声ループ、誤送信、他アプリ音声漏洩の防止
4. 認証済みユーザーだけが指示できること
5. 状態の観測可能性と復旧可能性
6. Windows/macOS間の同等性
7. 接続成功率と応答遅延
8. 自動化範囲と利便性

## 3. 対象プラットフォーム

- Windows: Windows 11を初期対象とする。
- macOS: macOS 13以降を初期対象とする。
- スマートフォン: Android/iOSのDiscord公式clientをMVP endpointとする。Google Meet公式clientは将来adapterを評価する場合だけ対象とする。

OS差分はadapterへ閉じ込めます。一方のOSだけで利用できる内部APIを、共通コアの前提にはしません。

## 4. コードとライセンス

- 新規コードは独立実装する。
- Meetronは動作・境界・失敗事例を学ぶ参考実装としてのみ扱う。
- MeetronのGPL-3.0-onlyコード、コメント、テスト、音声ドライバー実装をコピーしない。
- 外部依存を追加する前に、ライセンス、配布条件、更新主体、署名、アンインストール方法を記録する。
- プロジェクト自身のライセンスは、依存方針と公開方針を決めるまで未決定とする。

## 5. 設定と秘密情報

- リポジトリにDiscord/Google/OpenAI/Codexのtoken、cookie、招待URL、Meet URL、CDP port、ユーザープロファイルパスをコミットしない。
- 資格情報は本設計フェーズでは作成・保存しない。
- 将来のローカル設定は、秘密値と非秘密設定を分離する。
- ログには会議URL、発話内容、cookie、token、認証コードを出力しない。
- 診断bundleはユーザーが内容を確認してから明示的に生成する。

## 6. ネットワーク方針

- CDPとNative Messagingはloopbackだけで使用する。
- Discord以外のPC制御portをインターネットへ公開しない。
- 外出先スマートフォンとPC間のMVP経路はDiscord voiceだけとする。Google Meetは将来adapter候補であり、現行のfallback運用には使わない。
- Discord voiceはVoice Gateway v8、UDP/RTP、DAVE E2EEを前提とし、DAVE失敗時に平文へfallbackしない。
- 将来、別経路の状態確認やキルスイッチを追加する場合は、VPNまたは相互認証済みtransportを別機能として設計する。
- Gatewayが接続済みでも、Codex、DAVE、音声経路が正常とは判定しない。

## 7. Discord運用方針

- 専用の招待制server、voice channel、command channel、notification channelを使用する。
- 不特定多数が参加するserver/channelでは使用しない。
- PM Codexは人間と誤認されない表示名を使用する。
- 音声がAIサービスへ送られることを参加者へ事前に通知する。
- 録音・文字起こし・自動保存は既定で行わない。
- 常時参加は実装しない。ユーザーが開始した時間制限付きセッションを基本とする。
- guild/channel/user IDを明示allowlistにし、表示名や声紋を認証に使わない。
- text指示はapplication commandを基本とし、一般message本文を監視しない。
- bot tokenはWindows Credential Manager/DPAPIまたはmacOS Keychainへ保存し、設定fileやログへ出さない。
- 最小権限だけを付与し、administratorやmember管理権限を要求しない。
- 暗号engineはDiscord公式libdave以外を採用せず、独自暗号を実装しない。

## 8. 変更管理

- 音声デバイス、既定入出力、Discord送受信状態を変更する前に現在値を保存する。
- 正常終了、失敗、タイムアウトのいずれでも復元を試みる。
- 復元できなかった場合は成功扱いにせず、残存変更を具体的に表示する。
- ドライバー導入、管理者認証、OS再起動、Discord application/token発行、Codexログインはユーザー操作とする。

## 9. 完了条件

MVP完了は、両OSで主要な遠隔E2E試験に合格し、安全境界と復元試験を満たした時点とします。片方のOSだけの成功、ローカル同一LANだけの成功、接続表示だけの成功はMVP完了としません。
