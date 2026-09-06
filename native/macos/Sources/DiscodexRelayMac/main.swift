import AppKit
import Foundation

struct RelaySnapshot: Decodable {
  let controlCount: Int
  let runnerCount: Int
  let lockPresent: Bool
  let routePrepared: Bool
  let healthy: Bool
  let setup: RelaySetup?
}

struct RelaySetup: Decodable {
  let ready: Bool
  let missing: [String]
  let audioFormatVerificationRequired: Bool
}

struct GainSnapshot: Decodable { let gainPercent: Int }

final class RelayAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private var window: NSWindow!
  private let status = NSTextField(labelWithString: "Checking current ownership…")
  private let relayBadge = NSTextField(labelWithString: "RELAY CHECKING")
  private let routeBadge = NSTextField(labelWithString: "CODEX ROUTE CHECKING")
  private let voiceBadge = NSTextField(labelWithString: "VOICE CHECKING")
  private let setupHeading = NSTextField(labelWithString: "Complete setup before starting Relay")
  private let setupHint = NSTextField(wrappingLabelWithString: "Checking Relay setup…")
  private let setupNextAction = NSTextField(labelWithString: "")
  private let primary = NSButton(title: "Start Relay", target: nil, action: nil)
  private let stop = NSButton(title: "Stop Relay", target: nil, action: nil)
  private let refresh = NSButton(title: "Refresh", target: nil, action: nil)
  private let gain = NSSlider(value: 0.5, minValue: 0.25, maxValue: 1.0, target: nil, action: nil)
  private let gainLabel = NSTextField(labelWithString: "GPT Live → Discord output volume: 50%")
  private let applyGain = NSButton(title: "Apply", target: nil, action: nil)
  private let shareStart = NSButton(title: "Start Screen Share", target: nil, action: nil)
  private let shareStop = NSButton(title: "Stop Screen Share", target: nil, action: nil)
  private var snapshot: RelaySnapshot?
  private var latestSetup: RelaySetup?
  private var busy = false
  private var closingAfterStop = false
  private var ownsControl = false
  private var controlRecoveryUsed = false
  private var controlHealthySince: Date?
  private var healthTimer: Timer?
  private var sleepActivity: NSObjectProtocol?

  private lazy var repositoryRoot: URL = {
    if let configured = ProcessInfo.processInfo.environment["DISCODEX_REPO_ROOT"], !configured.isEmpty {
      return URL(fileURLWithPath: configured).standardizedFileURL
    }
    return Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().standardizedFileURL
  }()

  private lazy var nodeExecutable: String? = {
    let manager = FileManager.default
    for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] where manager.isExecutableFile(atPath: path) { return path }
    let process = Process(); let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh"); process.arguments = ["-lic", "command -v node"]
    process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
    do { try process.run(); process.waitUntilExit() } catch { return nil }
    let path = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return path.flatMap { !$0.isEmpty && manager.isExecutableFile(atPath: $0) ? $0 : nil }
  }()

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard FileManager.default.fileExists(atPath: repositoryRoot.appendingPathComponent("scripts/manage-discodex-relay-macos.mjs").path) else {
      showError("Discodex Relay.app must remain in the repository dist directory.")
      NSApp.terminate(nil)
      return
    }
    buildWindow()
    sleepActivity = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled], reason: "Keep Discodex Relay reachable for approved Discord commands")
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    loadGainThenRefresh()
    healthTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      guard let self, !self.busy, !self.closingAfterStop else { return }
      self.refreshState(healthCheck: true)
    }
  }

  private func buildWindow() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 700), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "Discodex Relay"
    window.center()
    window.delegate = self
    let root = NSView(frame: window.contentView!.bounds)
    root.autoresizingMask = [.width, .height]
    root.wantsLayer = true
    root.layer?.backgroundColor = NSColor.white.cgColor
    window.contentView = root

    let header = NSView(frame: NSRect(x: 0, y: 595, width: 720, height: 105))
    header.wantsLayer = true; header.layer?.backgroundColor = NSColor(calibratedRed: 0.13, green: 0.09, blue: 0.08, alpha: 1).cgColor
    let title = label("Discodex Voice Bridge", 27, .white, NSRect(x: 24, y: 48, width: 650, height: 40))
    let subtitle = label("GPT Live and Discord voice relay", 13, .white, NSRect(x: 27, y: 20, width: 620, height: 22))
    header.addSubview(title); header.addSubview(subtitle); root.addSubview(header)

    status.frame = NSRect(x: 25, y: 552, width: 670, height: 24); status.font = .systemFont(ofSize: 18); status.textColor = .labelColor
    status.alignment = .right; root.addSubview(status)
    configureBadge(relayBadge, frame: NSRect(x: 25, y: 508, width: 190, height: 30))
    configureBadge(routeBadge, frame: NSRect(x: 225, y: 508, width: 270, height: 30))
    configureBadge(voiceBadge, frame: NSRect(x: 505, y: 508, width: 190, height: 30))
    [relayBadge, routeBadge, voiceBadge].forEach { root.addSubview($0) }

    primary.frame = NSRect(x: 25, y: 452, width: 150, height: 38); primary.target = self; primary.action = #selector(primaryPressed)
    stop.frame = NSRect(x: 185, y: 452, width: 150, height: 38); stop.target = self; stop.action = #selector(stopPressed)
    refresh.frame = NSRect(x: 345, y: 452, width: 125, height: 38); refresh.target = self; refresh.action = #selector(refreshPressed)
    [primary, stop, refresh].forEach { root.addSubview($0) }
    setupHeading.frame = NSRect(x: 25, y: 420, width: 670, height: 24); setupHeading.font = .boldSystemFont(ofSize: 14); setupHeading.textColor = .labelColor
    setupHint.frame = NSRect(x: 25, y: 338, width: 670, height: 72); setupHint.font = .systemFont(ofSize: 12); setupHint.maximumNumberOfLines = 5
    setupNextAction.frame = NSRect(x: 25, y: 314, width: 670, height: 20); setupNextAction.font = .boldSystemFont(ofSize: 12); setupNextAction.textColor = .labelColor
    root.addSubview(setupHeading); root.addSubview(setupHint); root.addSubview(setupNextAction)

    let gainHeading = label("GPT Live → Discord output volume", 18, .labelColor, NSRect(x: 25, y: 260, width: 500, height: 30)); root.addSubview(gainHeading)
    gainLabel.frame = NSRect(x: 25, y: 226, width: 480, height: 24); root.addSubview(gainLabel)
    gain.frame = NSRect(x: 25, y: 188, width: 480, height: 30); gain.target = self; gain.action = #selector(gainChanged); root.addSubview(gain)
    applyGain.frame = NSRect(x: 525, y: 188, width: 120, height: 38); applyGain.target = self; applyGain.action = #selector(applyGainPressed); root.addSubview(applyGain)

    let shareHeading = label("Discord Screen Share", 18, .labelColor, NSRect(x: 25, y: 128, width: 500, height: 30)); root.addSubview(shareHeading)
    shareStart.frame = NSRect(x: 25, y: 78, width: 190, height: 38); shareStart.target = self; shareStart.action = #selector(shareStartPressed)
    shareStop.frame = NSRect(x: 225, y: 78, width: 190, height: 38); shareStop.target = self; shareStop.action = #selector(shareStopPressed)
    root.addSubview(shareStart); root.addSubview(shareStop)
    root.addSubview(label("Single control · Single runner · System sleep blocked while Relay is open", 12, .secondaryLabelColor, NSRect(x: 25, y: 20, width: 650, height: 22)))
    setBusy(true)
  }

  private func label(_ text: String, _ size: CGFloat, _ color: NSColor, _ frame: NSRect) -> NSTextField {
    let value = NSTextField(labelWithString: text); value.frame = frame; value.font = .systemFont(ofSize: size); value.textColor = color; return value
  }

  private func configureBadge(_ badge: NSTextField, frame: NSRect) {
    badge.frame = frame; badge.alignment = .center; badge.textColor = .white; badge.wantsLayer = true; badge.layer?.cornerRadius = 5; badge.layer?.backgroundColor = NSColor.systemGray.cgColor
  }

  private func setBusy(_ value: Bool) {
    busy = value
    let current = snapshot
    refresh.isEnabled = !value
    applyGain.isEnabled = !value
    let setupReady = latestSetup?.ready == true
    primary.isEnabled = !value && current != nil && (!setupReady || (current!.controlCount <= 1 && current!.runnerCount == 0 && !current!.lockPresent && (!current!.routePrepared || current!.controlCount == 0)))
    stop.isEnabled = !value && current?.controlCount == 1 && current?.runnerCount == 0 && current?.lockPresent == false
    shareStart.isEnabled = !value && current?.runnerCount == 1 && current?.lockPresent == true
    shareStop.isEnabled = !value
  }

  private func run(_ arguments: [String], completion: @escaping (Result<Data, Error>) -> Void) {
    guard let nodeExecutable else { completion(.failure(NSError(domain: "DiscodexRelay", code: 127, userInfo: [NSLocalizedDescriptionKey: "Node.js 26 or later could not be found."]))); return }
    let process = Process(); let stdout = Pipe(); let stderr = Pipe()
    process.executableURL = URL(fileURLWithPath: nodeExecutable)
    process.arguments = [repositoryRoot.appendingPathComponent("scripts/manage-discodex-relay-macos.mjs").path] + arguments
    process.currentDirectoryURL = repositoryRoot; process.standardOutput = stdout; process.standardError = stderr
    process.terminationHandler = { process in
      let out = stdout.fileHandleForReading.readDataToEndOfFile(); let err = stderr.fileHandleForReading.readDataToEndOfFile()
      DispatchQueue.main.async {
        if process.terminationStatus == 0 { completion(.success(out)) }
        else { completion(.failure(NSError(domain: "DiscodexRelay", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: String(data: err, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "Relay operation failed."]))) }
      }
    }
    do { try process.run() } catch { completion(.failure(error)) }
  }

  private func loadGainThenRefresh() {
    run(["gain", "get"]) { result in
      if case .success(let data) = result, let saved = try? JSONDecoder().decode(GainSnapshot.self, from: data) {
        self.gain.doubleValue = Double(max(25, min(100, saved.gainPercent))) / 100.0
        self.gainChanged()
      }
      self.refreshState(autoStart: true)
    }
  }

  private func refreshState(autoStart: Bool = false, healthCheck: Bool = false) {
    setBusy(true)
    run(healthCheck ? ["status", "--skip-setup"] : ["status"]) { result in
      do {
        let data = try result.get(); let state = try JSONDecoder().decode(RelaySnapshot.self, from: data)
        if let setup = state.setup { self.latestSetup = setup }
        guard let setup = self.latestSetup else { throw NSError(domain: "DiscodexRelay", code: 1, userInfo: [NSLocalizedDescriptionKey: "Relay setup has not been checked yet."]) }
        self.snapshot = state
        let relay = !setup.ready ? "SETUP NEEDED" : (state.controlCount == 1 ? "READY" : (state.controlCount == 0 ? "STOPPED" : "INVALID"))
        let voice = state.runnerCount == 1 && state.lockPresent ? "CONNECTED" : (state.runnerCount == 0 && !state.lockPresent ? "DISCONNECTED" : "DEGRADED")
        self.status.stringValue = "\(relay)  /  \(voice)"
        self.relayBadge.stringValue = "RELAY \(relay)"; self.relayBadge.layer?.backgroundColor = (relay == "READY" ? NSColor.systemBlue : (relay == "SETUP NEEDED" ? NSColor.systemOrange : NSColor.systemGray)).cgColor
        self.routeBadge.stringValue = state.routePrepared ? "CODEX ROUTE READY" : "CODEX ROUTE SETUP NEEDED"; self.routeBadge.layer?.backgroundColor = (state.routePrepared ? NSColor.systemBlue : NSColor.systemOrange).cgColor
        self.voiceBadge.stringValue = "VOICE \(voice)"; self.voiceBadge.layer?.backgroundColor = (voice == "CONNECTED" ? NSColor.systemBlue : NSColor.systemGray).cgColor
        self.primary.title = setup.ready ? (state.routePrepared ? "Start Relay" : "Prepare Codex") : "Check Setup"
        self.updateSetupHint(setup)
        if state.controlCount == 1 {
          if self.controlHealthySince == nil { self.controlHealthySince = Date() }
          if Date().timeIntervalSince(self.controlHealthySince!) >= 60 { self.controlRecoveryUsed = false }
          if autoStart { self.ownsControl = true }
        } else {
          self.controlHealthySince = nil
        }
        self.setBusy(false)
        if autoStart && setup.ready && state.controlCount == 0 && state.runnerCount == 0 && !state.lockPresent { self.startPrimary() }
        else if healthCheck && self.ownsControl && !self.controlRecoveryUsed && state.controlCount == 0 && state.runnerCount == 0 && !state.lockPresent {
          self.controlRecoveryUsed = true
          self.startPrimary()
        }
      } catch {
        self.setBusy(false); self.status.stringValue = "CONTROL ERROR  /  DISCONNECTED"
        if !healthCheck { self.showError(error.localizedDescription) }
      }
    }
  }

  private func updateSetupHint(_ setup: RelaySetup) {
    guard !setup.ready else {
      setupHeading.stringValue = "Relay setup is verified"
      setupHint.stringValue = "Relay setup verified. Confirm BlackHole 2ch is set to 48 kHz / 2 ch in Audio MIDI Setup before connecting."
      setupHint.textColor = .secondaryLabelColor
      setupNextAction.stringValue = "Next: prepare Codex or start Relay."
      return
    }
    var steps: [String] = []
    if setup.missing.contains("runtime-config") { steps.append("Copy config/meetron-macos-live.example.json to runtime/meetron-macos-live.json, then set only the Guild ID and Voice Channel ID.") }
    if setup.missing.contains("discord-token") { steps.append("Store the Discord Bot Token in Login Keychain; never put it in JSON, logs, or this screen.") }
    if setup.missing.contains("codex-task") { steps.append("Put the target Codex task UUID on one line in runtime/discodex-relay.thread-id.") }
    if setup.missing.contains("blackhole-device") { steps.append("Install BlackHole 2ch, then configure it as 48 kHz / 2 ch in Audio MIDI Setup.") }
    if setup.audioFormatVerificationRequired && !setup.missing.contains("blackhole-device") { steps.append("Confirm BlackHole 2ch is set to 48 kHz / 2 ch in Audio MIDI Setup.") }
    setupHint.stringValue = steps.joined(separator: "\n")
    setupHint.textColor = .systemOrange
    setupHeading.stringValue = "Complete these setup items before starting Relay"
    setupNextAction.stringValue = "Next: complete the items above, then click Check Setup."
  }

  private func startPrimary() {
    guard let state = snapshot else { return }
    guard latestSetup?.ready == true else { return }
    if !state.routePrepared {
      let alert = NSAlert(); alert.messageText = "Prepare Codex Desktop?"; alert.informativeText = "Relay will perform one bounded restart of Codex Desktop to enable its loopback-only audio route. Any active Voice Talk call will close."; alert.addButton(withTitle: "Continue"); alert.addButton(withTitle: "Cancel")
      guard alert.runModal() == .alertFirstButtonReturn else { return }
    }
    setBusy(true); status.stringValue = state.routePrepared ? "STARTING" : "PREPARING CODEX"
    run([state.routePrepared ? "start" : "prepare", "--restart-existing"]) { result in
      if case .failure(let error) = result { self.showError(error.localizedDescription) }
      else { self.ownsControl = true; self.controlHealthySince = Date() }
      self.refreshState()
    }
  }

  private func showError(_ message: String) { let alert = NSAlert(); alert.messageText = "Discodex Relay"; alert.informativeText = message; alert.alertStyle = .critical; alert.runModal() }
  @objc private func primaryPressed() {
    guard latestSetup?.ready == true else { refreshState(); return }
    startPrimary()
  }
  @objc private func stopPressed() { setBusy(true); run(["stop"]) { result in if case .failure(let error) = result { self.showError(error.localizedDescription) } else { self.ownsControl = false }; self.refreshState() } }
  @objc private func refreshPressed() { refreshState() }
  @objc private func gainChanged() { gainLabel.stringValue = "GPT Live → Discord output volume: \(Int((gain.doubleValue * 100).rounded()))%" }
  @objc private func applyGainPressed() { setBusy(true); run(["gain", String(format: "%.2f", gain.doubleValue)]) { result in if case .failure(let error) = result { self.showError(error.localizedDescription) }; self.refreshState() } }
  @objc private func shareStartPressed() { setBusy(true); run(["screen-share", "start"]) { result in if case .failure(let error) = result { self.showError(error.localizedDescription) }; self.refreshState() } }
  @objc private func shareStopPressed() { setBusy(true); run(["screen-share", "stop"]) { result in if case .failure(let error) = result { self.showError(error.localizedDescription) }; self.refreshState() } }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    if snapshot?.lockPresent == true { showError("Use /disconnect in Discord before closing Discodex Relay."); return false }
    if snapshot?.controlCount == 1 && !closingAfterStop {
      closingAfterStop = true; setBusy(true)
      run(["stop"]) { result in
        if case .failure(let error) = result { self.closingAfterStop = false; self.setBusy(false); self.showError(error.localizedDescription); return }
        self.snapshot = nil; NSApp.terminate(nil)
      }
      return false
    }
    return true
  }

  func applicationWillTerminate(_ notification: Notification) {
    healthTimer?.invalidate()
    if let sleepActivity { ProcessInfo.processInfo.endActivity(sleepActivity); self.sleepActivity = nil }
  }
}

let application = NSApplication.shared
let delegate = RelayAppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
