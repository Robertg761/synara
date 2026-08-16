#!/usr/bin/env bash
# Demonstrates the KDE ScreenCast portal contract without starting a session.
# It performs only local XML/config inspection and read-only D-Bus introspection,
# so it cannot trigger a consent dialog or create a PipeWire stream.

set -u

portal_service='org.freedesktop.portal.Desktop'
portal_object='/org/freedesktop/portal/desktop'
portal_interface='org.freedesktop.portal.ScreenCast'
portal_xml='/usr/share/dbus-1/interfaces/org.freedesktop.portal.ScreenCast.xml'
backend_xml='/usr/share/dbus-1/interfaces/org.freedesktop.impl.portal.ScreenCast.xml'

printf '%s\n' '== xdg-desktop-portal ScreenCast read-only probe =='
printf 'service=%s object=%s interface=%s\n' "$portal_service" "$portal_object" "$portal_interface"
printf 'desktop=%s current_desktop=%s\n' "${XDG_CURRENT_DESKTOP-}" "${XDG_SESSION_DESKTOP-}"

printf '%s\n' '--- installed KDE portal selection ---'
for file in \
  /usr/share/xdg-desktop-portal/portals/kde.portal \
  /usr/share/xdg-desktop-portal/kde-portals.conf \
  /usr/share/dbus-1/services/org.freedesktop.impl.portal.desktop.kde.service \
  /usr/lib/systemd/user/plasma-xdg-desktop-portal-kde.service; do
  if [ -r "$file" ]; then
    printf 'file=%s\n' "$file"
    sed -n '1,80p' "$file"
  else
    printf 'missing=%s\n' "$file"
  fi
done

printf '%s\n' '--- ScreenCast contract from installed XML ---'
if [ -r "$portal_xml" ]; then
  rg -n -C 2 'CreateSession|SelectSources|Start|OpenPipeWireRemote|restore_token|persist_mode|AvailableSourceTypes|AvailableCursorModes|pipewire-serial' "$portal_xml" 2>&1 || true
else
  printf 'missing=%s\n' "$portal_xml"
fi

printf '%s\n' '--- KDE backend-specific restore data ---'
if [ -r "$backend_xml" ]; then
  rg -n -C 2 'ScreenCast|restore|persist' "$backend_xml" 2>&1 || true
else
  printf 'missing=%s\n' "$backend_xml"
fi

printf '%s\n' '--- live user-bus introspection (read-only) ---'
if command -v busctl >/dev/null 2>&1; then
  busctl --user --no-pager introspect "$portal_service" "$portal_object" "$portal_interface" 2>&1
else
  printf '%s\n' 'busctl: unavailable'
fi

printf '%s\n' '--- daemon flow, no calls made by this probe ---'
printf '%s\n' 'CreateSession -> Request.Response -> SelectSources -> Request.Response -> Start -> Request.Response'
printf '%s\n' '-> OpenPipeWireRemote -> pw_context_connect_fd -> consume negotiated stream -> Session.Close'
printf '%s\n' 'Start is the consent boundary; this script intentionally never reaches it.'
