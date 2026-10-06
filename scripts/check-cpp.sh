#!/usr/bin/env bash
# Compile-check the C++ against the real Nitro and JSI headers (no Android or Xcode needed).
# Needs: g++ (C++20), and `npm ci` done (for node_modules).
set -euo pipefail
cd "$(dirname "$0")/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Nitro headers are flat under <NitroModules/...> when built with Gradle prefab. Rebuild that layout.
mkdir -p "$TMP/inc/NitroModules"
find node_modules/react-native-nitro-modules/cpp \( -name '*.hpp' -o -name '*.h' \) -print0 |
  while IFS= read -r -d '' f; do ln -sf "$PWD/$f" "$TMP/inc/NitroModules/$(basename "$f")"; done

RN=node_modules/react-native/ReactCommon
INC=(-I"$TMP/inc" -I"$RN/jsi" -I"$RN/callinvoker" -Icpp -Initrogen/generated/shared/c++)

echo "== syntax check: C++ HybridObject and generated spec"
g++ -std=c++20 -fsyntax-only -Wall -Wextra -Wno-unknown-pragmas "${INC[@]}" \
  cpp/HybridBplzCodec.cpp nitrogen/generated/shared/c++/HybridBplzCodecSpec.cpp

echo "== build and warn-check the portable core"
g++ -std=c++17 -O2 -Wall -Wextra -Werror -c cpp/bplz_core.cpp -o "$TMP/core.o"

echo "C++ OK"
