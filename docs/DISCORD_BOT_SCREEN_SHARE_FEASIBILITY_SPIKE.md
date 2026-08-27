---
artifact: spike-summary
version: "1.0"
created: 2026-08-27
status: complete
---

# Spike Summary: Discodex botによるDiscord画面共有

## Overview

| Field | Value |
|---|---|
| **Question to Answer** | Discodexが通常ユーザーアカウントを自動操作せず、bot自身としてCodex画面をDiscord Go Live配信できるか |
| **Time-Box** | 公式一次資料を対象とする1回の集中調査 |
| **Actual Time Spent** | 1セッション |
| **Spike Lead** | Codex / Discord Voice Bridge担当 |
| **Date Completed** | 2026-08-27 |

## Background

PC版DiscordとPixelが同じDiscordユーザーアカウントだったため、PC側のGo Live開始後、Pixelには自己配信を別端末から視聴できない旨が表示された。回避案としてCodexがPC版Discordの画面共有ボタンを操作する実験を行ったが、この操作はbotではなく通常ユーザーアカウントの操作である。公開可能な製品経路か、bot自身による配信へ置き換えられるかを公式資料で再調査した。

## Approach

### What We Tried

1. PC版Discordの公式Go Live UIを手動操作し、Codex画面の配信開始・停止を実機確認した。
2. Pixelから同一アカウントの配信視聴を試し、Discordクライアントの拒否表示を実測した。
3. Discord公式のSelf-Bot方針、Developer Policy、Permissions、Voice Gateway、Voice Opcodes、DAVE whitepaper、公式libdaveを照合した。
4. 現行リポジトリの権限、Voice Gateway、DAVE、映像encoder/RTP、画面共有prototypeをread-only監査した。

### Technologies/Tools Evaluated

- Discord desktop/mobile公式クライアント
- Discord Bot API / Gateway / Voice Gateway v8
- Discord DAVE protocol / `discord/libdave`
- 現行Discodex音声transport

## Findings

### Finding 1: 通常ユーザーアカウントのUI自動操作は採用できない

Discordは、OAuth2/bot API外で通常ユーザーアカウントを自動化することを禁止している。本人の明示許可はDeveloper Policy上必要だが、Self-Bot禁止を解除する例外ではない。回数が一回、操作が公式UIのクリックだけ、という例外も公式文書にはない。

**Evidence:**

- [Automated User Accounts (Self-Bots)](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots): 通常ユーザーアカウントの自動化を禁止。
- [Platform Manipulation Policy Explainer](https://discord.com/safety/platform-manipulation-policy-explainer-oct-2023): account actionのautomationを避けるよう明記。
- [Discord Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy): ユーザー代理処理には明示許可が必要だが、他のPlatform Rulesも同時に適用。

### Finding 2: bot映像配信を構成する要素の一部は公式公開済み

DiscordはGo Live用`STREAM`権限、Voice Stateの`self_stream`、Voice Gatewayのvideo対応、DAVEの映像frame encryptionを公開している。DAVE whitepaperと公式libdaveはVP8、VP9、H.264、H.265のcodec-aware encryptionを扱う。

**Evidence:**

- [Permissions](https://docs.discord.com/developers/topics/permissions): `STREAM (1 << 9)` はGo Liveを許可。
- [Voice Resource](https://docs.discord.com/developers/resources/voice): `self_stream` はGo Live中のVoice Stateを表す。
- [Voice Connections](https://docs.discord.com/developers/topics/voice-connections): Voice Gateway v3でvideo、v5でVideo Sink Wantsを追加。
- [DAVE Protocol Whitepaper](https://daveprotocol.com/) と [discord/libdave](https://github.com/discord/libdave): audio/video E2EEと映像codec処理を公開。

### Finding 3: 公開仕様だけではbot Go Live publisherを完成できない

公開Voice Opcode表にはGo Live開始、stream signalling、映像SSRC/codec negotiation、Video Sink Wantsのpayload schemaが掲載されていない。公式資料はvideo対応の存在を示すが、botをGo Live publisherとして構築する完全な公開手順を提供していない。

**Evidence:**

- [Voice Opcodes](https://docs.discord.com/developers/topics/opcodes-and-status-codes): 公開表は0–9、11、13、21–31を記載するが、version historyにあるvideo用opcodeのschemaを掲載していない。
- [How It All Goes Live](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology): Go LiveはOS capture、codec negotiation、WebRTC、SFU routingを含む複数段階のpipeline。
- 公式Social SDKの公開機能はvoice communicationsを扱うが、screen-share/Go Live publisher APIは公式guide/indexで確認できなかった。

### Finding 4: 現行Discodexは映像送信を実装していない

現行botの要求権限は`VIEW_CHANNEL`、`SEND_MESSAGES`、`READ_MESSAGE_HISTORY`、`USE_APPLICATION_COMMANDS`、`CONNECT`、`SPEAK`で、`STREAM`は含まれない。Voice transportはOpus音声とDAVE audio frameのみで、映像capture、VP8/H.264 encoder、video RTP、Go Live signallingはない。

**Evidence:**

- `src/core/authorization.ts`
- `src/adapters/discord/voice-gateway-session.ts`
- `tests/adapters.test.ts`
- repository-wide `rg` audit（2026-08-27）

### Finding 5: 追加済みPC UI prototypeは製品経路として無効

`manage-discord-screen-share.mjs`と`discord-screen-share-control.ts`は、固定Codex taskへPC版Discord UI操作を依頼するprototypeであり、bot映像送信ではない。技術的なGo Live開始・停止は実機成功したが、通常ユーザーアカウント自動化になるためrelease対象にできない。

## Recommendation

**Decision:** Do Not Proceed（現在のPC UI自動操作方式） / Proceed with Conditions（bot-owned Go Live）

PC通常ユーザーアカウントをCodexが操作するscreen-share機能は無効化し、公開機能として案内しない。bot-owned Go Liveは、Discord Developer SupportまたはDiscord Developers Serverから、bot publisherの可否と承認済みsignalling/transport経路を確認できた場合だけ再開する。

### If Proceeding

- 既存bot identityだけを使用し、通常ユーザーtoken、self-bot、非公開endpointを使用しない。
- `STREAM`を最小追加権限として事前検証する。
- 公式またはDiscordが明示承認したvideo signalling、codec negotiation、DAVE video frame、RTP/SFU経路だけを使う。
- Pixelの同一ユーザーアカウントからbot streamを視聴できることを最終受入にする。

### If Not Proceeding

- PC通常ユーザーアカウントのUI自動操作を公開機能にしない。
- 別ユーザーアカウントを必須とする回避策を製品要件にしない。
- undocumented opcodeや第三者reverse-engineered protocolを推測で採用しない。

## Artifacts

| Artifact | Location | Description |
|---|---|---|
| PC Go Live開始証拠 | `outputs/discord-share-confirm.png` | 公式Discord desktopでの配信中表示 |
| Pixel拒否表示 | `outputs/pixel-watching-stream.png` | 同一アカウント別端末での実測表示 |
| 停止・音声維持証拠 | `outputs/discord-share-stop-readback.png` | 画面共有終了後もDiscord voiceを維持 |
| 無効化対象prototype | `src/core/discord-screen-share-control.ts` | 通常ユーザーUI操作を固定taskへ依頼する実験実装 |
| 無効化対象helper | `scripts/manage-discord-screen-share.mjs` | 上記prototypeのrunner |

## Open Questions

- [ ] Discordはbot accountによるGo Live publishingを公式に許可・サポートするか。
- [ ] 公開されていないvideo signalling/payload schemaへ、承認済みアクセス経路があるか。
- [ ] bot publisherで必要なDAVE video/SFU conformance testは何か。

## Follow-up Items

| Action | Owner | Timeline |
|---|---|---|
| PC通常ユーザーUI prototypeをrelease対象から除外 | Discodex maintainer | 次回release前 |
| Discord Developer Supportへbot Go Live publisher可否と正式経路を照会 | Product owner | 実装再開前 |
| 承認経路取得後にarchitecture/acceptanceを再定義 | Planner / maintainer | 回答受領後 |
