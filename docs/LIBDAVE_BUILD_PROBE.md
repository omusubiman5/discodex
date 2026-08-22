# Official libdave Windows build probe

Date: 2026-08-22 (Asia/Tokyo)

## Reproducibility identity

- Repository: `https://github.com/discord/libdave.git`
- libdave commit: `52cd56dc550f447fb354b3a06c9e2d2e2a4309c6`
- vcpkg submodule: `16c71a39e5a0fc0bdb3fad03beef8f38ee00ee3b`
- Official `bootstrap-vcpkg.bat -disableMetrics`: success
- Source modifications: none
- System installs: none

Generated sources, dependencies, and primary logs remain under ignored `work/dependency-probes/`. This document is the tracked result summary.

## Official Windows/MSVC path

The `x64-windows-static` CMake/vcpkg configure stopped before libdave source compilation. The exact primary error was:

```text
error: in triplet x64-windows: Unable to find a valid Visual Studio instance
Could not locate a complete Visual Studio instance
```

Discovery confirmed that `cl.exe`, `msbuild.exe`, a complete Visual Studio instance, and the Windows SDK include root are absent. This probe did not install them.

## MinGW auxiliary path

The non-official `x64-mingw-static` portability probe built OpenSSL 3.0.7, gtest, nlohmann-json, and Catch2. It then stopped while compiling the pinned MLS++ dependency with GCC 16.1:

```text
error: ... may be used uninitialized [-Werror=maybe-uninitialized]
cc1plus.exe: all warnings being treated as errors
```

This is an MLS++/GCC warning promoted to an error, before libdave C API compilation. The community MinGW triplet is not evidence that Discord's official MSVC path succeeds and is not selected as the production toolchain.

## Artifact and gate result

- `libdave.dll`: not produced
- `liblibdave.a`: not produced
- `capi_test.exe`: not produced
- official C API test: not run because no libdave target was generated
- Node binding: not attempted because the native artifact gate did not pass

Decision: **blocked**. The next local prerequisite is a complete Visual Studio C++/MSVC toolchain with Windows SDK. Discord application/server/token setup remains out of scope until the native build, C API test, and Node integration gates pass.
