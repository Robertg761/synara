#!/bin/bash
# Compiles synara-computer-helper with the user's own Xcode toolchain.
#
# Everything is resolved through `xcrun`. No private symbol is linked at build
# time — CGEventSetWindowLocation and the other Quartz SPI are resolved with
# dlsym at runtime (see Input.swift) — so the output binary is relocatable, does
# not embed absolute toolchain paths, and degrades to a diagnosable error rather
# than a dyld crash when a symbol moves between macOS releases.
#
# Usage:
#   build.sh [output-directory]
#   SYNARA_COMPUTER_HELPER_OUT=/path build.sh
#
# Defaults to ./build next to this script.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-${SYNARA_COMPUTER_HELPER_OUT:-$SOURCE_DIR/build}}"
BINARY_NAME="synara-computer-helper"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "error: xcrun not found; install the Xcode command line tools" >&2
  exit 1
fi

# The command line tools are enough: unlike the device helper this links no
# private framework, only public Quartz/AppKit/ScreenCaptureKit, and resolves
# the one private symbol at runtime. A full Xcode still works and is what the
# server selects when present.
DEVELOPER_DIR_PATH="${DEVELOPER_DIR:-}"
if [ -z "$DEVELOPER_DIR_PATH" ]; then
  DEVELOPER_DIR_PATH="$(xcode-select -p 2>/dev/null || true)"
fi
if [ -z "$DEVELOPER_DIR_PATH" ]; then
  echo "error: no active developer directory; run 'sudo xcode-select -s /Applications/Xcode.app'" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
OUT_BINARY="$OUT_DIR/$BINARY_NAME"

# Compiled to a temporary path and moved into place so a concurrent build (or a
# running helper holding the old binary open) never sees a half-written file.
TMP_BINARY="$(mktemp "${OUT_DIR}/.${BINARY_NAME}.XXXXXX")"
trap 'rm -f "$TMP_BINARY"' EXIT

# ScreenCaptureKit needs macOS 12.3; the input path's window-targeted posting is
# unchanged back to there. Codex ships a 14.4 floor for its own reasons; we build
# lower and let the capability probe report what the running OS actually allows.
TARGET_TRIPLE="$(uname -m)-apple-macosx12.3"

xcrun swiftc \
  -O \
  -whole-module-optimization \
  -swift-version 5 \
  -target "$TARGET_TRIPLE" \
  -framework Foundation \
  -framework AppKit \
  -framework CoreGraphics \
  -framework ScreenCaptureKit \
  -framework ApplicationServices \
  -framework CoreMedia \
  -framework CoreVideo \
  -framework ImageIO \
  -framework UniformTypeIdentifiers \
  "$SOURCE_DIR/Sources/JSONRPC.swift" \
  "$SOURCE_DIR/Sources/Capability.swift" \
  "$SOURCE_DIR/Sources/Geometry.swift" \
  "$SOURCE_DIR/Sources/Windows.swift" \
  "$SOURCE_DIR/Sources/Capture.swift" \
  "$SOURCE_DIR/Sources/Accessibility.swift" \
  "$SOURCE_DIR/Sources/Input.swift" \
  "$SOURCE_DIR/Sources/Cursor.swift" \
  "$SOURCE_DIR/Sources/main.swift" \
  -o "$TMP_BINARY"

chmod +x "$TMP_BINARY"
mv -f "$TMP_BINARY" "$OUT_BINARY"
trap - EXIT

echo "$OUT_BINARY"
