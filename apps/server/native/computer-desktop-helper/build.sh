#!/usr/bin/env bash
# Compiles synara-computer-desktop-helper.
#
# The protocol XMLs are vendored under protocol/ rather than taken from
# wayland-protocols: the wlr-* ones do not ship in wayland-protocols at all, and
# vendoring them means a build needs only libwayland itself, not a matching
# protocol package on every distribution.
#
# Usage:
#   build.sh [output-directory]
#   SYNARA_COMPUTER_HELPER_OUT=/path build.sh
#   SANITIZE=1 build.sh   # address + UB sanitizers, for local verification only
#
# The sanitized binary is 2-3x slower and is not what the server should run: it
# exists so the capture and input paths, which are the ones handling attacker-
# shaped geometry and compositor-shaped buffers, can be exercised under a
# checker before a release build is trusted.
#
# Defaults to the path probe.ts looks in, so a plain `./build.sh` is enough to
# make the helper discoverable:
#   ${XDG_DATA_HOME:-$HOME/.local/share}/synara/computer

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_OUT="${XDG_DATA_HOME:-$HOME/.local/share}/synara/computer"
OUT_DIR="${1:-${SYNARA_COMPUTER_HELPER_OUT:-$DEFAULT_OUT}}"
BINARY_NAME="synara-computer-desktop-helper"

die() {
  echo "error: $*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found; $2"
}

need_command cc "install gcc or clang (dnf install gcc / apt install build-essential)"
need_command pkg-config "install pkgconf (dnf install pkgconf-pkg-config / apt install pkg-config)"
need_command wayland-scanner "install wayland-devel (dnf install wayland-devel / apt install libwayland-dev)"

for module in wayland-client xkbcommon; do
  pkg-config --exists "$module" ||
    die "the $module development package is missing (dnf install wayland-devel libxkbcommon-devel / apt install libwayland-dev libxkbcommon-dev)"
done

CFLAGS_PKG="$(pkg-config --cflags wayland-client xkbcommon)"
LIBS_PKG="$(pkg-config --libs wayland-client xkbcommon)"

SANITIZE_FLAGS=()
if [ "${SANITIZE:-0}" != "0" ]; then
  SANITIZE_FLAGS=(-fsanitize=address,undefined -fno-omit-frame-pointer -g)
  # The compiler accepts the flags whether or not the runtimes are installed and
  # only fails at link time, with a message naming a library path rather than a
  # package, so the check is done here where the hint can be useful.
  echo 'int main(void) { return 0; }' |
    cc -xc - "${SANITIZE_FLAGS[@]}" -o /dev/null 2>/dev/null ||
    die "the sanitizer runtimes are missing (dnf install libasan libubsan / apt install libasan8 libubsan1)"
fi

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/synara-computer-helper.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

PROTOCOLS=(
  wlr-virtual-pointer-unstable-v1
  wlr-screencopy-unstable-v1
  wlr-foreign-toplevel-management-unstable-v1
  virtual-keyboard-unstable-v1
  xdg-output-unstable-v1
)

GENERATED_SOURCES=()
for protocol in "${PROTOCOLS[@]}"; do
  xml="$SOURCE_DIR/protocol/$protocol.xml"
  [ -f "$xml" ] || die "missing vendored protocol $xml"
  wayland-scanner client-header "$xml" "$BUILD_DIR/$protocol-client-protocol.h"
  wayland-scanner private-code "$xml" "$BUILD_DIR/$protocol-protocol.c"
  GENERATED_SOURCES+=("$BUILD_DIR/$protocol-protocol.c")
done

mkdir -p "$OUT_DIR"
# Built to a temporary name and moved into place so a running helper holding the
# old inode open never sees a half-written binary.
TMP_BINARY="$(mktemp "$OUT_DIR/.$BINARY_NAME.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"; rm -f "$TMP_BINARY"' EXIT

# shellcheck disable=SC2086 # the pkg-config flags are deliberately word-split.
cc \
  -std=c11 \
  -O2 \
  -Wall \
  -Wextra \
  -Wno-unused-parameter \
  -fno-strict-aliasing \
  "${SANITIZE_FLAGS[@]}" \
  -I"$BUILD_DIR" \
  $CFLAGS_PKG \
  "$SOURCE_DIR/src/json.c" \
  "$SOURCE_DIR/src/image.c" \
  "$SOURCE_DIR/src/wayland.c" \
  "$SOURCE_DIR/src/main.c" \
  "${GENERATED_SOURCES[@]}" \
  $LIBS_PKG \
  -lm \
  -o "$TMP_BINARY"

chmod 755 "$TMP_BINARY"
mv -f "$TMP_BINARY" "$OUT_DIR/$BINARY_NAME"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "$OUT_DIR/$BINARY_NAME"
