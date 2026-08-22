# Codex Discord Voice Bridge

外出先のスマートフォンから、招待制Discord音声チャネルを経由して、自宅・作業PC上のPM Codexへ音声で指示するためのローカルブリッジです。Discordを唯一のMVP transportとし、Google Meetは共通境界を検証する将来adapter候補としてのみ残します。

```text
Smartphone Discord
          <-> transport adapter
          <-> transport-neutral session core
          <-> isolated OS audio adapter
          <-> current PM Codex voice task
```

## 現在できること

- 共通のsession/config/policy契約からDiscordの接続計画を生成する
- 将来候補のMeet adapterが同じcontractへ適合できることをdry-runだけで確認する
- Discordの最小権限、Voice Gateway v8、DAVE必須条件を検査する
- 明示開始/停止だけを許可するsession lifecycleを実行する
- guild/channel/user allowlistと過剰bot権限を拒否する
- Discord ID、token、発話本文を含めない構造化監査イベントを生成する
- 実token、実ID、外部socket、音声デバイス変更を一切使わないdry-runを実行する
- 秘密値らしい設定キー、loopback外CDP、平文fallback、prompt本文保存を拒否する
- ローカル契約テストで安全境界を確認する

まだ外部接続、Discord server/application作成、bot token発行、音声I/O、Codex操作、常時参加は実装していません。

## ローカル検証

Node.js 24以降で実行します。依存packageのinstallは不要です。

```powershell
cd C:\Projects\codex-discord-voice-bridge
npm test
npm run preflight:discord
npm run dry-run:discord
npm run dry-run:meet
```

dry-runは常に `blocked` で終了し、未実装の外部接続と実設定をblockerとして表示するのが正常です。

## 構成

```text
src/core/                 transport非依存の契約・設定・session・redaction
src/adapters/discord/     Discord計画とDAVE fail-closed policy
src/adapters/meet/        将来候補のGoogle Meet adapter境界
config/                   秘密を含まない設定template
tests/                    外部接続を使わない契約試験
docs/                     方針・設計・安全境界・PoC判断
```

OS固有の音声入出力、仮想デバイス、権限、配布は将来の `platform/windows` と `platform/macos` adapterへ閉じ込めます。共通コアはWASAPI、Core Audio、ドライバー、Keychain、Credential Managerを直接呼びません。

## Discord最小PoC

主経路は `スマートフォン -> 専用招待制Discord voice channel -> PC bot participant -> PM Codex` です。テキストは `/pm ask`、`/pm status`、`/pm stop` のapplication commandと、専用通知channelへの状態通知だけを対象にします。任意message本文の監視は行いません。

DAVE暗号処理にはDiscord公式 [`discord/libdave`](https://github.com/discord/libdave) だけを第一候補として条件付き採用します。独自暗号、DAVE無効化、平文fallbackは禁止です。libdaveは完全なDiscord voice clientではないため、Voice Gateway、UDP/RTP、Opus、jitter bufferは別層で必要です。Nodeから公式C APIを薄いnative addonで呼ぶ案を優先し、公式WASMのNode適合は並行検証候補です。

詳細: [Discord PoC](docs/DISCORD_POC.md) / [DAVE評価](docs/DAVE_EVALUATION.md)

## 設定と秘密情報

- `config/bridge.example.json` はplaceholderだけを含む。
- `.env.example` は変数名だけで、token値を置かない。
- 将来のbot tokenはWindows Credential Manager/DPAPIまたはmacOS Keychainへ保存する。
- token、Discord snowflake、招待URL、Meet URL、発話本文をログへ出さない。
- Discord user/guild/channelは明示allowlistで照合する。

## 文書

- [プロジェクト方針](docs/PROJECT_POLICY.md)
- [最小設計](docs/MINIMAL_DESIGN.md)
- [安全境界](docs/SAFETY_BOUNDARIES.md)
- [Discord最小PoC](docs/DISCORD_POC.md)
- [公式libdave評価](docs/DAVE_EVALUATION.md)
- [Discordローカル設定](docs/DISCORD_LOCAL_SETUP.md)

## ステータス

- フェーズ: 共通コア実装済み、Discord実接続前
- 外部接続・公開: なし
- 資格情報設定: なし
- 実音声・常時参加: なし
- Discord DAVE判断: 公式libdaveを条件付き採用、Node統合probe待ち
- Gateway進捗: Identify、Gateway Ready、Voice State/Server両event待機をpure state machineとして実装済み
- Meetron: GPL-3.0-onlyの参考実装に限定し、コードを取り込まない
