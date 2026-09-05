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
3 s. Callers that lose the single-flight race **wait on the request already in
flight**, against that request's own deadline rather than a fresh one. They used
to be handed the (often nil) warm copy immediately and fall to the CLI, and since
the perception lane is concurrent and the pane opens with a burst of captures, a
cold helper served one image through ScreenCaptureKit and every other one through
`screencapture`. A call that never returns still costs nothing extra: the
in-flight flag is cleared only by the completion handler, waiters past the shared
deadline fall through to the warm copy at once, and no second request is ever
started behind it.

`/usr/sbin/screencapture` is the fallback: same Screen Recording grant, no hang,
and it composites across displays, which is why a region spanning two of them
takes that path. It is also the whole path below macOS 14. Each result says which
link served it (`source`), so the backend can track the fallback rate.

For `kind: "window"` the fallback takes its **origin from `SCWindow.frame`**, not
from `CGWindowList`. `screencapture -l` composites the window's whole surface,
which is not the rect the window list reports — measured against a Terminal
window the image began 32 pt above the enumerated origin, so every coordinate an
agent read off it mapped 32 pt low on the desktop. `SCShareableContent` is
macOS 12.3, so that measurement is available on every OS this helper supports,
including the ones with no `SCScreenshotManager`; when the window cannot be found
there the capture is **refused** (`-32001`) rather than described with a rect its
pixels do not cover. The extent is then checked against that surface as well: a
disagreement is unknowable rather than correctable — nothing says whether the
extra pixels are above or below — so it is refused (`-32603`) instead of
described. Measured on one machine (macOS 27, 6 windows across AppKit, Chromium
and Finder) `SCWindow.frame`, `CGWindowList` bounds and the CLI's own extent all
agree exactly, so the audit's 32 pt case did not reproduce there; the guard is
what makes it a refusal rather than a silent misreport wherever it does.

**Synara's own windows are cut out of every display capture.** The whole-desktop
still that feeds the Computer pane is a region capture, so with nothing excluded
the pane photographed itself: an infinite mirror, and — because the pane redraws
on every frame — a guarantee that no two stills were ever byte-identical, which
defeated the Node side's dedupe and cost an SCK capture, a PNG encode and a ~1 MB
JSON line twice a second for as long as the pane was open. The filter excludes
exactly the pids `Windows.enumerate` excludes as the host (`Windows.isHostOwned`:
the parent chain plus the bundle-id match), so what the agent is shown and what
the agent may act on stay the same set. The helper's **own** overlay is
deliberately not excluded — the agent cursor is the one thing the still exists to
show, and its window is `.readOnly` precisely so it composites into captures.

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
click point _before_ posting, for the application's focused element at that same
moment, and for its focused element afterwards. It draws a conclusion only when
it is entitled to one: the element must be settable-focusable and must not
already hold focus, or the answer is `unverifiable`. An expired budget is
`unverifiable` too, never an escalation: a wrong "delivered" costs nothing, a
wrong "undelivered" costs a permanent flicker.

The three-way split is what keeps the escalation honest, because `unconfirmed`
is not merely a report — `click` **replays the whole gesture** on the visible
rung when it sees one, and a replay is a second real click on the user's
desktop. Focus that has moved to the element the click was aimed at is
`confirmed`; focus that has not moved **at all** from where it was before the
gesture is `unconfirmed`; focus that has moved somewhere neither predicted nor
previous is `unverifiable`, because the click plainly arrived and merely landed
focus somewhere the hit test did not foresee. Only the middle case may cost a
duplicate click, and only it puts the application's **bundle id** into
`foregroundOnlyBundles`, after which every gesture and keystroke into that app
skips straight to the visible rung. The set is keyed on bundle id so the verdict
survives a relaunch and two windows of one app share one answer, it is touched
only from the serial input lane, and it is empty for every application measured
so far — Chromium and Electron included, since the key-window record landed.

`press-key`/`hotkey` answer the same three states from the focused element's
_signature_, sampled on both sides of the chord and **inside** whatever focus
arrangement the rung made. A change is `confirmed`, no change is `unverifiable`
(a chord that copies, or opens a menu, legitimately moves nothing), and an
unreadable target is `unverifiable` as well. Bracketing only the keystrokes is
the point: sampling `before` outside the focus scope put the foreground rung's
own activation between the two samples, and activating an application moves its
focused element, so every chord on the visible rung reported `confirmed` whether
or not the keys did anything.

**The focus debt is paid exactly once.** `Focus.begin` records what the gesture
is about to take (`PendingFocusRestore.recordPair` for the invisible rung,
`.activation` for the visible one) _before_ it takes it, so a SIGTERM arriving
mid-gesture still finds the debt. `Focus.end()` on the input lane and `unwind()`
from the signal source both pay it, and both claim it through the same
`takePendingFocusRestore()`, which reads and clears under one lock — the two used
to be separate steps, and a SIGTERM landing between them had both post the
inverse pair, deactivating the human's application a second time on the way out.
The restore also survives the target: `SkyLight.restoreActivation` used to
require the target's process serial to resolve before posting anything, so an app
the gesture had quit took the human's focus with it — the human's application
left holding an unmatched deactivate, with no caret and no key routing. There is
nothing to deactivate in that case, so only the activate half is posted.

**Held modifiers are recorded on whichever stream took the press.** `postChord`
has always done this; the session-tap typing path and the pointer gestures'
`modifiers` now do too — three writers, one pair of helpers
(`recordHeldModifiers`/`clearHeldModifiers`), so `unwind()` has exactly one
thing to read on the way out. The typing path presses
left-Shift for every capital and shifted symbol, and that press used to be
invisible to the unwind bookkeeping — a throw part way through a string, or a
SIGTERM mid-`type`, ran `unwind()` with nothing to release and left the human
with a latched Shift on the session tap, which is the one stream a pid-targeted
release cannot clear. `withSessionTapShift` records it while it is down and
releases it on every exit from the character, ordinary or not.

**The overlay hides itself when the agent is idle.** A helper is alive for as
long as the backend wants one, which on a Mac with the Computer pane open is the
whole session, and an overlay that is never ordered out is a permanent second
arrow pointing at wherever the agent last clicked hours ago. It starts hidden,
`retarget` wakes it (so the first action brings it back at the human's own
pointer and glides away from it), and it is ordered out `AgentCursor.idleHideDelay`
— 3 s — after the last **action** completes. Per action, not per request: the
pane polls perception twice a second, and arming the hide off any request would
hold the arrow on screen forever. `repin()` will not resurrect a hidden overlay;
only motion does. `shutdown()` orders it out too, best effort — that hop is
synchronous for a signal, and from the stdin reader the `exit` that follows takes
the window down anyway.

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
| `list-windows`        | –                                                                                    | `{windows: [...], workspace, focusedWindowId, titlesUnavailable?}`                |
| `screen-size`         | –                                                                                    | `{x, y, width, height, scale}`                                                    |
| `describe-ui`         | `maxDepth?` (40), `windowIds?`                                                       | `{root}` — desktop AX forest, agent-addressable                                   |
| `capture`             | `kind` (`window`\|`region`), `windowId`\|`region`, `maxDimension?` (2048), `source?` | `{base64, region, source}`                                                        |
| `launch-app`          | `app`, `arguments?`                                                                  | `{resolvedCommand}`                                                               |
| `move`                | `x`, `y`, `windowId?`                                                                | `{x, y}` (where the agent cursor moved; posts no event, and does not aim)         |
| `click`               | `x`, `y`, `windowId?`, `modifiers?`                                                  | `{x, y, path, verified}` (landing point)                                          |
| `double-click`        | `x`, `y`, `windowId?`, `modifiers?`                                                  | `{x, y, path, verified}`                                                          |
| `triple-click`        | `x`, `y`, `windowId?`, `modifiers?`                                                  | `{x, y, path, verified}`                                                          |
| `right-click`         | `x`, `y`, `windowId?`, `modifiers?`                                                  | `{x, y, path, verified}`                                                          |
| `drag`                | `fromX`, `fromY`, `toX`, `toY`, `durationMs?` (220), `windowId?`, `foreground?`      | `{ok, path, verified}`                                                            |
| `scroll`              | `deltaX`, `deltaY`, `x?`, `y?`, `windowId?`, `modifiers?`                            | `{ok, path, verified}`                                                            |
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
methods, and every entry of `describe-ui.windowIds`, also accepts a JSON number,
because a caller that has the id as a number should not have to stringify it to
be understood. That reading is strict: a non-integral number, a negative, one out
of `UInt32` range, or a JSON boolean (which arrives as an `NSNumber` and used to
resolve as window 1) is an `invalidParams` error. Never a silent fall back to
"whatever is topmost at this point" — that fallback quietly re-aimed a
window-scoped click at whatever was drawn over the coordinate — and never a
silently dropped filter term, which narrowed `describe-ui` to the ids that
happened to parse.

**Which methods aim the keyboard.** Only the gestures that actually post an event
(`click`, `double-click`, `triple-click`, `right-click`, `drag`, `scroll`) and the two explicit
aiming methods (`focus-window`, and `raise-window` once its raise is observed).
`move` deliberately does **not**: it moves the agent's overlay and nothing else.
It used to aim, so hovering over the human's editor and then calling `type`
without a `windowId` typed the agent's text into the human's editor — a
read-only-looking hover silently re-pointing the keyboard.

**The aim is re-resolved, not merely remembered.** `type`/`press-key`/`hotkey`
look the aimed window up again on every call and refuse with `targetMissing` when
it is gone, or when its id now belongs to another process. The cached struct used
to be trusted, so once the aimed window closed the keys went to a stale (or
recycled) pid, WindowServer dropped them silently, and the helper answered
`ok: true, verified: "unverifiable"` — telling the agent its keystrokes were
merely unobservable when there was nothing left to observe them in.

`focus-window` is **keyboard-only** and moves nothing on screen. It used to also
write `AXMain`, which a great many apps implement as `makeKeyAndOrderFront:` — a
raise — and `ComputerManager.prepareResolvedTarget` calls it before _every_
window-targeted action, so every scoped click reordered the human's windows.
Nothing in the helper writes `AXMain` any more; `raise-window` is the one method
allowed to move a window forward and it says so in its name.

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
- `click`/`double-click`/`triple-click`/`right-click`/`scroll` `modifiers` — an
  array of `ctrl` | `alt` | `shift` | `meta` (`meta` is Command) held down for
  the gesture. Deliberately narrower than the chord vocabulary: `press-key` and
  `hotkey` accept `cmd`, `option`, `fn` and friends, a gesture accepts exactly
  the four names the wire contract has (`ComputerInputModifier`), and any other
  name — `hyper`, and `cmd` too — is `invalidParams` before a single event is
  posted, because a Command-click silently demoted to a plain click is a
  different action on almost every surface. Duplicates are dropped rather than
  pressed twice. Omitted, `null` and `[]` are the same request the method took
  before the parameter existed, down to the bytes of the event stream.

  The mechanism is the one a hand uses, and both halves of it matter: each
  modifier goes down as a **real key transition posted to the target pid** —
  never the session tap, which is session-wide state a pid-targeted release
  could not clear — before the gesture's first event, its flag bits ride every
  mouse and wheel event of the gesture (the priming `mouseMoved`, the down and
  the up of every click, the wheel event), and the releases go out in reverse
  with the flags that remain. Each press is recorded in the same
  `heldModifiers` bookkeeping `postChord` writes, so a throw mid-gesture or a
  SIGTERM between the down and the up runs `unwind()` with something to release
  instead of leaving the human a latched Command key. An escalated replay
  presses them again inside the rung it runs on rather than holding them across
  the activation in between.

- `triple-click` — three clicks the target reads as **one** triple-click. Click
  state is pinned at 3 through the down _and_ the up of all three pairs instead
  of counting 1, 2, 3: a text view that reads the count off each pair would
  otherwise place a caret, then select a word, then select the line — three
  visible intermediate states for one gesture — and a toolkit that reads it off
  only the down, or only the up, would see three unrelated clicks. Everything
  else is `click`: the same input lane, the same clamping and echo, the same
  aim (it points the keyboard at the window it hit), the same `targetMissing`
  (-32001) and `invalidParams` (-32602) rules, and the same delivery verdict
  from the same `GestureProbe`.
- `drag.durationMs` is clamped to `[0, 30 000]` — the same ceiling the contract
  puts on it, restated here because the per-step sleep feeds `useconds_t` and
  Swift's conversion **traps**: a large duration aborted the process between the
  mouse-down and the mouse-up, leaving the human a latched button and a phantom
  drag and killing every other in-flight action with it.
- `type` result `path` — `ax-insert` | `keystrokes` | `foreground-keys` (the
  visible rung, reached by escalation) | `foreground` (the visible rung, asked
  for).
- `click`/`double-click`/`triple-click`/`right-click`/`scroll`/`drag` result
  `path` — the rung that ran, `background` or `foreground`.
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
- `list-windows` — `minimized` is the owning application's own
  `kAXMinimizedAttribute`, asked only about windows WindowServer is not
  compositing (an on-screen window is never minimized), one AX handle per owning
  pid, under a 0.75 s wall budget. It used to be `!visible`, which is a different
  question — a window on another Space is off screen and perfectly un-minimized —
  so on an ordinary multi-Space desktop most windows were reported minimized, and
  an agent told a window is minimized stops trying to use it. A window whose app
  cannot be asked (no Accessibility grant, no matching AX window, budget spent) is
  reported **not** minimized: a real minimized window described as ordinary costs
  one failed capture that says so, while the reverse is a window the agent never
  touches.
- `list-windows` — `titlesUnavailable: true` is present, and only present, when
  Screen Recording is not granted. `CGWindowListCopyWindowInfo` simply omits
  window names without it, and since an untitled off-screen window is
  unaddressable and therefore dropped, every minimized or off-Space window
  disappears from the list too. That is a degraded answer, not an empty desktop.
  When the list would be empty **and** the grant is missing, the call is a
  `-32000` instead, because an empty desktop is the one shape a caller cannot
  distinguish from a broken one.
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
  that intersects no display is `invalidParams`; a window that is not on screen
  is `targetMissing` — its composited pixels do not exist, so any region reported
  for them would be a rect the image never covered; and a window whose surface
  frame cannot be read from `SCShareableContent` is `targetMissing` on the
  `screencapture` fallback, because that path's origin comes from `SCWindow.frame`
  and there is nothing else honest to report.
- `describe-ui` marks a window node whose subtree hit the node cap with
  `"truncated": true`.

`raise-window` uses `AXRaise` on the matching AX window, which brings the window
forward inside its own application without activating that application. There is
deliberately no activation fallback: if the window is still not frontmost
afterwards it reports `notDelivered` (-32002) rather than pulling the human's
active application out from under them, and the caller decides whether the
target is genuinely occluded. "Frontmost" is asked of `Windows.frontmost()` — the
focused application's front window — not of the stacking order, which is the
heuristic that method exists to avoid: a floating panel of another application
sits above everything without being focused, so a raise that changed nothing
reported success whenever the target was such a panel, and a raise that worked
reported failure whenever one was in the way. The keyboard is aimed at the window
only once the raise has been **observed**; aiming first, before either check
could fail, left the keyboard pointed at a window this call then refused.
Keyboard actions (`type`, `press-key`, `hotkey`) need a window to have been aimed
at first — by a pointer gesture, `focus-window` or a successful `raise-window` —
and report `targetMissing` (-32001) otherwise, rather than typing into whatever
the human happens to be using.

An AX window is matched to a `CGWindow` by `_AXUIElementGetWindow` where the OS
will answer, then by an unambiguous title, then by frame overlap — and the
overlap must be **real**. That last search used to start from a sentinel below
zero, so the first candidate with a readable frame won even when it shared no
pixel with the window being matched: an app whose AX window list and
`CGWindowList` disagree had one AX window answer for two `CGWindow`s,
`describe-ui` emitted the same tree twice under two ids, and a `set-value` at the
phantom id wrote into the other window (reproduced live). No overlap is now no
answer.

The AX walk is bounded on every axis so one unresponsive app cannot stall
perception: a 1 s messaging timeout per application and 0.35 s per window, one
batched IPC per node instead of seven, 2048 nodes per window and ~6000 per
desktop, windows WindowServer is not compositing skipped, and subtrees whose frame lies
entirely outside their window skipped (zero-size layout containers are still
descended). Skipped children keep their sibling index, so `nodePath` stays the
real child-index route that `set-value`/`perform-action` re-resolve against.

### Errors

Standard JSON-RPC codes, plus `-32000` (permission denied — a TCC grant is
missing), `-32001` (target window/node missing), and `-32002` (input accepted
but not delivered). What actually reaches each one:

- **`-32602` invalidParams** — a `windowId` that is present but not an exact,
  in-range, non-negative `CGWindowID` (never a silent fall back to "whatever is
  topmost at this point"); a `describe-ui.windowIds` entry that is not one
  (never a silently narrowed filter); a `capture` `kind` that is neither `window`
  nor `region`; a region that is non-finite or intersects no display
  (`Geometry.clampRectToWorkspace`); a `deliveryMode` other than
  `background`/`foreground`; a `hotkey` with zero or more than one non-modifier
  key; an unknown key name; an unknown modifier name — `["hyper", "cmd", "a"]` is
  a bad request, not a smaller chord that quietly runs, and it is reported as
  "`hyper` is not a key or a modifier this helper knows" rather than as "got 2
  non-modifier keys", which is what the split on `isModifier` used to make it
  look like; and a pointer `modifiers` entry that is not one of the four names
  a gesture takes (including a chord alias such as `cmd`, and including any
  entry that is not a string at all — dropping those would be the same silent
  narrowing the window-id readers were fixed for), refused before any event is
  built.
- **`-32001` targetMissing** — a named window that no longer exists (for
  `capture`, `focus-window`, `raise-window`, `set-value`, `perform-action`,
  `move`, and every pointer gesture that named one); a window capture whose
  window is not on screen, is on no display, or cannot be measured through
  `SCShareableContent` for the CLI fallback, because any region reported for it
  would be a rect the image never covered; a keyboard action (`type`,
  `press-key`, `hotkey`) with no window aimed at yet, **or whose aimed window has
  since closed**; an event with no resolvable destination, since there is no
  frontmost fallback on any path; and `launch-app` when `open` reports no such
  application.
- **`-32002` notDelivered** — `raise-window` when `AXRaise` left the window
  short of frontmost, and the foreground keyboard rung when the target was not
  _observed_ to become frontmost within 400 ms (`withForeground`), because a
  session-tap key goes wherever focus actually is.
- **`-32000` permissionDenied** — any synthetic input without the Accessibility
  grant (`requireInputPermission`, checked up front because `CGEventPostToPid`
  returns void and WindowServer drops the event silently for an untrusted
  client); a `describe-ui` without it; a capture that failed with Screen
  Recording actually missing; and a `list-windows` that came back **empty**
  without Screen Recording, since an empty desktop is the one shape a caller
  cannot distinguish from a broken one. A `list-windows` that is merely degraded
  answers with `titlesUnavailable: true` instead.
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

`triple-click` and the pointer `modifiers` parameter (2026-09-05) are a third
band, narrower again. Exercised live on an **ungranted** helper: `triple-click`
is routed on the input lane (it answers the `-32000` permission refusal, not
`unknown method`, while a genuinely unknown method still answers `-32601`), an
unreadable `modifiers` entry answers `-32602` _before_ the permission check the
gesture would otherwise hit, an empty or absent list reaches that check
unchanged, and perception is unaffected — with the human's frontmost application
and real cursor position sampled unchanged on both sides. The event stream
itself — the modifier key transitions, the flag bits on the mouse events, the
pinned click state — is **compiled and reasoned, not measured**, for the same
reason everything else on the input path is: it lives behind
`requireInputPermission`, and the grants belong to Synara.

The 2026-09-04 audit fixes are a second, narrower band of verification, and the
distinction matters. Exercised live on an **ungranted** helper (run from a shell,
so the responsible process holds neither grant): the strict window-id readers,
the `titlesUnavailable` flag, the CLI window fallback's refusal, and a concurrent
cold-cache capture burst answering without deadlock while `ping` stayed responsive
— with the human's frontmost application and real cursor position sampled
unchanged on both sides. Everything on the input path (`focus-window` no longer
raising, the keyboard-aim revalidation, `move` no longer aiming, the session-tap
Shift bookkeeping, the chord verdict, the replay gate, the overlay's idle hide,
the drag clamp) is **compiled and reasoned, not measured**: every one of those
paths is behind `requireInputPermission`, and the grants belong to Synara, so
they can only be exercised by a helper the app itself spawned.

Release builds ship the helper as a signed nested app bundle; source development
retains the build-and-cache fallback. It never runs on the Linux CI host, where
the backend reports `backend-unavailable` from its passive probe.
