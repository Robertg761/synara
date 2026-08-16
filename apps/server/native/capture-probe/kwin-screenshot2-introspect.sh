#!/usr/bin/env bash
# Demonstrates the read-only ScreenShot2 service probe and records the local KWin API evidence.
# It never calls Capture* and therefore cannot open a consent dialog or write a screenshot.

set -u

service='org.kde.KWin'
object='/org/kde/KWin/ScreenShot2'
interface='org.kde.KWin.ScreenShot2'
plugin='/usr/lib64/qt6/plugins/kwin/plugins/screenshot.so'

printf '%s\n' '== KWin ScreenShot2 read-only probe =='
printf 'service=%s object=%s interface=%s\n' "$service" "$object" "$interface"

if command -v rpm >/dev/null 2>&1; then
  printf 'packages: '
  rpm -q kwin kwin-common kwin-devel 2>&1
else
  printf '%s\n' 'rpm: unavailable'
fi

printf '%s\n' '--- live user-bus introspection (read-only) ---'
bus_probe_ok=0
if command -v busctl >/dev/null 2>&1; then
  bus_output=$(busctl --user --no-pager introspect "$service" "$object" "$interface" 2>&1)
  bus_status=$?
  printf '%s\n' "$bus_output"
  if [ "$bus_status" -eq 0 ]; then
    bus_probe_ok=1
  fi
else
  printf '%s\n' 'busctl: unavailable'
fi

if [ "$bus_probe_ok" -eq 0 ] && command -v qdbus-qt6 >/dev/null 2>&1; then
  printf '%s\n' '--- qdbus-qt6 fallback (read-only) ---'
  qdbus-qt6 "$service" "$object" 2>&1
fi

printf '%s\n' '--- local KWin screenshot plugin evidence ---'
if [ -r "$plugin" ] && command -v strings >/dev/null 2>&1; then
  printf 'plugin=%s\n' "$plugin"
  strings "$plugin" | rg -n -m 30 'ScreenShot2|Capture(Window|ActiveScreen|Area)|include-(cursor|decoration|shadow)|native-resolution|X-KDE-DBUS-Restricted-Interfaces' 2>&1 || true
else
  printf 'plugin not readable: %s\n' "$plugin"
fi

printf '%s\n' '--- permission note ---'
printf '%s\n' 'The normal-process call is checked by KWin against the caller desktop entry.'
printf '%s\n' 'This probe does not set KWIN_SCREENSHOT_NO_PERMISSION_CHECKS and does not invoke Capture*.'
