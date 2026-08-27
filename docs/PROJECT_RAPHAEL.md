# Project Raphael

**Internal codename:** Raphael

**Public description:** Permission-delegated AI companion for Discord

## Purpose

Discodexを、ゲーム中のプレイヤーが操作へ集中したまま、Discord音声からAIの支援を受けられる基盤へ拡張する。

## Experience

1. 許可された利用者が外出先のDiscordからhostを起動する。
2. botが公式経路でゲーム画面を配信し、同じcaptureをAIの画像入力へ分岐する。
3. 利用者は「この戦闘中に有効なアイテムは？」のように音声で質問する。
4. AIは戦況・所持品・文脈を確認し、Discord音声で短く回答する。
5. AIはメール、予定、家事通知を優先度別に処理し、ゲームへの不要な割り込みを抑える。

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
- bot-owned Go LiveはDiscordが公開または明示承認したpublisher経路だけを使用する。

## Current gate

Discordへ、検証可能な権限委譲型AI共同作業基盤を実現するためのbot-owned Go Live publisher経路を問い合わせる。公式経路が確認できるまで映像配信をrelease機能にしない。

## Naming

`Raphael`はDiscodex内部のproject codenameとする。公開名称・説明・画像では第三者作品との提携や公式性を示唆せず、`AI companion`を使用する。
