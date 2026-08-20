# Synara Computer Use — GNOME Shell extension

A ~300-line GNOME Shell extension that gives Synara a window model on GNOME:
enumeration with geometry and stacking, activation, raise, and close, over the
session bus at `org.synara.ComputerUse`.

It is the GNOME analogue of Synara's KWin plugin
(`apps/server/native/computer-use-kwin`), and it emits the identical window JSON
document, so the server parses both with one parser and a coordinate means the
same thing on either desktop.

## Why an extension is needed at all

Everything else Synara needs on GNOME has a supported, unprivileged route:

| Capability  | Route on GNOME                                 |
| ----------- | ---------------------------------------------- |
| Input       | `org.freedesktop.portal.RemoteDesktop` → libei |
| Capture     | `org.freedesktop.portal.ScreenCast` → PipeWire |
| Clipboard   | RemoteDesktop v2 selections, or `wl-clipboard` |
| **Windows** | **Nothing.**                                   |

Under Wayland a client can see only its own surfaces. There is no protocol a
normal application can use to ask mutter what windows exist, where they are, or
which one has focus — `zwlr_foreign_toplevel_management_v1` (which at least
gives titles and activation on sway and Hyprland) is not implemented by mutter,
and AT-SPI reports extents relative to a window's own frame, so it cannot say
where that frame is on the desktop.

The consequence is not cosmetic. Without a window list with real geometry, an
agent has no launch → locate → zoom → click loop: it cannot tell that the
application it started is already open, cannot scope a screenshot to a window,
and cannot aim a click at one. Synara refuses those operations rather than
answering with an empty list — an empty list is indistinguishable from an empty
desktop, and that ambiguity is what once had an agent launch the same
calculator three times.

Code running inside GNOME Shell is the only place that answer exists. That is
what this extension is: the smallest possible amount of JS inside the
compositor, exposing four window operations and nothing else. It injects no
input, captures no pixels, evaluates nothing, subscribes to no signals, and
keeps no state between calls. (It also does _not_ require GNOME's "unsafe
mode", the developer setting that unlocks `org.gnome.Shell.Eval` — needing that
would be a far worse trade for the same data.)

## Install

The extension is the directory `synara-computer-use@synara.dev` — its name is
its UUID and must not be changed.

### Copy it in

```sh
./install.sh
```

or, equivalently, by hand:

```sh
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r apps/server/native/gnome-shell-extension/synara-computer-use@synara.dev \
      ~/.local/share/gnome-shell/extensions/
```

### Or build a zip and use `gnome-extensions install`

```sh
cd apps/server/native/gnome-shell-extension
gnome-extensions pack synara-computer-use@synara.dev
gnome-extensions install --force synara-computer-use@synara.dev.shell-extension.zip
```

### Enable

```sh
gnome-extensions enable synara-computer-use@synara.dev
```

**A new extension is only picked up after GNOME Shell reloads its extension
list.** On X11 that is `Alt+F2`, `r`, `Enter`. On Wayland there is no way to
restart the shell in place, so **log out and back in** — this is the single most
common reason a fresh install appears to do nothing.

### Verify

```sh
gnome-extensions info synara-computer-use@synara.dev   # State: ENABLED
busctl --user list | grep org.synara.ComputerUse       # the name is owned
gdbus call --session --dest org.synara.ComputerUse \
      --object-path /org/synara/ComputerUse \
      --method org.synara.ComputerUse1.Version
gdbus call --session --dest org.synara.ComputerUse \
      --object-path /org/synara/ComputerUse \
      --method org.synara.ComputerUse1.ListWindows
```

Errors and warnings land in the shell's journal:

```sh
journalctl --user -b -f /usr/bin/gnome-shell
```

### Uninstall

```sh
gnome-extensions disable synara-computer-use@synara.dev
rm -rf ~/.local/share/gnome-shell/extensions/synara-computer-use@synara.dev
```

## D-Bus API

Bus name `org.synara.ComputerUse`, object path `/org/synara/ComputerUse`,
interface `org.synara.ComputerUse1`.

| Method                     | Signature | Meaning                                                     |
| -------------------------- | --------- | ----------------------------------------------------------- |
| `Version()`                | `→ i`     | Wire-protocol version. Currently `1`.                       |
| `ListWindows()`            | `→ s`     | The window document below, as a JSON string, topmost first. |
| `ActivateWindow(windowId)` | `s →`     | Focus the window, switching workspace if needed.            |
| `RaiseWindow(windowId)`    | `s →`     | Restack above its occluders **without** moving focus.       |
| `CloseWindow(windowId)`    | `s →`     | Ask the client to close; the client may refuse.             |

Every failure is a D-Bus error (`org.synara.ComputerUse1.Failed`) with a
sentence saying what went wrong. Nothing ever answers with an empty list to mean
"I could not look".

### The window document

`ListWindows()` returns a JSON array, **topmost first**:

```json
[
  {
    "id": "42",
    "title": "Calculator",
    "appId": "org.gnome.Calculator.desktop",
    "resourceClass": "org.gnome.Calculator",
    "pid": 4711,
    "bounds": { "x": 1280, "y": 240, "width": 400, "height": 600 },
    "visible": true,
    "minimized": false,
    "maximized": false,
    "fullscreen": false,
    "active": true,
    "windowType": "normal",
    "monitor": 1,
    "stackingIndex": 0,
    "occludedBy": []
  }
]
```

- **`id`** is `Meta.Window.get_stable_sequence()`, stringified: mutter's own
  per-window serial. It is stable for the whole life of the window and survives
  remapping, workspace moves, and re-parenting, none of which an XID or a list
  index does. It is _not_ stable across a window being closed and reopened —
  that is a different window.
- **`bounds`** is `get_frame_rect()`: the frame including decorations, in the
  desktop's logical coordinate space, which is the same space pointer actions
  and screenshots use.
- **`stackingIndex`** is depth: `0` is the topmost reported window.
- **`occludedBy`** lists the ids of visible windows above this one whose frame
  rects overlap it. It is a rect intersection, not true pixel occlusion, so a
  translucent or oddly shaped window above still counts. Overstating occlusion
  is the safe direction: the remedy either way is to scope the click to a
  window.
- **`active`** is `has_focus()`: mutter's single focus window, which is the
  window the _human_ is working in.
- **`focused` is deliberately never sent.** In Synara's window document
  `focused` means the _agent seat's_ input target, not the desktop's keyboard
  focus. On KWin the two are different things — the agent has its own seat — and
  the server's post-action observation only photographs a window `focused`
  identifies, precisely so it never captures what the human is doing. GNOME has
  no agent seat: input comes through the RemoteDesktop portal on the human's own
  seat, so there is no window this extension could honestly call the agent's
  focus. Reporting `has_focus()` there would point that observation straight at
  the human's window. The server also forces the field to `false` on this
  provider, so an older extension that still sends it cannot reintroduce the
  leak.
- Override-redirect surfaces (menus, tooltips, drag icons) are excluded. They
  cannot be activated, raised, or closed, and listing windows the other methods
  refuse would be a window model that lies about itself.

Fields Synara does not consume today (`maximized`, `fullscreen`, `windowType`,
`monitor`) are reported anyway: they are free here and expensive to add later
once installs are in the wild.

## Versioning

`Version()` is a compatibility gate, not a build stamp. Synara refuses to use an
extension whose protocol version it does not speak, and says so, rather than
guessing at a document it may misread — a silently mismatched window list is how
a click lands on the wrong monitor.

Bump `PROTOCOL_VERSION` in `extension.js` when the JSON document or a method
signature changes in a way an older server would misread. Do not bump it for
additive fields an older server ignores.

## GNOME Shell version compatibility

`metadata.json` declares `shell-version` 45 through 49. GNOME 45 is the floor
because it is where extensions became ES modules (`import`/`export` and the
`Extension` base class); the pre-45 `imports.*` style is a different file
layout, not a small edit, and is not supported here.

Two APIs are feature-detected rather than pinned to a shell version, because the
version is a packaging fact while the method either exists or does not:

- the window actor list — `global.get_window_actors()`, with
  `global.compositor.get_window_actors()` as the alternate spelling;
- raise-without-focus — `Meta.Window.raise()`, with
  `raise_and_make_recent_on_workspace()` and `raise_and_make_recent()` as the
  newer spellings mutter has been moving towards.

If a future GNOME drops all of a group, the extension answers with a D-Bus error
naming what is missing and telling you to update it. It never silently degrades.

## Session modes, and the lock screen

`session-modes` is `["user"]`, the default: GNOME disables extensions while the
screen is locked, so the bus name **disappears on lock and comes back on
unlock**. That is deliberate and is not worked around. Synara must not be able
to drive a locked session, and window control failing loudly at the lock screen
is exactly the behavior Tier 2 wants. Synara's refusal message names the lock
screen as one of the reasons the extension may not be answering.

## Trust

The extension answers any client on your session bus that asks. That is the same
trust boundary as the KWin plugin's D-Bus API, and the same one every GNOME
extension already lives inside: a process running as you on your session bus can
already read your files and start programs as you. The extension adds window
metadata and window activation to that surface — it adds no input injection, no
capture, and no code execution.
