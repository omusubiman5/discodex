#!/bin/zsh
set -euo pipefail

repo_root="${0:A:h:h}"
dave_root="$repo_root/work/dependency-probes/libdave"
expected_commit="52cd56dc550f447fb354b3a06c9e2d2e2a4309c6"
case "$(uname -m)" in
  arm64) vcpkg_triplet="arm64-osx" ;;
  x86_64) vcpkg_triplet="x64-osx" ;;
  *) print -u2 "Unsupported macOS architecture."; exit 1 ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "This build must run on macOS."
  exit 1
fi
for command_name in git cmake clang node; do
  command -v "$command_name" >/dev/null || { print -u2 "$command_name is required."; exit 1; }
done
if ! command -v pkg-config >/dev/null; then
  print -u2 "pkg-config is required before building libdave. Install it with: brew install pkg-config"
  exit 1
fi
if ! command -v make >/dev/null || ! make --version 2>/dev/null | grep -q "GNU Make"; then
  print -u2 "GNU make is required before building libdave. Install it with: brew install make"
  print -u2 "Then run this script with GNU make first in PATH, for example: PATH=\"\$(brew --prefix make)/libexec/gnubin:\$PATH\" zsh scripts/build-libdave-addon-macos.sh"
  exit 1
fi

if [[ ! -d "$dave_root/.git" ]]; then
  mkdir -p "${dave_root:h}"
  git clone --no-checkout https://github.com/discord/libdave.git "$dave_root"
fi
actual_origin="$(git -C "$dave_root" remote get-url origin)"
[[ "$actual_origin" == "https://github.com/discord/libdave.git" ]] || { print -u2 "Unexpected libdave origin."; exit 1; }
git -C "$dave_root" fetch --depth 1 origin "$expected_commit"
git -C "$dave_root" checkout --detach "$expected_commit"
git -C "$dave_root" submodule update --init --recursive
[[ "$(git -C "$dave_root" rev-parse HEAD)" == "$expected_commit" ]] || { print -u2 "Pinned libdave checkout verification failed."; exit 1; }

"$dave_root/cpp/vcpkg/bootstrap-vcpkg.sh" -disableMetrics
cmake -S "$dave_root/cpp" -B "$dave_root/cpp/build-macos" \
  -DCMAKE_BUILD_TYPE=Release \
  -DVCPKG_MANIFEST_DIR="$dave_root/cpp/vcpkg-alts/openssl_3" \
  -DCMAKE_TOOLCHAIN_FILE="$dave_root/cpp/vcpkg/scripts/buildsystems/vcpkg.cmake" \
  -DVCPKG_TARGET_TRIPLET="$vcpkg_triplet" \
  -DBUILD_SHARED_LIBS=OFF -DPERSISTENT_KEYS=OFF -DTESTING=ON
cmake --build "$dave_root/cpp/build-macos" --target libdave capi_test --config Release --parallel
"$dave_root/cpp/build-macos/test/capi/capi_test"

binding_build="$repo_root/work/node-native-binding-probe/build"
cmake -S "$repo_root/work/node-native-binding-probe" -B "$binding_build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$dave_root/cpp/vcpkg/scripts/buildsystems/vcpkg.cmake" \
  -DVCPKG_MANIFEST_DIR="$dave_root/cpp/vcpkg-alts/openssl_3" \
  -DVCPKG_TARGET_TRIPLET="$vcpkg_triplet" \
  -DLIBDAVE_STATIC_LIBRARY="$dave_root/cpp/build-macos/libdave.a"
cmake --build "$binding_build" --config Release --parallel
node "$repo_root/work/node-native-binding-probe/load-probe.cjs"
print "CODEX_BRIDGE_LIBDAVE_ADDON_PATH=$binding_build/libdave_node_probe.node"
