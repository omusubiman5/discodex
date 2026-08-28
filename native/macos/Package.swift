// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "DiscodexCoreAudioHost",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "discodex-coreaudio-host", targets: ["DiscodexCoreAudioHost"]),
    .executable(name: "discodex-relay-macos", targets: ["DiscodexRelayMac"]),
  ],
  targets: [
    .executableTarget(name: "DiscodexCoreAudioHost"),
    .executableTarget(name: "DiscodexRelayMac"),
  ]
)
