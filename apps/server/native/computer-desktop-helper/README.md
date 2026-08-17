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

All four are unprivileged: a wlroots compositor hands them to any client on the
session with no portal and no consent dialog. That is why this is the preferred
Tier 2 path — it is the only one that puts nothing on the user's screen.

The helper is deliberately thin. It speaks Wayland and nothing else: no
retrying, no policy, no waiting, no state beyond the input it is holding down.
Everything above the wire — eased pointer glides, hotkey release order, capture
scaling policy, health accounting — is TypeScript, shared with the KDE backend.

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
`shutdown`. A method the compositor cannot serve returns a JSON-RPC error naming
the missing protocol — never an empty result. The client treats that as a
refusal and leaves the process alone; only a transport failure restarts it.

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
account of it — a keybinding firing, sway's output list:

```sh
SYNARA_NESTED_WLROOTS_TEST=1 bunx vitest run src/computer/portal/wlrootsSession.integration.test.ts
```

It needs `sway` installed. Install a Wayland terminal too (`foot`) and the
window-list assertions run as well instead of skipping.
