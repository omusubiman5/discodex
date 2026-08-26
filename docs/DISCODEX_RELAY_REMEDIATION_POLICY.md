# Discodex Relay 修正方針

## 採用構成

```text
利用者が Discodex Relay.lnk を必要時に起動
  -> アプリの Start Relay / Stop Relay / Status / GPT Live output gain UI
  -> 固定 start-discord-production-control-current.ps1
  -> 既存 Discord application-command control
  -> Discord /connect
  -> 既存 logged voice runner
  -> runtime/live-call.lock
```

## Policy classification

| ID | 差分 | 判定 | 根拠 |
|---|---|---|---|
| RELAY-01 | 必要時起動のWindows Relayアプリを追加 | required | 常駐やOS自動起動を使わず利用者が制御する方式 |
| RELAY-02 | 固定production-control入口だけを起動 | required | 既存single-control/allowlist/Ready gateの再利用 |
| RELAY-03 | 起動mutexとbounded timeout | required | 重複controlと無応答を防止 |
| RELAY-04 | Scheduled Task/service/URI登録 | prohibited | 利用者が不採用としたOS自動起動・URI方式 |
| RELAY-05 | 新しいbot/Gateway/runner | prohibited | 既存identityとsingle runnerを保持 |
| RELAY-06 | global audio default変更 | prohibited | 既存安全境界 |
| RELAY-07 | GPT Live→Discord出力ゲインUI | required | 実通話で音量過大・音割れが発生した受入結果 |
| RELAY-08 | Codex local audio routeのアプリ所有準備 | required | 利用者やCodexエージェントへdebugger endpoint設定を委ねない |
| RELAY-08 | 25–100%、既定50%、-1 dBTP limiter | required | 既存output-gain safety contract |

## 実装境界

- Relayは署名済みWindows PowerShellを固定hostにしたWindows Formsアプリとし、追加runtimeを同梱しない。
- RelayはCodex route未準備をread-only検出し、runner/lockがない場合だけ、利用者の明示確認を得てCodexを再起動する。最初にgraceful closeを試み、Windows packaged appがbackground processを保持した場合だけ、事前に固定した同一Codex package process setを限定停止する。固定loopback address/port、対象Codex package、app targetを検証後にのみcontrolをReadyにする。
- 配布入口は固定target/argumentsのWindows shortcutとし、未署名exeを生成しない。
- repository rootを実行位置から限定探索し、固定script以外を引数から受け取らない。
- task identityはlocal runtime fileから読み、形式不正ならprocess起動前に拒否する。
- Windows PowerShellはOS標準の固定pathを使う。
- アプリは固定start/stop/status/gain境界のみを呼び、任意commandを受け取らない。
- アプリが起動したcontrolは、voice runner/lockが0のときだけ停止・終了できる。

## Rollback

Relay.exeとlocal task設定を削除しても、既存script/control/runner実装には影響しない。OS registry、service、Scheduled Taskは作成しない。
