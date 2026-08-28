#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
thread_id="${1:-}"
device_name="${CODEX_BRIDGE_VIRTUAL_AUDIO_DEVICE_NAME:-BlackHole 2ch}"
debug_endpoint="${CODEX_DESKTOP_DEBUGGER_ENDPOINT:-http://127.0.0.1:9224}"
runtime_config="${CODEX_BRIDGE_MEETRON_RUNTIME_CONFIG:-$repo_root/runtime/meetron-macos-live.json}"
addon_path="${CODEX_BRIDGE_LIBDAVE_ADDON_PATH:-$repo_root/work/node-native-binding-probe/build/libdave_node_probe.node}"

[[ "$(uname -s)" == "Darwin" ]] || { print -u2 "This launcher requires macOS."; exit 1; }
print -r -- "$thread_id" | grep -Eq '^[0-9A-Fa-f-]{20,}$' || { print -u2 "Pass the exact Codex task ID as the first argument."; exit 1; }
[[ -f "$runtime_config" ]] || { print -u2 "Missing $runtime_config (copy config/meetron-macos-live.example.json there)."; exit 1; }
[[ -f "$addon_path" ]] || { print -u2 "Build the macOS libdave addon first."; exit 1; }
for command_name in node swift system_profiler curl security pgrep; do
  command -v "$command_name" >/dev/null || { print -u2 "$command_name is required."; exit 1; }
done

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 26 )) || { print -u2 "Node.js 26 or later is required."; exit 1; }
system_profiler SPAudioDataType 2>/dev/null | grep -F "$device_name:" >/dev/null || { print -u2 "Exact Core Audio device not found: $device_name"; exit 1; }
security find-generic-password -s codex-discord-voice-bridge.bot-token -a discord-bot >/dev/null 2>&1 || { print -u2 "Discord bot token is missing from Login Keychain."; exit 1; }
curl --fail --silent --max-time 2 "$debug_endpoint/json/list" >/dev/null || { print -u2 "Codex Desktop is not exposing the loopback debugger endpoint. Launch it with --remote-debugging-address=127.0.0.1 --remote-debugging-port=9224."; exit 1; }

if [[ -n "${CODEX_BRIDGE_CODEX_DESKTOP_PID:-}" ]]; then
  codex_pid="$CODEX_BRIDGE_CODEX_DESKTOP_PID"
else
  codex_pid_lines="$(pgrep -f '/(Codex|ChatGPT)\.app/Contents/MacOS/(Codex|ChatGPT)( |$)' || true)"
  codex_pids=(${(f)codex_pid_lines})
  (( ${#codex_pids[@]} == 1 )) || { print -u2 "Exactly one Codex Desktop root process is required; set CODEX_BRIDGE_CODEX_DESKTOP_PID explicitly if discovery is unavailable."; exit 1; }
  codex_pid="$codex_pids[1]"
fi
kill -0 "$codex_pid" 2>/dev/null || { print -u2 "Codex Desktop process is not running."; exit 1; }

swift build -c release --package-path "$repo_root/native/macos"
export CODEX_THREAD_ID="$thread_id"
export CODEX_DESKTOP_DEBUGGER_ENDPOINT="$debug_endpoint"
export CODEX_BRIDGE_CODEX_DESKTOP_PID="$codex_pid"
export CODEX_BRIDGE_VIRTUAL_AUDIO_DEVICE_NAME="$device_name"
export CODEX_BRIDGE_VIRTUAL_AUDIO_INPUT_LABEL="${CODEX_BRIDGE_VIRTUAL_AUDIO_INPUT_LABEL:-$device_name}"
export CODEX_BRIDGE_CONFIG="${CODEX_BRIDGE_CONFIG:-$repo_root/config/bridge.example.json}"
export CODEX_BRIDGE_MEETRON_RUNTIME_CONFIG="$runtime_config"
export CODEX_BRIDGE_LIBDAVE_ADDON_PATH="$addon_path"
cd "$repo_root"
exec node scripts/run-discord-production-control.mjs
