#!/usr/bin/env bash
# Install and enable the Synara computer-use GNOME Shell extension.
#
# Copies this directory into the user's extension directory under its UUID (the
# directory name *is* the UUID and must match metadata.json), enables it, and
# reports what is left to do. On Wayland the last step is a logout: GNOME Shell
# cannot reload its extension list in place, which is the usual reason a fresh
# install looks like it did nothing.
set -euo pipefail

uuid="synara-computer-use@synara.dev"
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

if [[ "$(basename "$source_dir")" != "$uuid" ]]; then
  echo "error: this script must live in a directory named $uuid" >&2
  exit 1
fi

mkdir -p "$(dirname "$target_dir")"
rm -rf "$target_dir"
cp -r "$source_dir" "$target_dir"
echo "installed $uuid -> $target_dir"

if command -v gnome-extensions >/dev/null 2>&1; then
  # A not-yet-loaded extension cannot be enabled by gnome-extensions on Wayland
  # until the shell has seen it, so a failure here is expected and not fatal.
  if gnome-extensions enable "$uuid" 2>/dev/null; then
    echo "enabled $uuid"
  else
    echo "note: could not enable $uuid yet; GNOME Shell has not loaded it."
    echo "      after logging back in, run: gnome-extensions enable $uuid"
  fi
else
  echo "note: gnome-extensions is not on PATH (install gnome-shell-extension-prefs" \
       "or the gnome-shell package), then run: gnome-extensions enable $uuid"
fi

if [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
  echo "next: log out and back in — GNOME Shell cannot reload extensions on Wayland."
else
  echo "next: restart GNOME Shell with Alt+F2, then r, then Enter."
fi
echo "verify: gdbus call --session --dest org.synara.ComputerUse \\"
echo "          --object-path /org/synara/ComputerUse \\"
echo "          --method org.synara.ComputerUse1.Version"
