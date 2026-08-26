#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

command -v systemctl >/dev/null 2>&1 || {
    printf 'Missing required command: systemctl\n' >&2
    exit 1
}

mkdir -p "$SYSTEMD_USER_DIR"

systemctl --user link \
    "$SOURCE_DIR/systemd/synara-kwin-computer-use-rebuild.service" \
    "$SOURCE_DIR/systemd/synara-kwin-computer-use-rebuild.path" \
    "$SOURCE_DIR/systemd/synara-kwin-computer-use-rebuild.timer"
systemctl --user daemon-reload
systemctl --user enable \
    synara-kwin-computer-use-rebuild.path \
    synara-kwin-computer-use-rebuild.timer

printf 'Synara KWin rebuild units are enabled for the user manager. They were not started.\n'
