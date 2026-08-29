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

## Why a native helper, compiled on demand

The load-bearing input path uses `CGEventSetWindowLocation`, a private Quartz
symbol whose presence and behavior move between macOS releases, so — exactly
like the iOS device helper — the source ships in-repo and is compiled on the
user's own machine (`build.sh`), and the binary is cached keyed by the Xcode
build version plus a digest of these sources
(`apps/server/src/computer/macComputerHelperProvisioning.ts`). The private
symbol is resolved with `dlsym` at runtime, not linked, so a moved symbol
becomes a diagnosable capability gap rather than a dyld crash.

## Design choices

**Long-running JSON-RPC server, not subcommands.** Building the event source,
the overlay window, and the AX connections is per-process state. `--probe` is
the one exception: a one-shot capability report for the build and the settings
checklist.

**One channel, stdio only.** Unlike the device helper there is no frame socket.
Tier-1 capture is a whole-desktop PNG still that the Node backend publishes on a
timer, the same way the KWin backend serves the pane, so there is no video pipe
to starve the control channel.

**Every coordinate is global top-left screen points.** `CGWindowList`,
`AXUIElement`, and `CGEvent` already share that space, so an AX-derived target
feeds a synthetic click with no conversion. AppKit (`NSScreen`/`NSWindow`) is the
only bottom-left subsystem, and the flip lives in `Geometry.swift` alone.

**Input is posted to the target process, never the HID stream.** A synthetic
`CGEvent` is stamped with the target window id (fields 91/92) and window-local
coordinates (`CGEventSetWindowLocation`), then delivered with `CGEventPostToPid`.
WindowServer warps the real pointer only as a side effect of HID-stream events,
so pid-targeted posting keeps the human's cursor still. The visible agent cursor
is the overlay window, moved in lockstep.

## Protocol

Newline-delimited JSON-RPC 2.0 on stdio: one object per line, requests on stdin,
responses and notifications on stdout. Diagnostics go to stderr and never mix
into the protocol stream. On start the helper emits
`{"jsonrpc":"2.0","method":"ready","params":{"protocolVersion":1}}`.

### Methods

| Method            | Params                                                | Result                                             |
| ----------------- | ----------------------------------------------------- | -------------------------------------------------- |
| `ping`            | –                                                     | `{ok, pid}`                                        |
| `capabilities`    | –                                                     | `{arch, macosVersion, screenRecording, accessibility, protocolVersion}` |
| `list-windows`    | –                                                     | `{windows: [...], workspace, focusedWindowId}`     |
| `screen-size`     | –                                                     | `{x, y, width, height, scale}`                     |
| `describe-ui`     | `maxDepth?` (40)                                      | `{root}` — desktop AX forest, agent-addressable    |
| `capture`         | `kind` (`window`\|`region`), `windowId`\|`region`, `maxDimension?` (2048) | `{base64, region}`             |
| `launch-app`      | `app`, `arguments?`                                   | `{resolvedCommand}`                                |
| `move`            | `x`, `y`                                              | `{x, y}` (where the agent cursor moved)            |
| `click`           | `x`, `y`                                              | `{x, y}` (landing point)                           |
| `double-click`    | `x`, `y`                                              | `{x, y}`                                           |
| `right-click`     | `x`, `y`                                              | `{x, y}`                                           |
| `drag`            | `fromX`, `fromY`, `toX`, `toY`, `durationMs?` (220)   | `{ok}`                                             |
| `scroll`          | `deltaX`, `deltaY`, `x?`, `y?`                        | `{ok}`                                             |
| `type`            | `text`                                                | `{ok}`                                             |
| `press-key`       | `key`, `modifiers?`                                   | `{ok}`                                             |
| `hotkey`          | `keys` (modifiers + one key)                          | `{ok}`                                             |
| `set-value`       | `windowId`, `nodePath`, `value`                       | `{ok}`                                             |
| `perform-action`  | `windowId`, `nodePath`, `action`                      | `{ok}`                                             |
| `raise-window`    | `windowId`                                            | `{ok}`                                             |
| `read-clipboard`  | –                                                     | `{text}`                                           |
| `write-clipboard` | `text`                                                | `{ok}`                                             |
| `set-agent-cursor`| `name`                                                | `{ok}`                                             |

All coordinates are **global top-left screen points**. A pointer/scroll result
echoes where the action actually landed so the backend can report a clamp on a
multi-display gap.

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

The input path, AX walk, and Software Cursor overlay implement the confirmed
Codex technique but require on-device verification on a real Mac — the same way
the Linux tiers were live-verified on the reference machine before landing. This
helper is built and cached on demand and never runs on the Linux CI host, where
the backend reports `backend-unavailable` from its passive probe.
