#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
package_root="$repo_root/native/macos"
dist_root="$repo_root/dist"
app_root="$dist_root/Discodex Relay.app"
binary_name="Discodex Relay"

[[ "$(uname -s)" == "Darwin" ]] || { print -u2 "This builder requires macOS."; exit 1; }
command -v swift >/dev/null || { print -u2 "Swift is required."; exit 1; }
command -v codesign >/dev/null || { print -u2 "codesign is required."; exit 1; }
[[ "$app_root" == "$dist_root/Discodex Relay.app" && "$dist_root" == "$repo_root/dist" ]] || { print -u2 "Relay output escaped the repository dist directory."; exit 1; }

swift build -c release --package-path "$package_root" --product discodex-relay-macos
built_binary="$(swift build -c release --package-path "$package_root" --product discodex-relay-macos --show-bin-path)/discodex-relay-macos"
[[ -x "$built_binary" ]] || { print -u2 "The macOS Relay binary was not produced."; exit 1; }

rm -rf "$app_root"
mkdir -p "$app_root/Contents/MacOS"
cp "$built_binary" "$app_root/Contents/MacOS/$binary_name"
cp "$package_root/DiscodexRelayInfo.plist" "$app_root/Contents/Info.plist"
chmod 755 "$app_root/Contents/MacOS/$binary_name"
codesign --force --sign - --timestamp=none "$app_root" >/dev/null
codesign --verify --deep --strict "$app_root"

print -r -- '{"built":true,"artifact":"Discodex Relay.app","host":"macOS AppKit","secretOutput":false,"identifierOutput":false}'
