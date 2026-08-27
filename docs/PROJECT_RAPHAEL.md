# Project Raphael

**Internal codename:** Raphael

**Public description:** AI support platform for Discord experience creators

## Purpose

DISCORDERは、ゲーム、趣向、生活、衣食住に関する情報や購入提案を組み合わせ、Discord上の参加型体験を提供する人間のcreatorである。Project Raphaelは、DISCORDERの調査、個別最適化、運営、許可済み作業をAIで支援する基盤である。Discodexは、RaphaelをDiscordへ接続するmoduleである。

## Architecture

```text
DISCORDER: 体験、情報、趣向、購入提案を設計・提供
  └─ Project Raphael: DISCORDERを支援
       ├─ Discodex: Discord voice/video、mobile entrypoint、permission、session
       ├─ Raphael AI: 調査、画面理解、個別最適化、運営支援
       ├─ Skills: メール、予定、通知などの許可済み外部作業
       ├─ HAOS adapter: 掃除機、空調、照明、生活環境
       └─ Knowledge/Coach: onboarding、攻略knowledge、録画、比較、team memory
```

権限検証、identity分離、監査、fail-closedはRaphael内部の安全実装であり、DISCORDERとは別のcreator roleを新設しない。

## Experience

1. 許可された利用者が外出先のDiscordからhostを起動する。
2. botが公式経路でゲーム画面を配信し、同じcaptureをAIの画像入力へ分岐する。
3. 利用者は「この戦闘中に有効なアイテムは？」のように音声で質問する。
4. AIは戦況・所持品・文脈を確認し、Discord音声で短く回答する。
5. AIはメール、予定、家事通知を優先度別に処理し、ゲームへの不要な割り込みを抑える。

## HAOS control

RaphaelはHome Assistantのallowlist済みscript/sceneだけを呼び出し、ゲーム状態と生活環境を連動させる。

- **ロボット掃除機:** プレイ開始時や重要場面では一時停止し、許可されたoff-timeに再開する。
- **空調:** 室温・湿度・在室状態と利用者設定を基に、許可範囲内で設定温度・mode・fanを調整する。
- **照明:** ゲームeventごとに許可済みsceneを適用する。戦闘中は没入用scene、戦闘終了時のoff-timeは明るい回復sceneへ戻す。
- **readback:** 各操作後にHAOS entity stateを確認し、失敗時は前sceneまたは安全既定値へ戻す。

ゲームeventから直接任意device actionを生成せず、`battle_start`、`battle_end`、`off_time`などの検証済みeventを固定Home Assistant script/sceneへ対応付ける。

## Onboarding companion

- 初回起動時に基本設定、操作、技、itemを画面文脈に合わせて音声案内する。
- 利用者がゲームを止めてWikiを検索・通読せず、公式guideまたは利用許諾されたknowledgeから必要な情報だけを回答する。
- 初心者、復帰者、platformごとの操作差へ説明量を適応し、spoiler範囲は利用者が選択する。

## Esports coach and team memory

- 明示的な録画操作、参加者同意、録画中表示、保存先、保持期間を分離して管理する。
- 「ボス戦になったから録画して」で試合映像、会話、game event、装備、party、versionを時刻同期する。
- 戦闘前に過去の同boss動画をDiscordでチーム視聴し、前回の失敗、成功、今回の変更点を確認する。
- 戦闘後に撃破時間、phase、positioning、item/skill timing、死亡・回復箇所を前回と比較し、次回の練習課題を作る。
- competitive ruleがlive assistanceを禁止する場合はlive助言を停止し、試合後分析だけを許可する。

## Interruption policy

- **緊急:** 即時通知
- **重要:** 戦闘終了後に通知
- **通常:** セッション終了後に要約
- **許可済み操作:** AIが代行
- **未承認操作:** 実行しない

## Required boundaries

- user、role、guild、channel、Codex task、capture targetを開始前に検証する。
- 操作者、視聴者、bot、Codex、audio、video、runnerの権限とidentityを分離する。
- 通常Discordユーザーの自動操作やuser tokenを使用しない。
- ゲームprocessへのmemory injectionや入力自動化を行わず、画面認識と助言を基本とする。
- private network解析、anti-cheat回避、プレイヤーに見えない情報の取得、無人gameplayを行わない。
- bot-owned Go LiveはDiscordが公開または明示承認したpublisher経路だけを使用する。
- HAOSはentity allowlist、値の上下限、実行者、実行理由、before/after stateを記録する。
- lock、alarm、door、garageなどのsecurity-sensitive entityはRaphaelの既定許可対象に含めない。

## Current gate

Discordへ、検証可能な権限委譲型AI共同作業基盤を実現するためのbot-owned Go Live publisher経路を問い合わせる。公式経路が確認できるまで映像配信をrelease機能にしない。

## Naming

`DISCORDER`は人間の体験creator、`Raphael`はDISCORDER支援基盤のinternal project codename、`Discodex`はDiscord接続moduleおよび既存repositoryとする。公開名称・説明・画像では第三者作品との提携や公式性を示唆せず、`AI companion`を使用する。
