# Discodex Relay 実行方針

## Build

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-discodex-relay.ps1
```

生成物は `dist/Discodex Relay.lnk`。Enterprise signing policyを変更せず、Windows標準の署名済みWindows PowerShellで固定WinForms scriptだけを起動する。追加packageは導入しない。

## Runtime

- `runtime/discodex-relay.thread-id` に既存の対象Codex task identityを一行で保持する。
- Relayはrepository外のscript、任意command、任意URLを受け取らない。
- 通常起動ではWindows Forms画面を表示し、明示的な `Start Relay` 操作までcontrolを起動しない。
- 画面はRelay/Discord voice状態、GPT Live→Discord出力ゲイン、25–100%安全範囲、既定50%、-1 dBTP limiterを表示する。
- 画面はCodex route Readyも表示する。未準備時は主ボタンが`Prepare Codex`となり、技術引数を利用者へ見せず、確認付きのgraceful restartとendpoint readbackを実行する。
- Codex準備はrunner=0、lock=false、control<=1でのみ許可する。複数Codex root、port競合、target不一致はfail-closedとする。利用者確認後の再起動ではgraceful closeを優先し、残留時のみ同一Codex packageの事前取得PID群を限定停止する。通常Chromeや他プロセスは対象にしない。
- 既にcontrolが動作中なら二つ目を作らず失敗表示する。
- `--probe` はfile/config/prerequisiteのread-only確認だけを行い、controlを起動しない。
- `--quiet` は担当側検証用で、message boxを表示せず同じproduction入口を起動する。

## Verification

1. source policy/static test
2. compiler build
3. Relay `--probe`
4. gain get/set/readbackと範囲外拒否
5. GUIのStart/Stop/Status/Gain境界のstatic/focused test
6. control=0/runner=0/lock=falseからRelay `--quiet`
7. control=1、runner=0、lock=false、fresh `discord-ui-ready`、stderr空
8. Discord `/status`
9. 内部gate通過後のみ実 `/connect` Voice E2E

## 停止条件

- 対象Codex task、Codex Desktop root、Discord guild/channelが一意でない。
- control、runner、lockの重複がある。
- DPAPI credential、VB-CABLE、route rollbackが正本gateを通らない。
