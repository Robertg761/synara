# Synara desktop helper

`synara-computer-desktop-helper` is the small C process that owns Synara's
Wayland connection on Tier 2 desktops — every non-KDE Wayland session. Node
cannot hold a `wl_display`, and the protocols this tier depends on are C
libraries with no usable binding, so all of them live here:

| protocol                              | what it gives                             |
| ------------------------------------- | ----------------------------------------- |
| `zwlr_virtual_pointer_manager_v1`     | absolute pointer motion, buttons, scroll  |
| `zwp_virtual_keyboard_manager_v1`     | key press/release with an uploaded keymap |
| `zwlr_screencopy_manager_v1`          | per-output framebuffer capture            |
| `zwlr_foreign_toplevel_management_v1` | the window list, activate, close          |
| `zxdg_output_manager_v1`              | output placement in desktop coordinates   |
| `ext_idle_notifier_v1` (v2 preferred) | human idle/active on the shared seat      |

Every one is unprivileged: a wlroots compositor hands them to any client on the
session with no portal and no consent dialog. That is why this is the preferred
Tier 2 path — it is the only one that puts nothing on the user's screen.

The helper is deliberately thin. It speaks Wayland and nothing else: no
retrying, no policy, no waiting, no state beyond the input it is holding down.
Everything above the wire — eased pointer glides, hotkey release order, capture
scaling policy, health accounting — is TypeScript, shared with the KDE backend.

## Getting one

Synara installs a helper by itself when it can. On the first probe, if nothing
is at the path below, it looks for a binary that shipped with the build and was
compiled for this system, verifies its checksum, and installs it — no compiler,
no headers, no script. `.github/workflows/desktop-helper-prebuilds.yml` builds
those in the same distribution containers the KWin plugin uses and writes them,
with a `manifest.json`, into `prebuilt/`.

A build is claimed by the system it was compiled on: `/etc/os-release`'s `ID`
and `VERSION_ID` plus the architecture, matched exactly, because the binary
links that distribution's libwayland, libxkbcommon, and glibc. Rolling
distributions (Arch, Tumbleweed) have no version worth matching on, so their
entries carry the ID alone and the recorded build glibc is what keeps that safe.
`SYNARA_COMPUTER_HELPER_PREBUILT_DIR` points the lookup somewhere else;
`desktopHelperInstall.ts` is the whole of it.

A system no container in the matrix resembles gets the build below, which is
also what a contributor changing the C wants.

## Building

```sh
./build.sh                 # installs to ~/.local/share/synara/computer/
./build.sh /some/where     # or anywhere else
```

The script prints the path it wrote, which is also where `probe.ts` looks.
`SYNARA_COMPUTER_HELPER` overrides that path, so a developer build and a
packaged one are the same code path.

Build requirements, and the Fedora / Debian packages that carry them:

- a C11 compiler — `gcc` / `build-essential`
- `pkg-config` — `pkgconf-pkg-config` / `pkg-config`
- `wayland-scanner` and libwayland — `wayland-devel` / `libwayland-dev`
- libxkbcommon — `libxkbcommon-devel` / `libxkbcommon-dev`

There is no dependency on `wayland-protocols` or on wlroots itself. The protocol
XMLs are vendored under `protocol/`: the `wlr-*` ones are not in
`wayland-protocols` at all, and vendoring them means the build needs only
libwayland rather than a matching protocol package on every distribution.
`third_party/stb_image_write.h` is the PNG encoder, for the same reason — one
header instead of a libpng version matrix.

## Protocol

Two channels, the same shape the iOS device helper uses (`apps/server/src/device/helperClient.ts`):

- **Control**: newline-framed JSON-RPC 2.0 on stdin/stdout, plus a `ready`
  notification at startup carrying the compositor's global list.
- **Frames**: fd 3, `u32` little-endian length then the shared frame envelope
  (magic `HS`), carrying capture payloads. A full-desktop PNG through the JSON
  channel would be a third larger and would run every screenshot through a JSON
  parser twice a second.

The two are separate fds with **no ordering guarantee between them**, so a
capture response carries a `streamId` and the client matches the payload by it
rather than assuming it arrived first. `desktopHelperClient.ts` is the only
module that knows any of this.

Methods: `globals`, `outputs`, `pointerMotion`, `pointerButton`, `scroll`,
`key`, `releaseAll`, `capture`, `listWindows`, `activateWindow`, `closeWindow`,
`idleState`, `shutdown`. A method the compositor cannot serve returns a JSON-RPC
error naming the missing protocol — never an empty result. The client treats
that as a refusal and leaves the process alone; only a transport failure
restarts it.

`idleState` is the one method whose result is not a direct reading, because
`ext_idle_notifier_v1` has no request that asks how long the seat has been quiet
— it pushes `idled` and `resumed` and nothing else. So the helper arms one
notification at the caller's `timeoutMs` (100 ms … 600 s; a different timeout
re-arms it) and reports the last thing the compositor said: `idle` is which
transition, `sinceMs` is how long ago it arrived, `timeoutMs` is the window it
was armed at, and `observed` is whether any transition has arrived at all.

`observed` is load-bearing and false for at least the first `timeoutMs` after
arming, because the protocol counts its timeout from the notification's
creation rather than from the seat's last input. Without it a caller cannot tell
"the compositor has not spoken yet" from "the human has not stopped typing",
which is the difference between yielding the seat on an empty desk and typing
into somebody's window. On v2 the helper asks for
`get_input_idle_notification`, whose timer ignores idle inhibitors — a video
player holding a `zwp_idle_inhibitor_v1` would otherwise make the seat look
permanently busy and retire the whole yield.

Two short-lived CLI modes exist for the probe, which runs at server boot on
desktops that may have none of these protocols: `--print-globals` and
`--print-outputs` each print one JSON document and exit.

```sh
~/.local/share/synara/computer/synara-computer-desktop-helper --print-globals | head -c 200
```

## What it deliberately does not do

- **No window geometry.** `zwlr_foreign_toplevel_management_v1` has no request
  for a toplevel's position or size, and no Wayland client can ask the
  compositor where a window is. The helper reports no bounds rather than
  guessing, and the TypeScript side refuses window-scoped capture and
  window-relative targeting because of it.
- **No pointer readback.** A virtual pointer is write-only; there is no protocol
  to ask where the cursor is.
- **No second cursor and no second seat.** The virtual devices attach to the
  seat the human is using. That is a wlroots limitation, not a shortcut, and it
  is what `sharedSeat: true` reports to the UI.

## Testing

The TypeScript providers are unit-tested against a fake transport, which cannot
prove any of the C. The lane that can is
`src/computer/portal/wlrootsSession.integration.test.ts`, which boots sway on
the headless wlroots backend and checks the helper's work against sway's own
account of it — a keybinding firing, sway's output list, the seat's idle clock
resetting under injected input:

```sh
SYNARA_NESTED_WLROOTS_TEST=1 bunx vitest run src/computer/portal/wlrootsSession.integration.test.ts
```

It needs `sway` installed. Install a Wayland terminal too (`foot`) and the
window-list assertions run as well instead of skipping.
