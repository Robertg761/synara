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

The load-bearing input path uses `CGEventSetWindowLocation` and the SkyLight
process-event-record SPI: private symbols resolved with `dlsym` at runtime
rather than linked (`SkyLight.swift`). A symbol Apple moves therefore
becomes a diagnosable capability gap — a `false` in `capabilities.skylight` —
rather than a dyld crash at launch.

Three ways the binary reaches a running system, in the order
`MacComputerHelperProvisioner.ensureBinary()` tries them
(`apps/server/src/computer/macComputerHelperProvisioning.ts`):

1. **The prebuilt signed bundle** — `Contents/Helpers/Synara Computer Use.app`
   inside `Synara.app`, produced at release time by
   `apps/desktop/scripts/build-computer-helper.mjs` and handed to the server as
   `SYNARA_COMPUTER_HELPER_BINARY_PATH`. Ordinary users never need Xcode. Its
   bundle identifier is _derived_ from the app's own — `SYNARA_PRODUCTION_BUNDLE_ID`
   plus a suffix, in `packages/shared/src/computerHelperPaths.ts` — because macOS
   files the TCC grants under that string and `Windows.swift` refuses to drive any
   window whose owner matches the app's identifier prefix. A rebrand must move
   both or neither.
2. **A cached source build**, under `~/Library/Caches/synara/computer-helper`,
   keyed on the Xcode build version plus a digest of these sources, so a helper
   fix invalidates the cache exactly the way an Xcode upgrade does.
3. **A fresh `build.sh` run** into that cache — the development path, and the
   path for CLI installs, which stage these sources beside the server bundle and
   name them with `SYNARA_COMPUTER_HELPER_SOURCE_DIR`. A packaged app whose
   sources resolve inside `app.asar` refuses this rung outright rather than
   handing a compiler a path `stat` can walk and a compiler cannot read.

`build.sh` builds **host-native**: its target triple is
`$(uname -m)-apple-macosx12.3`. The universal arm64 + x86*64 helper exists only
when `build-computer-helper.mjs` runs with `--arch universal`, which compiles
each slice separately, `lipo`s them together, wraps the result in the bundle
with its `Info.plist` (carrying the mandatory `NSScreenCaptureUsageDescription`
and the derived bundle identifier), and ad-hoc signs it. The release identity is
applied afterwards by electron-builder, which is given the \_bundle* path to sign
because a bundle is the unit macOS signs and TCC identifies.

## Design choices

**Long-running JSON-RPC server, not subcommands.** Building the event source,
the overlay window, and the AX connections is per-process state. `--probe` and
`--request-permissions` are the two exceptions: one-shot capability and
permission commands that never start the server or the overlay, kept for the
build and for debugging. The permission ask that users actually see comes from
the live `request-permissions` RPC instead, because the prompt has to be raised
by the process that needs the grant, at the moment it needs it.

**One channel, stdio only.** Unlike the device helper there is no frame socket.
Tier-1 capture is a whole-desktop PNG still that the Node backend publishes on a
timer, the same way the KWin backend serves the pane, so there is no video pipe
to starve the control channel.

**Three request lanes, not one queue.** The pane's still frame is captured every
500 ms for as long as it is open, so a single serial queue would put every click
behind a screenshot and every screenshot behind a slow AX walk. Requests are
parsed on the stdin thread and run on the lane that owns the method: **input**
(pointer, keyboard, clipboard, `launch-app`, the AX writes `set-value` and
`perform-action`, `focus-window`, `raise-window`, and `set-agent-cursor`) is one
serial queue in arrival order, **perception** (`capture`, `list-windows`,
`screen-size`, `ping`, `capabilities`, `request-permissions` — a TCC dialog must
never sit on the input lane holding every click behind it — and any unknown
method, which must not sit behind input to be told it does not exist) is concurrent, and
**`describe-ui`** has a serial lane to itself because AX is synchronous IPC into
other processes. Responses may complete out of order; the JSON-RPC id correlates
them and `writeMessage` serialises the writes. The lane owns the AX _walk_, not
accessibility in general: the typing read-back, the delivery watch and the
keyboard focus nudge are bounded round trips that belong to the action they are
part of, so they run on the input lane in that action's order.

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

**The helper's own windows, and Synara's, are never targets.** The Software
Cursor overlay is a normal-level window parked exactly where the agent is about
to click and ordered frontmost, so an unfiltered hit test resolves _it_ and the
click gets posted back to this process. `Windows.enumerate()` drops four
categories of owner, not one:

- this pid, which is the overlay;
- every pid on this process's parent chain (`ancestorProcessIDs`, walked with
  `proc_pidinfo`, bounded at 16 hops) — the server that spawned the helper and
  the app that spawned the server;
- any app whose bundle identifier is `com.emanueledipietro.synara` or a child of
  it (`isHostApplication`), which catches a second Synara the user has open and
  a helper started out of band;
- any _other_ process running this same executable file name (`isHelperProcess`,
  by `proc_pidpath`), because an installed Synara's helper and a dev server's
  helper can be alive at once and the other instance's overlay is exactly as bad
  a click target as ours.

The first and last keep the overlay out of `list-windows`, occluder computation,
`describe-ui`, and every hit test at once — while leaving it visible in captures,
which is the point of drawing it. The middle two are what make "cannot drive
Synara itself" an enforced limit rather than a note: an agent that can drive the
app driving it can approve its own approval dialogs.

**Every coordinate is global top-left screen points.** `CGWindowList`,
`AXUIElement`, and `CGEvent` already share that space, so an AX-derived target
feeds a synthetic click with no conversion. AppKit (`NSScreen`/`NSWindow`) is the
only bottom-left subsystem, and the flip lives in `Geometry.swift` alone.
`NSScreen` is main-thread API and every lane needs the workspace rect, so
`Geometry` reads the screens once on main into an immutable snapshot (workspace
union, primary height, per-display frame and backing scale) and refreshes it on
`NSApplication.didChangeScreenParametersNotification`; the lanes only ever read
it. A _point_ off every display is pinned to the nearest edge
(`clampToWorkspace`) so the action lands somewhere real and the echo is honest;
a _region_ cannot be pinned and still mean anything, so `clampRectToWorkspace`
clips it to the displays and refuses when the intersection is empty — which also
keeps a `1e30` rect away from Swift's trapping `Int(_:)` conversions, a
one-tool-call way to kill the helper.

**Input is posted to the target process, never the HID stream.** A synthetic
`CGEvent` is stamped with the target pid (field 40), the window id (fields
51/91/92), one click-group id per gesture (field 58), and window-local
coordinates (`CGEventSetWindowLocation`), then delivered with `CGEventPostToPid`.
WindowServer warps the real pointer only as a side effect of HID-stream events,
so pid-targeted posting keeps the human's cursor still. The visible agent cursor
is the overlay window, moved in lockstep.

**A background target is made to believe it is active and key, then put back.**
AppKit hit-tests mouse events against the tracking state a window last saw, and
only routes keys to an application it considers active — so a gesture aimed at a
window whose app is not frontmost is wrapped in a focus prelude: SkyLight's
`activateWithoutRaise` posts a deactivate/activate record pair (the yabai
"focus without raise" recipe, resolved from `SLPSPostEventRecordTo`; see
`SkyLight.swift`) that flips the target app's AppKit-active state while
WindowServer's z-order and the current Space stay put, then a second record pair
(`makeKeyWindow`, yabai's `window_manager_make_key_window`) that makes the named
window its _key_ window. That second pair is what makes Chromium and Electron
reachable at all: measured on this machine, with the activate record alone a
pid-posted mouseDown into a background page produces no `mousedown` event
whatsoever, and with both pairs the same click lands, the page takes focus, and
pid-routed Unicode keystrokes insert text. A stamped `mouseMoved` primes the
target's tracking state, and after the gesture the inverse activate pair (or a
re-activation of the human's previous app, if the click genuinely raised the
target) restores what was front; no key-window record is posted at the human's
app, which does not need one. None of this raises a window or switches Space.
Both pairs are the same 248-byte envelope, posted with `SLPSPostEventRecordTo`.
The activate/deactivate record carries `0xF8` at `0x04` (its own size), kind
`0x0D` at `0x08`, the window id little-endian at `0x3C`, and `0x01`/`0x02` at
`0x8A`; every other byte is zero. The key-window record carries `0xF8` at `0x04`
and `0x10` at `0x3A`, the window id little-endian at `0x3C`, `0xFF` through
`0x20..<0x30`, and is posted **twice** — once with `0x08 = 0x01`, once with
`0x08 = 0x02`. Measured, that pair moves key status without generating any
content-level click (the probe page's `mousedown` counter does not move when
only these are posted) and without changing z-order, Space, or the front
application. `postPair` sleeps **40 ms** between the deactivate and the activate
in both directions, prelude and restore: without it the activate overtakes the
resign-active the deactivate started and the receiving app ends up believing the
wrong one won.

macOS 14 is the one exception, and it is a crash rather than a dropped gesture:
Sonoma routes the record through `CGSEncodeEventRecord` → `NSKeyedArchiver`,
which reads the `0xFF` fill at `0x20` as an Objective-C class pointer and aborts
_the calling process_. The helper therefore skips the key-window record on major
version 14 (`keyWindowRecordIsSafe`), reports
`capabilities.skylight.keyWindowRecord: false`, and web targets fall to the
visible rung by the ordinary learned route. The backend reads that flag into
`health.backgroundInputDegraded`
(`MacComputerBackend.setBackgroundInputDegraded`), and the settings panel turns
it into one sentence — "Typing into background windows brings them forward" —
because otherwise "windows keep jumping to the front" is unexplainable to the
person watching it happen.

The private SkyLight symbols are resolved with `dlsym`, and `capabilities`
reports which resolved under `skylight`; when they are absent the helper still
posts pid-targeted events, which reach a frontmost target.

**Typing is a background ladder.** `type` tries an accessibility
`AXSelectedText` insert into the focused text element first — atomic, delivered
to a background AppKit control, and read back — then falls through to pid-routed
Unicode keystrokes, which reach a background web view as well as a native one.
The result names the rung (`ax-insert` | `keystrokes` | `foreground-keys` |
`foreground`) and how far
the effect could be `verified` (`confirmed` | `unconfirmed` | `unverifiable`). A terminal emulator's view is never given the AX rung (the
write never reaches the pty). `press-key`/`hotkey` post real
modifier-down/key/modifier-up transitions, not just flag bits, because some
AppKit hosts need the ordered transitions. Background drag is best-effort (no
toolkit in the reference ledger delivers a background drag); `deliveryMode:
"foreground"` (or `foreground: true` on `drag`) briefly brings the target
forward and restores the previous app afterward. Both parameters are
**helper-internal**: no Synara caller sends either, and the ladder reaches the
visible rung on its own by the learning net below. They exist for bench runs and
for a future caller that has a reason to ask.

**The ladder in full, and what ends it.** Rung 1 is the `AXSelectedText` insert,
taken only where it is meaningful: web content is refused outright (its
accessibility value is a renderer-side mirror that reports success for a page
that never saw the text), and an insert a native control accepted is the end of
the ladder whether or not its value could be read back — retyping on the chance
it did not land is the more expensive mistake. Rung 2 is keystrokes posted to
the target pid, attempted only when the target actually took the synthetic
active state; it ends the ladder when the focused element's value provably
changed, and also when that element exposes no readable value at all, because
"cannot verify" is not "did not deliver". It is the rung web content takes:
with the key-window record in the prelude, a background Chromium page reports
`keydown` and its input element gains the text. Rung 3 is a genuine activation
plus keys posted to the session event tap with **real virtual keycodes**, and is
reached only when the caller asked for `deliveryMode: "foreground"` or when this
application has already been caught dropping a background gesture — nothing is
assumed about a toolkit in advance any more. Rung 3 refuses to post at all
unless the target _was observed_ to become frontmost — the settled reading of
WindowServer's front process, not the return value of the activation request,
and never an assumption — since a session-tap key goes wherever focus actually
is. Whatever a gesture took from
the human's application is recorded before it is taken and cleared only after it
has been handed back, so every exit path restores it — including SIGTERM, which
runs `shutdown()` → `input.unwind()` → `exit`. **Mouse events are never posted
to the session tap on any rung**; that is the one path that would warp the
human's physical pointer, and the foreground rung changes only which app is
active, never where the cursor is.

**How the ladder learns, and how it decides it did.** Nothing about a toolkit is
assumed in advance. A pointer gesture on the invisible rung is watched by
`DeliveryWatch` (`Input.swift`), which asks one `Accessibility.GestureProbe` —
a single `Application` handle for the whole gesture, at the **0.35 s per-window**
messaging timeout, under a **0.75 s** wall budget — for the element under the
click point _before_ posting, and for the application's focused element
afterwards. It draws a conclusion only when it is entitled to one: the element
must be settable-focusable and must not already hold focus, or the answer is
`unverifiable`. An expired budget is `unverifiable` too, never an escalation:
a wrong "delivered" costs nothing, a wrong "undelivered" costs a permanent
flicker. Only an `unconfirmed` — read back, and demonstrably unchanged — puts the
application's **bundle id** into `foregroundOnlyBundles`, after which every
gesture and keystroke into that app skips straight to the visible rung. The set
is keyed on bundle id so the verdict survives a relaunch and two windows of one
app share one answer, it is touched only from the serial input lane, and it is
empty for every application measured so far — Chromium and Electron included,
since the key-window record landed.

**The focus debt is paid exactly once.** `Focus.begin` records what the gesture
is about to take (`PendingFocusRestore.recordPair` for the invisible rung,
`.activation` for the visible one) _before_ it takes it, so a SIGTERM arriving
mid-gesture still finds the debt. `Focus.end()` on the input lane and `unwind()`
from the signal source both pay it, and both claim it through the same
`takePendingFocusRestore()`, which reads and clears under one lock — the two used
to be separate steps, and a SIGTERM landing between them had both post the
inverse pair, deactivating the human's application a second time on the way out.

## Protocol

Newline-delimited JSON-RPC 2.0 on stdio: one object per line, requests on stdin,
responses and notifications on stdout. Diagnostics go to stderr and never mix
into the protocol stream. On start the helper emits
`{"jsonrpc":"2.0","method":"ready","params":{"protocolVersion":1}}`.

### Methods

| Method                | Params                                                                               | Result                                                                            |
| --------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `ping`                | –                                                                                    | `{ok, pid}`                                                                       |
| `capabilities`        | –                                                                                    | `{arch, macosVersion, screenRecording, accessibility, skylight, protocolVersion}` |
| `request-permissions` | –                                                                                    | Same report as `capabilities`, after prompting for whatever is missing            |
| `list-windows`        | –                                                                                    | `{windows: [...], workspace, focusedWindowId}`                                    |
| `screen-size`         | –                                                                                    | `{x, y, width, height, scale}`                                                    |
| `describe-ui`         | `maxDepth?` (40), `windowIds?`                                                       | `{root}` — desktop AX forest, agent-addressable                                   |
| `capture`             | `kind` (`window`\|`region`), `windowId`\|`region`, `maxDimension?` (2048), `source?` | `{base64, region, source}`                                                        |
| `launch-app`          | `app`, `arguments?`                                                                  | `{resolvedCommand}`                                                               |
| `move`                | `x`, `y`, `windowId?`                                                                | `{x, y}` (where the agent cursor moved; posts no event, so no `path`/`verified`)  |
| `click`               | `x`, `y`, `windowId?`                                                                | `{x, y, path, verified}` (landing point)                                          |
| `double-click`        | `x`, `y`, `windowId?`                                                                | `{x, y, path, verified}`                                                          |
| `right-click`         | `x`, `y`, `windowId?`                                                                | `{x, y, path, verified}`                                                          |
| `drag`                | `fromX`, `fromY`, `toX`, `toY`, `durationMs?` (220), `windowId?`, `foreground?`      | `{ok, path, verified}`                                                            |
| `scroll`              | `deltaX`, `deltaY`, `x?`, `y?`, `windowId?`                                          | `{ok, path, verified}`                                                            |
| `type`                | `text`, `deliveryMode?`                                                              | `{ok, path, verified}`                                                            |
| `press-key`           | `key`, `modifiers?`, `deliveryMode?`                                                 | `{ok, path, verified}`                                                            |
| `hotkey`              | `keys` (modifiers + one key), `deliveryMode?`                                        | `{ok, path, verified}`                                                            |
| `focus-window`        | `windowId`                                                                           | `{ok}` — aims the keyboard, changes no stacking                                   |
| `set-value`           | `windowId`, `nodePath`, `value`                                                      | `{ok}`                                                                            |
| `perform-action`      | `windowId`, `nodePath`, `action`                                                     | `{ok}`                                                                            |
| `raise-window`        | `windowId`                                                                           | `{ok}`                                                                            |
| `read-clipboard`      | `maxBytes?`                                                                          | `{text, truncated}`, or `{text: "", truncated: true, byteLength}` past `maxBytes` |
| `write-clipboard`     | `text`                                                                               | `{ok}`                                                                            |
| `set-agent-cursor`    | `name`                                                                               | `{ok}`                                                                            |

All coordinates are **global top-left screen points**. A pointer result echoes
the point the action actually used: requests are clamped onto the desktop's
bounding rect first, so a coordinate off every display lands on the nearest edge
instead of resolving no window and silently doing nothing, and the backend
compares the echo with the request to report the clamp. `scroll` reports no
landing point — it may be aimed by `windowId` alone, in which case it turns the
wheel over the centre of that window.

A `windowId` is a decimal `CGWindowID` string; the _optional_ one on the pointer
methods also accepts a JSON number in `UInt32` range, because a caller that has
the id as a number should not have to stringify it to be understood. Present but
unreadable — a typo, a negative, an out-of-range number — is an `invalidParams`
error, never a silent fall back to "whatever is topmost at this point": that
fallback quietly re-aimed a window-scoped click at whatever was drawn over the
coordinate.

`raise-window` is served but **no Synara caller invokes it**:
`MAC_HELPER_METHODS` omits it, and `ComputerManager.prepareResolvedTarget` skips
the raise entirely for this backend because it declares
`deliversToNamedWindowRegardlessOfStacking` — input stamped with a window id
reaches that window whatever is stacked above. The method stays for callers that
genuinely want a window brought forward inside its own application, and for the
bench.

Optional parameters and fields added since protocol version 1 are additive; an
older caller that omits them gets the previous behaviour.

- `describe-ui.windowIds` — walk only those windows (ids from `list-windows`).
  Absent means the whole desktop.
- `capture.source` — force `screencapturekit` or `screencapture`, for
  diagnostics; absent means the normal chain.
- `type`/`press-key`/`hotkey` `deliveryMode` — `background` (default) or
  `foreground` (briefly front the target, then restore the previous app).
- `drag.foreground` — `true` runs the drag in the foreground rung.
- `type` result `path` — `ax-insert` | `keystrokes` | `foreground-keys` (the
  visible rung, reached by escalation) | `foreground` (the visible rung, asked
  for).
- `click`/`double-click`/`right-click`/`scroll`/`drag` result `path` — the rung
  that ran, `background` or `foreground`.
- `press-key`/`hotkey` result `path` — `keystrokes` or `foreground`.
- Every input result carries `verified`, a **string**, never a boolean:
  - `confirmed` — a read-back observed the effect (the focused element's value
    gained the text; the element the click was aimed at now holds focus).
  - `unconfirmed` — a read-back was possible and showed no change: the target
    did not react.
  - `unverifiable` — there was nothing to read back, so neither claim would be
    honest. Web content (whose AX value is an untrusted renderer mirror), a
    control that exposes no value, a click on something that was already
    focused or could never take focus, a scroll or a drag (nothing generic
    reports how far a view moved), and an accessibility probe that spent its
    per-gesture budget all answer this.

  The backend forwards the pair as `ComputerActionResult.delivery`
  (`packages/contracts/src/computer.ts`), and the tool guidance tells the agent
  what to do with each: only `unconfirmed` is worth a `computer_get_state` or
  `computer_screenshot` before continuing, `unverifiable` is the ordinary answer
  for most native controls and is not a failure, and no verdict justifies
  blindly retrying the same input.

- `list-windows` — `focusedWindowId` is the focused _application's_ front
  on-screen window, and exactly the window whose entry carries `"focused": true`
  (both come from one observation, `Windows.frontmost()`, passed into every
  window's dictionary rather than re-derived per window). Focus is a property of
  the process, so the process is what is asked: `SkyLight.frontmostPID()` —
  `_SLPSGetFrontProcess` → `GetProcessPID`, falling back to
  `NSWorkspace.frontmostApplication` — then that pid's frontmost on-screen
  window. Unlike `NSWorkspace` alone this is current immediately after a change
  the helper caused, which is what the focus prelude and the foreground rung
  both settle against. There is deliberately no fallback to the stacking-topmost
  window: a floating panel of some other application sits above everything
  without being focused at all. Null when the front application owns no window
  the agent may drive (Synara itself, the helper, an app showing only a panel).
- `capabilities.skylight` — four booleans: `setWindowLocation` (the
  window-local stamp), `focusWithoutRaise` (`SLPSPostEventRecordTo` plus a way
  to resolve the target's process serial), `setFrontProcess`, and
  `keyWindowRecord` (the second record pair, and the one thing that is `false`
  on a resolvable OS: macOS 14 aborts on it). Input still works without them
  against a frontmost target; the backend turns `keyWindowRecord: false` into
  `health.backgroundInputDegraded`.
- `capture` result `region` is the rect the pixels actually cover: a request
  that runs off the display it lands on comes back clipped, because the backend
  derives the screenshot scale from PNG pixels over region points.
- `capture` result `source` names the link of the chain that served it, and the
  backend counts the answers (`MacComputerBackend.captureSourceCounts()`) so the
  fallback rate is a measured health metric rather than a guess.
- `capture` refuses rather than returning pixels it cannot describe: a region
  that intersects no display is `invalidParams`, and a window that is not on
  screen is `targetMissing` — its composited pixels do not exist, so any region
  reported for them would be a rect the image never covered.
- `describe-ui` marks a window node whose subtree hit the node cap with
  `"truncated": true`.

`raise-window` uses `AXRaise` on the matching AX window, which brings the window
forward inside its own application without activating that application. There is
deliberately no activation fallback: if the window is still not frontmost
afterwards it reports `notDelivered` (-32002) rather than pulling the human's
active application out from under them, and the caller decides whether the
target is genuinely occluded. Keyboard actions (`type`, `press-key`, `hotkey`)
need a window to have been aimed at first — by a pointer gesture, `focus-window`
or `raise-window` — and report `targetMissing` (-32001) otherwise, rather than
typing into whatever the human happens to be using.

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
but not delivered). What actually reaches each one:

- **`-32602` invalidParams** — a `windowId` that is present but not a decimal
  `CGWindowID` (never a silent fall back to "whatever is topmost at this
  point"); a `capture` `kind` that is neither `window` nor `region`; a region
  that is non-finite or intersects no display (`Geometry.clampRectToWorkspace`);
  a `deliveryMode` other than `background`/`foreground`; a `hotkey` with zero or
  more than one non-modifier key; an unknown key name; an unknown modifier name
  — `["hyper", "cmd"]` is a bad request, not a smaller chord that quietly runs.
- **`-32001` targetMissing** — a named window that no longer exists (for
  `capture`, `focus-window`, `raise-window`, `set-value`, `perform-action`, and
  every pointer gesture that named one); a window capture whose window is not on
  screen or is on no display, because its composited pixels do not exist and any
  region reported for them would be a rect the image never covered; a keyboard
  action (`type`, `press-key`, `hotkey`) with no window aimed at yet; an event
  with no resolvable destination, since there is no frontmost fallback on any
  path; and `launch-app` when `open` reports no such application.
- **`-32002` notDelivered** — `raise-window` when `AXRaise` left the window
  short of frontmost, and the foreground keyboard rung when the target was not
  _observed_ to become frontmost within 400 ms (`withForeground`), because a
  session-tap key goes wherever focus actually is.
- **`-32603` internalError** — an event the helper could not construct, a
  `screencapture` fallback that failed or blew its 3 s deadline, and
  `launch-app` past its **10 s** deadline (`launchDeadlineSeconds`), which is
  terminated rather than waited on: `open` runs on the serial input lane and an
  unbounded `waitUntilExit()` held every later click behind a quarantine dialog.

## Permissions

Two TCC services matter: **Screen Recording** (capture; `capture` and the pane
still frames refuse without it) and **Accessibility** (`describe-ui`,
`set-value`, `perform-action`, and — through the input path — reliable synthetic
events). Neither can be self-granted; both are user-driven clicks. `capabilities`
and `--probe` report the current grant state from inside the helper, because this
is the process that will actually call the APIs, and `request-permissions` (the
live RPC, or the `--request-permissions` one-shot) asks macOS for whatever is
missing and answers with the same report. The server calls the RPC the moment it
detects a missing grant on an agent path, and throttles it to one ask per grant
per helper process: the Accessibility dialog reappears on every request, so an
unthrottled ask would stack one dialog per agent action.

The grants are **not** filed against this bundle. TCC answers a check against the
_responsible process_, which for a helper spawned inside `Synara.app` is Synara:
Privacy & Security lists Synara, the TCC database has rows for
`com.emanueledipietro.synara` and none for this helper's identifier, and running
this binary from a shell reports that shell's grants. (Codex is the same shape —
one row, `com.openai.codex`.) The helper's own bundle identity matters for
notarization and the hardened runtime, not for TCC. A packaged build must still
spawn it from the signed app, so that the responsible process is Synara rather
than whatever else launched it.

`report()` also answers `"signature": "adhoc" | "signed"`, read off this build's
own code signature. TCC pins an ad-hoc grant to the binary's cdhash, so a local
rebuild invalidates the grant while System Settings goes on showing Synara
switched on — and macOS then answers `request-permissions` from that dead
decision without showing a dialog. When this says `adhoc` the server therefore
runs `tccutil reset <Service> com.emanueledipietro.synara` (no privilege needed
for the app's own bundle id) for each missing grant _before_ it asks, which is
the only thing that makes the prompt appear again; the Terminal command survives
in the user-facing copy only as the fallback for when no dialog arrives. A
Developer ID signature keys on identifier plus team and survives rebuilds, so
nothing on a signed build ever touches TCC.

A missing grant is the one refusal the user has to act on, and the server treats
it that way. Two routes reach the same place: a `-32000` refusal, which
`MacComputerBackend` marks `setupRequired`, and a `capabilities` report with a
grant missing, which becomes a `permission-required` availability naming the
grants. Both also ask macOS for the grant through `request-permissions`, throttled to one
ask per grant per helper process. The agent gateway turns the first of either in
a turn into a "Computer control needs setup" card in the chat, whose button runs
`computer.provision` — which re-arms the throttle and asks again, for a user who
dismissed the dialog. Every
other error code stays an ordinary tool error for the agent to recover from.

## Status

Verified on device, per subsystem, on one machine: Apple Silicon, macOS 27.0,
single display, Accessibility and Screen Recording granted.

- **Capture, window enumeration, the lane split** — verified. Full-workspace
  still at `maxDimension` 2048 in ~55 ms; a `ping` answered in <1 ms while one
  was in flight.
- **Background pointer, typing and scroll** — verified into a Chromium window
  (Helium) with another application frontmost: the click lands, the page takes
  focus, pid-routed Unicode inserts text, the wheel turns, the human's previous
  application is restored, and the real cursor does not move. This is the
  measurement the key-window record exists for.
- **`press-key` / `hotkey`** — verified.
- **The Software Cursor overlay** — motion measured from the live per-frame
  trace (`SYNARA_CURSOR_TRACE=1`): see the numbers in `Cursor.swift`.
- **Background drag into Chromium** — implemented, **not** verified. No toolkit
  in the reference ledger delivers a background drag, and this one has not been
  measured either way.
- **The macOS 14 path** (`keyWindowRecord` disabled, web targets falling to the
  visible foreground rung) — implemented from the crash report and the byte
  pattern, **not** exercised on a 14.x machine.
- **Multi-display reconfiguration** — wired (`Geometry`'s snapshot refreshes on
  `didChangeScreenParametersNotification`, and a region spanning two displays
  takes the `screencapture` path), **not** exercised on a second display.

Release builds ship the helper as a signed nested app bundle; source development
retains the build-and-cache fallback. It never runs on the Linux CI host, where
the backend reports `backend-unavailable` from its passive probe.
