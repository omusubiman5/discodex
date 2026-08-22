# Discord公式libdave評価

## 結論

`discord/libdave` をDAVE暗号エンジンとして条件付き採用します。Discordの非Stage voice callでは2026年3月1日からDAVE E2EEが必須であり、独自暗号、旧暗号方式への固定、平文fallbackは選択肢にしません。

ただしlibdaveはDiscord voice client一式ではありません。Voice Gateway state machine、UDP/RTP、NAT discovery、Opus、jitter buffer、再接続は別の接続/media層が必要です。このため現時点の判断は「PoC採用」ではなく「P1 build/integration probeへ進める」です。

## 正確な参照先

- Repository: `https://github.com/discord/libdave`
- 提供主体: Discord公式organization
- 実装: C++ core、C API binding、Emscripten/WASM binding、JS helper
- License: MIT

JS packageの公開面は主にfingerprint、表示用code、pairwise verification helperです。大量のaudio frame暗号処理はC++ core側が担当します。JS directoryの存在だけでNode voice adapterへ直接組み込めるとは判断しません。

## 依存

- C++: `mlspp`、`nlohmann-json`、OpenSSL 1.1/3またはBoringSSL
- JS helper: `@noble/hashes`、`base64-js`
- build: CMake、対象toolchain。WASM候補ではEmscripten

依存の固定version、transitive license、供給元、脆弱性、配布物の署名/再現性をP1で記録します。project本体へ依存を追加するのはP1採用後です。

## Windows/macOS build可能性

公式CI matrixにWindows、macOS Apple Silicon、macOS Intelが含まれ、CMakeに両OS向け構成があります。このためbuild可能性は高いと評価します。ただし、利用するNode version/ABI、Visual Studio runtime、macOS deployment target、universal binary、code signingまで保証するものではありません。

P1で最低限確認する組合せ:

| OS | build | Node統合 | 配布確認 |
|---|---|---|---|
| Windows 11 x64 | MSVC/CMake | N-API addon | DLL/runtime、署名、DPAPI境界 |
| macOS Apple Silicon | Clang/CMake | N-API addon | arm64、notarization、Keychain境界 |
| macOS Intel | Clang/CMake | N-API addon | x64またはuniversal、deployment target |

## Node/JS adapter適合

### 第一案: C API + 薄いN-API addon

公式C++ coreとC APIをそのまま使い、lifecycleとframe bufferだけをNodeへ公開します。raw key、MLS credential、暗号primitiveをJSへ公開しない境界にできます。Windows/macOSのnative build、ABI、署名、クラッシュ隔離が課題です。

### 第二案: 公式WASM binding

配布を簡単にできる可能性がありますが、現行Emscripten設定のNode runtime適合、performance、memory copy、threading、secure memory消去を実測する必要があります。検証前に採用しません。

### 接続層の扱い

既存のNode voice libraryはGateway/UDP/Opus実装の参考または接続層候補になり得ます。しかし暗号engineが第三者DAVE実装に固定されている場合は、そのまま採用しません。公式libdaveへの差し替え点とprotocol conformanceが確認できる場合だけ評価します。

## Voice Gateway統合条件

- Main Gatewayから得るvoice endpoint/tokenをcacheしない。
- Voice Gateway v8を使用する。
- Identifyの `max_dave_protocol_version` を公式実装の対応値と一致させる。
- DAVE prepare/execute transition、MLS proposals/commit/welcome、epoch acknowledgementを正しい順序で処理する。
- SSRC/user mapping、participant追加/削除、再接続、resume時のkey stateを検証する。
- DAVE確立前とtransition失敗後はaudio送信を禁止する。
- Speaking opcode、UDP discovery、RTP sequence/timestamp、Opus packetizationはmedia層で実装する。

## セキュリティ採用ゲート

1. 公式repositoryの固定commitから両OSで再現buildできる。
2. 公式testと既知vectorを無変更で通す。
3. Node境界からraw MLS/DAVE keyを取得できない。
4. protocol downgradeと未知versionがfail-closedになる。
5. reconnect、participant変動、epoch transition中に平文packetを送らない。
6. key、voice token、guild/channel/user IDをログへ残さない。
7. native crash時はaudio送信を先に止め、sessionを失敗扱いにする。
8. license noticeと依存SBOMを配布物へ含められる。

## PoC判断

**条件付きGO**: 公式libdaveを唯一の暗号engine候補としてP1へ進めます。

**まだNO-GO**: 実Discord voice接続、bot token発行、常時参加、PM Codex E2Eは、上記build/integration gate合格前には進めません。公式libdaveのNode統合が成立しなければ、暗号を自作せずDiscord音声PoCを停止します。

## 2026-08-22 ローカルpreflight結果

- 検査した公式commit: `52cd56dc550f447fb354b3a06c9e2d2e2a4309c6`
- Node `v24.15.0`: project要件を満たす。
- Git/CMake: 利用可能。
- Windows MSVC `cl.exe`: 未導入のためnative buildはblocked。
- `cpp/vcpkg` submodule: shallow checkoutでは未初期化。
- 公式repositoryにNode用のprebuilt WASMは含まれず、現行WASM buildは`ENVIRONMENT=web`。
- npmで確認した `@discordjs/voice@0.19.2` は `@snazzah/davey` に依存し、公式libdave差替えpointを提供しないため直接採用しない。

固定情報は `config/dependencies.json`、再現検査は `npm run preflight:discord` に置きました。次のローカルgateはMSVC C++ toolchainとvcpkg submoduleを揃えた公式C API buildです。
