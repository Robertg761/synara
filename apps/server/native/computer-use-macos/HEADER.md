# synara-computer-helper

The native side of Synara's macOS computer use: a background program that sees,
clicks, and types on the user's **real** Mac desktop with its own visible
cursor, while the human keeps using the machine — the macOS counterpart of the
Linux KWin/Hyprland tiers, built the way Codex's computer use is built (a
"Software Cursor" picture plus input posted straight to the target process, so
the real pointer never warps).

The authoritative design and reverse-engineering record is
`docs/computer-use-macos-reference.md`. The Node side that drives this helper is
`apps/server/src/computer/MacComputerBackend.ts`.

## Why a native helper

The load-bearing input path uses `CGEventSetWindowLocation`, a private Quartz
symbol resolved with `dlsym` at runtime rather than linked. Release builds ship
a universal helper inside `Synara.app`, signed with the same release identity;
ordinary users therefore do not need Xcode. Source builds retain `build.sh` and
the toolchain-keyed cache as a development fallback. A moved private symbol
becomes a diagnosable capability gap rather than a dyld crash.

## Design choices

**Long-running JSON-RPC server, not subcommands.** Building the event source,
the overlay window, and the AX connections is per-process state. `--probe` and
`--request-permissions` are the two exceptions: one-shot capability and
explicit first-use permission flows owned by the desktop app.

**One channel, stdio only.** Unlike the device helper there is no frame socket.
Tier-1 capture is a whole-desktop PNG still that the Node backend publishes on a
timer, the same way the KWin backend serves the pane, so there is no video pipe
to starve the control channel.

**Three request lanes, not one queue.** The pane's still frame is captured every
500 ms for as long as it is open, so a single serial queue would put every click
behind a screenshot and every screenshot behind a slow AX walk. Requests are
parsed on the stdin thread and run on the lane that owns the method: **input**
(pointer, keyboard, clipboard, `launch-app`, the AX writes `set-value` and
`perform-action`, and `raise-window`) is one serial queue in arrival order,
**perception** (`capture`, `list-windows`, `screen-size`, `ping`,
`capabilities`) is concurrent, and **`describe-ui`** has a serial lane to itself
because AX is synchronous IPC into other processes. Responses may complete out
of order; the JSON-RPC id correlates them and stdout writes are serialised.

**Capture is ScreenCaptureKit first, `screencapture` second.**
`SCScreenshotManager.captureImage` composites in WindowServer with no temp file,
no subprocess, and no second decode, and it takes the caller's `maxDimension`
budget as the output size so the downscale happens at the source. The
`SCShareableContent` call it needs is the one API in this helper that can hang
(radar FB12114396), so it is cached (~2 s), single-flighted, and deadlined at
3 s — a hung call holds its own permit and every later request fails fast to the
CLI. `/usr/sbin/screencapture` is the fallback: same Screen Recording grant, no
hang, and it composites across displays, which is why a region spanning two of
them takes that path. It is also the whole path below macOS 14. Each result says
which link served it (`source`), so the backend can track the fallback rate.

**The helper's own windows are never targets.** The Software Cursor overlay is a
normal-level window parked exactly where the agent is about to click and ordered
frontmost, so an unfiltered hit test resolves _it_ and the click gets posted back
to this process. `Windows.list()` drops every window owned by this pid, which
keeps the overlay out of `list-windows`, occluder computation, `describe-ui`, and
every hit test at once — while leaving it visible in captures, which is the
point of drawing it.

**Every coordinate is global top-left screen points.** `CGWindowList`,
`AXUIElement`, and `CGEvent` already share that space, so an AX-derived target
feeds a synthetic click with no conversion. AppKit (`NSScreen`/`NSWindow`) is the
only bottom-left subsystem, and the flip lives in `Geometry.swift` alone.

**Input is posted to the target process, never the HID stream.** A synthetic
`CGEvent` is stamped with the target pid (field 40), the window id (fields
51/91/92), one click-group id per gesture (field 58), and window-local
coordinates (`CGEventSetWindowLocation`), then delivered with `CGEventPostToPid`.
WindowServer warps the real pointer only as a side effect of HID-stream events,
so pid-targeted posting keeps the human's cursor still. The visible agent cursor
is the overlay window, moved in lockstep.

**A background target is made to believe it is active, then put back.** AppKit
hit-tests mouse events against the tracking state a window last saw, and only
routes keys to an application it considers active — so a gesture aimed at a
window whose app is not frontmost is wrapped in a focus prelude: SkyLight's
`activateWithoutRaise` posts a deactivate/activate record pair (the yabai
"focus without raise" recipe, resolved from `SLPSPostEventRecordTo`; see
`SkyLight.swift`) that flips the target app's AppKit-active state while
WindowServer's z-order and the current Space stay put, a stamped `mouseMoved`
primes the target's tracking state, and after the gesture the inverse pair (or a
re-activation of the human's previous app, if the click genuinely raised the
target) restores what was front. None of this raises a window or switches Space.
The private SkyLight symbols are resolved with `dlsym`, and `capabilities`
reports which resolved under `skylight`; when they are absent the helper still
posts pid-targeted events, which reach a frontmost target.

**Typing is a best-effort-background ladder.** `type` tries an accessibility
`AXSelectedText` insert into the focused text element first — atomic, delivered
to a background AppKit control or web view, and read back for native controls —
then falls through to pid-routed Unicode keystrokes. The result names the rung
(`ax-insert` | `keystrokes` | `foreground`) and whether it was `verified`. A
terminal emulator's view is never given the AX rung (the write never reaches the
pty). `press-key`/`hotkey` post real modifier-down/key/modifier-up transitions,
not just flag bits, because some AppKit hosts need the ordered transitions.
Background drag and Electron background scroll are best-effort (no toolkit in the
reference ledger delivers a background drag); the caller may pass
`deliveryMode: "foreground"` (or `foreground: true` on `drag`) to briefly bring
the target forward and restore the previous app afterward.

**The ladder in full, and what ends it.** Rung 1 is the `AXSelectedText` insert,
taken only where it is meaningful: web content is refused outright (its
accessibility value is a renderer-side mirror that reports success for a page
that never saw the text), and an insert a native control accepted is the end of
the ladder whether or not its value could be read back — retyping on the chance
it did not land is the more expensive mistake. Rung 2 is keystrokes posted to
the target pid, attempted only when the target actually took the synthetic
active state; it ends the ladder when the focused element's value provably
changed, and also when that element exposes no readable value at all, because
"cannot verify" is not "did not deliver". Rung 3 is a genuine activation plus
keys posted to the session event tap with **real virtual keycodes** — the only
path a Chromium or Electron view honours — and it is skipped straight to when
the focused element is web content or the app has already been caught dropping
background input, so those apps never pay for the first two rungs. Rung 3
refuses to post at all unless the target really did become frontmost, since a
session-tap key goes wherever focus actually is. Whatever a gesture took from
the human's application is recorded before it is taken and cleared only after it
has been handed back, so every exit path restores it — including SIGTERM, which
runs `shutdown()` → `input.unwind()` → `exit`. **Mouse events are never posted
to the session tap on any rung**; that is the one path that would warp the
human's physical pointer, and the foreground rung changes only which app is
active, never where the cursor is.

## Protocol

Newline-delimited JSON-RPC 2.0 on stdio: one object per line, requests on stdin,
responses and notifications on stdout. Diagnostics go to stderr and never mix
into the protocol stream. On start the helper emits
`{"jsonrpc":"2.0","method":"ready","params":{"protocolVersion":1}}`.

### Methods

| Method             | Params                                                                               | Result                                                                            |
| ------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `ping`             | –                                                                                    | `{ok, pid}`                                                                       |
| `capabilities`     | –                                                                                    | `{arch, macosVersion, screenRecording, accessibility, skylight, protocolVersion}` |
| `list-windows`     | –                                                                                    | `{windows: [...], workspace, focusedWindowId}`                                    |
| `screen-size`      | –                                                                                    | `{x, y, width, height, scale}`                                                    |
| `describe-ui`      | `maxDepth?` (40), `windowIds?`                                                       | `{root}` — desktop AX forest, agent-addressable                                   |
| `capture`          | `kind` (`window`\|`region`), `windowId`\|`region`, `maxDimension?` (2048), `source?` | `{base64, region, source}`                                                        |
| `launch-app`       | `app`, `arguments?`                                                                  | `{resolvedCommand}`                                                               |
| `move`             | `x`, `y`                                                                             | `{x, y}` (where the agent cursor moved)                                           |
| `click`            | `x`, `y`                                                                             | `{x, y}` (landing point)                                                          |
| `double-click`     | `x`, `y`                                                                             | `{x, y}`                                                                          |
| `right-click`      | `x`, `y`                                                                             | `{x, y}`                                                                          |
| `drag`             | `fromX`, `fromY`, `toX`, `toY`, `durationMs?` (220), `foreground?`                   | `{ok, path}`                                                                      |
| `scroll`           | `deltaX`, `deltaY`, `x?`, `y?`                                                       | `{ok}`                                                                            |
| `type`             | `text`, `deliveryMode?`                                                              | `{ok, path, verified}`                                                            |
| `press-key`        | `key`, `modifiers?`, `deliveryMode?`                                                 | `{ok, path}`                                                                      |
| `hotkey`           | `keys` (modifiers + one key), `deliveryMode?`                                        | `{ok, path}`                                                                      |
| `set-value`        | `windowId`, `nodePath`, `value`                                                      | `{ok}`                                                                            |
| `perform-action`   | `windowId`, `nodePath`, `action`                                                     | `{ok}`                                                                            |
| `raise-window`     | `windowId`                                                                           | `{ok}`                                                                            |
| `read-clipboard`   | `maxBytes?`                                                                          | `{text, truncated}` — empty text when past `maxBytes`                             |
| `write-clipboard`  | `text`                                                                               | `{ok}`                                                                            |
| `set-agent-cursor` | `name`                                                                               | `{ok}`                                                                            |

All coordinates are **global top-left screen points**. A pointer result echoes
the point the action actually used: requests are clamped onto the desktop's
bounding rect first, so a coordinate off every display lands on the nearest edge
instead of resolving no window and silently doing nothing, and the backend
compares the echo with the request to report the clamp. `scroll` returns only
`{ok}` — it has no landing point to report.

Optional parameters and fields added since protocol version 1 are additive; an
older caller that omits them gets the previous behaviour.

- `describe-ui.windowIds` — walk only those windows (ids from `list-windows`).
  Absent means the whole desktop.
- `capture.source` — force `screencapturekit` or `screencapture`, for
  diagnostics; absent means the normal chain.
- `type`/`press-key`/`hotkey` `deliveryMode` — `background` (default) or
  `foreground` (briefly front the target, then restore the previous app).
- `drag.foreground` — `true` runs the drag in the foreground rung.
- `type` result `path` — `ax-insert` | `keystrokes` | `foreground`; `verified`
  is true only when a native control's value read back with the text (never for
  web content, whose AX value is an untrusted renderer mirror).
- `press-key`/`hotkey`/`drag` result `path` — the rung that ran.
- `capabilities.skylight` — `{focusWithoutRaise, setFrontProcess,
setWindowLocation}`, which private WindowServer entry points resolved on this
  OS. Input still works without them against a frontmost target.
- `capture` result `region` is the rect the pixels actually cover: a request
  that runs off the display it lands on comes back clipped, because the backend
  derives the screenshot scale from PNG pixels over region points.
- `capture` result `source` names the link of the chain that served it.
- `describe-ui` marks a window node whose subtree hit the node cap with
  `"truncated": true`.

`raise-window` tries `AXRaise` on the matching AX window first, which brings the
window forward inside its own application without activating that application.
Only if the window is still not frontmost afterwards does it fall back to
`NSRunningApplication.activate`, which does change the human's active app.

The AX walk is bounded on every axis so one unresponsive app cannot stall
perception: a 1 s messaging timeout per application and 0.35 s per window, one
batched IPC per node instead of seven, 2048 nodes per window and ~6000 per
desktop, minimized/off-screen windows skipped, and subtrees whose frame lies
entirely outside their window skipped (zero-size layout containers are still
descended). Skipped children keep their sibling index, so `nodePath` stays the
real child-index route that `set-value`/`perform-action` re-resolve against.

### Errors

Standard JSON-RPC codes, plus `-32000` (permission denied — a TCC grant is
missing), `-32001` (target window/node missing), and `-32002` (input accepted
but not delivered).

## Permissions

Two TCC services matter: **Screen Recording** (capture; `capture` and the pane
still frames refuse without it) and **Accessibility** (`describe-ui`,
`set-value`, `perform-action`, and — through the input path — reliable synthetic
events). Neither can be self-granted; both are user-driven clicks. `capabilities`
and `--probe` report the current grant state from inside the helper, which is the
only place a responsible-process misattribution is visible. Grants attach to the
**responsible bundle**, so a packaged build must spawn this helper from the same
signed app whose TCC grants it should inherit (see the design reference).

## Status

Capture, window enumeration, and the lane split are verified on device
(Apple Silicon, macOS 27: full-workspace still at `maxDimension` 2048 in ~55 ms,
a `ping` answered in <1 ms while one was in flight). The input path, AX walk, and
Software Cursor overlay implement the confirmed Codex technique but require
on-device verification with the Accessibility grant held — the same way
the Linux tiers were live-verified on the reference machine before landing.
Release builds ship it as a signed nested app bundle; source development retains
the build-and-cache fallback. It never runs on the Linux CI host, where the
backend reports `backend-unavailable` from its passive probe.
