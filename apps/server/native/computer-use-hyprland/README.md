# Synara computer-use plugin for Hyprland

The Hyprland twin of `../computer-use-kwin`: the agent drives the human's real
desktop with its own drawn ghost cursor and its own input path, never the seat
the human is sitting at. It exposes the identical D-Bus surface —
`org.synara.ComputerUse` at `/org/synara/ComputerUse`, interface
`org.synara.ComputerUse1`, the same sixteen methods and `sessionStopped`
signal — so the server's whole KWin driving path is reused; only loading
differs (`hyprctl plugin load`, which takes effect live with no relogin).

Build with `make` against the installed Hyprland's headers (`pkg-config
hyprland`). The plugin ABI churns per Hyprland release, so builds are
per-version, like the KWin plugin's prebuilts.

Status: window enumeration, session lifecycle (idle timeout, Meta+Shift+Esc
release/resume chord), the ghost cursor (arrow + name badge, scale-aware,
hold-then-fade), and direct per-client input injection (raw wire events on the
target client's own `wl_pointer`/`wl_keyboard` resources, seat-manager serials,
xkb modifier mirror — the compositor's seat state is never touched) are
implemented. The capture pipeline is the remaining milestone; until it lands,
captures raise `org.synara.ComputerUse.Error.CaptureFailed`.

Development testing runs in a disposable nested Hyprland (nested inside a
headless `kwin_wayland --virtual` parent — Hyprland cannot boot headless on a
busy seat), never against the live desktop.
