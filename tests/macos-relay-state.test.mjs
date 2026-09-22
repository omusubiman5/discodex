import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Self-verification: execute production AppKit state transitions on macOS,
// substituting only manager responses and modal error presentation.
// This does not validate Keychain, live audio, TCC prompts, or VoiceOver speech.
test("macOS AppKit retries setup and clears stale actions after read failure", {
  skip: process.platform !== "darwin", timeout: 120_000,
}, () => {
  let source = readFileSync(resolve("native/macos/Sources/DiscodexRelayMac/main.swift"), "utf8");
  const start = source.indexOf("  private func run(_ arguments:");
  const end = source.indexOf("  private func loadGainThenRefresh()", start);
  assert.ok(start > 0 && end > start);
  source = source.slice(0, start) + `
  private func run(_ arguments: [String], completion: @escaping (Result<Data, Error>) -> Void) {
    observedCommands.append(arguments)
    precondition(!responses.isEmpty, "Unexpected manager invocation")
    completion(responses.removeFirst())
  }
` + source.slice(end);
  const alert = /  private func showError\(_ message: String\) \{[^\n]+\}/;
  assert.match(source, alert);
  source = source.replace(alert, "  private func showError(_ message: String) { observedErrors += 1 }");
  const entry = source.indexOf("let application = NSApplication.shared");
  assert.ok(entry > 0);
  source = source.slice(0, entry) + `
var responses: [Result<Data, Error>] = []
var observedCommands: [[String]] = []
var observedErrors = 0
func fixture(ready: Bool, control: Int = 0) -> Result<Data, Error> {
  let value: [String: Any] = ["controlCount": control, "runnerCount": 0,
    "lockPresent": false, "routePrepared": true, "healthy": true,
    "setup": ["ready": ready, "missing": ready ? [] : ["runtime-config"],
      "audioFormatVerificationRequired": true]]
  return .success(try! JSONSerialization.data(withJSONObject: value))
}
extension RelayAppDelegate {
  static func verifyTransitions() {
    let app = RelayAppDelegate()
    app.buildWindow()
    for _ in 0..<3 {
      responses = [fixture(ready: false)]
      app.primaryPressed()
      precondition(!app.busy && app.primary.isEnabled && app.refresh.isEnabled)
      precondition(app.primary.title == "Check Setup" && app.healthTimer == nil)
    }
    precondition(observedCommands.allSatisfy { $0 == ["status"] })
    responses = [fixture(ready: true)]
    app.refreshPressed()
    precondition(app.primary.isEnabled && app.primary.title == "Start Relay")
    responses = [.failure(NSError(domain: "Synthetic", code: 1))]
    app.refreshPressed()
    precondition(!app.busy && app.refresh.isEnabled)
    precondition(app.snapshot == nil && app.latestSetup == nil, "Stale snapshot survived read failure")
    precondition(!app.primary.isEnabled && !app.stop.isEnabled && !app.shareStart.isEnabled)
    precondition(observedErrors == 1)
    precondition(app.status.accessibilityLabel() == "Relay state: CONTROL ERROR  /  DISCONNECTED")
    responses = [fixture(ready: false)]
    app.refreshPressed()
    precondition(app.primary.isEnabled && app.primary.title == "Check Setup")
    responses = [fixture(ready: true)]
    app.refreshPressed()
    responses = [.success(Data()), fixture(ready: true, control: 1)]
    app.primaryPressed()
    precondition(app.ownsControl && app.healthTimer != nil && app.stop.isEnabled && !app.busy)
    precondition(observedCommands.contains(["start", "--restart-existing"]))
    responses = [.success(Data()), fixture(ready: true)]
    app.stopPressed()
    precondition(!app.ownsControl && app.healthTimer == nil && app.primary.isEnabled)
    precondition(responses.isEmpty)
    print("PASS macOS AppKit setup transitions")
  }
}
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
RelayAppDelegate.verifyTransitions()
`;
  const root = resolve("outputs");
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, "macos-relay-state-"));
  const swift = join(folder, "main.swift");
  const executable = join(folder, "relay-state-test");
  writeFileSync(swift, source);
  const compiled = spawnSync("swiftc", [swift, "-o", executable], { encoding: "utf8", timeout: 90_000 });
  assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);
  const executed = spawnSync(executable, [], { encoding: "utf8", timeout: 15_000 });
  assert.equal(executed.status, 0, executed.error?.message || executed.stderr);
  assert.match(executed.stdout, /PASS macOS AppKit setup transitions/);
});
