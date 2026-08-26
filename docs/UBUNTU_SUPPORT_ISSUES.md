# Ubuntu対応の課題一覧

更新日: 2026-08-26

## 結論

DiscodexのUbuntu版は現時点では未対応です。Discord/DAVE/Opusの共通基盤には移植可能な部分がありますが、製品の中核であるGPT Live（Work / Codex Voice）がUbuntu/Linux向けの公式デスクトップ機能として提供されていません。

Ubuntu対応は、[OpenAIによる公式対応](https://help.openai.com/en/articles/20001275/)後に開始します。基盤コードがLinux上で動くだけでは対応完了とせず、GPT Liveとの双方向音声接続と実機E2Eを必須とします。

## 外部前提

| ID | 課題 | 現在の状態 | 完了条件 |
| --- | --- | --- | --- |
| UBU-EXT-01 | GPT LiveのUbuntu/Linux公式対応 | 未提供 | OpenAIがUbuntu/Linux向けの対応環境、起動方法、音声入出力境界を公式に公開する |

この外部前提が満たされるまでは、Ubuntuを対応済みまたはベータ対応とは表示しません。

## 現行コードで確認した課題

| ID | 課題 | コード上の根拠 | 必要な修正 |
| --- | --- | --- | --- |
| UBU-001 | production runnerがWindows実装へ固定されている | `src/adapters/discord/production-control-runtime.ts` が `scripts/run-meetron-windows-live.mjs` を直接importしている | OS非依存のrunner contractを設け、Linux用runnerを明示的に選択する |
| UBU-002 | 音声routeがVB-CABLEとPowerShellへ固定されている | `scripts/run-meetron-windows-live-logged.ps1` とWindows audio hostがVB-CABLEを前提にする | PipeWire/PulseAudioでGPT Liveの対象streamだけを接続・復元するadapterを実装する。global defaultは変更しない |
| UBU-003 | Linux用の本番資格情報providerがない | `src/core/credentials.ts` はWindows DPAPIとmacOS Keychain以外をfail-closedする | Secret Service/libsecret等を用いたLinux用providerを追加し、tokenを設定file・argv・logへ出さない |
| UBU-004 | dependency preflightがLinuxをWindows toolchainとして扱う | `src/dependencies/preflight.ts` は`darwin`以外をすべて`windowsNativeBuild`へ分岐する | `linuxNativeBuild` manifestと明示的なplatform分岐を追加し、未知OSはfail-closedする |
| UBU-005 | Relay UIと配布入口がWindows専用 | `scripts/run-discodex-relay-app.ps1` はWindows Forms、`build-discodex-relay.ps1` は`.lnk`とWindows PowerShellを使用する | 共通control APIを維持したLinux向けUI/packageを用意する |
| UBU-006 | libdave native addonのLinux成果物が未検証 | 現行runbookと受入表はWindows/macOSのみを対象にする | 対象architecture・Node ABIでbuild/load/lifecycleを検証し、公式DAVE test vectorを通す |
| UBU-007 | Ubuntu向けrunbook、rollback、受入gateがない | `docs/DISCORD_VOICE_RUNBOOK.md` と `src/core/product-acceptance.ts` にLinux実機gateがない | install、route restore、rejoin、multi-turn、gain/clip、cleanupを含むUbuntu実機受入を追加する |

## 実装順序

1. OpenAIのUbuntu/Linux公式対応内容を確認し、対象GPT Live taskと音声入出力のsupported seamを固定する。
2. preflightのplatform誤分類を解消し、Linux toolchainとnative addon buildを検証する。
3. Linux資格情報providerとPipeWire/PulseAudio route adapterを実装する。
4. production runnerとRelay UIをOS別adapterへ分離する。
5. route attach/readback/restore、single runner/lock、Discord Voice Ready/DAVE、双方向音声を自動試験する。
6. Ubuntu実機でsource-isolated multi-turn E2E、再参加、明瞭性、rollbackを独立検証する。

## 対応完了の定義

次のすべてが揃うまでUbuntu対応とは表記しません。

- GPT LiveがUbuntu/Linuxで公式に利用可能
- Discordの許可ユーザーだけがconnect/disconnect/status/output gainを操作可能
- 単一runner・atomic lock・最小権限・秘密情報非露出
- OS全体の既定audio deviceを変更しないattach/restore
- Discord→GPT Live→Discordのsource-isolated実通話E2E
- multi-turn、disconnect/rejoin、DAVE epoch transition、明瞭音質、clip防止
- 異常終了後のroute restore、runner 0、lock解放
- Ubuntu向けinstall/runbook/rollbackと実機検証証跡

## 非対応中の扱い

- Ubuntu利用者へWindows用PowerShell/VB-CABLE経路を案内しない。
- Discord transportやunit testだけの成功をGPT Live統合の成功とみなさない。
- 非公式な画面操作や別のSTT/text/TTS経路を製品E2Eの代替にしない。
- 公式対応前にUbuntu対応済みとREADME、Release、配布物へ表示しない。
