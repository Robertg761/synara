# macOS computer use — reference and design

Status: **Being implemented.** This began as reverse-engineering research for the Linux design (`docs/computer-use-design.md`) and is now the design for Synara's macOS backend, which lands alongside the Linux tiers on the way to `main`. The mechanism below is what the backend and native helper implement:

- `apps/server/src/computer/MacComputerBackend.ts` — the `ComputerBackend` implementation (coordinate translation, health supervision, still-frame publishing, lazy build-and-spawn of the helper).
- `apps/server/native/computer-use-macos/` — the native Swift helper (JSON-RPC over stdio; window enumeration, capture, AX, the confirmed input path, and the Software Cursor overlay). See its `HEADER.md` for the wire protocol.
- `apps/server/src/computer/macComputerHelperClient.ts` / `macComputerHelperProvisioning.ts` — the transport and the build-on-demand cache, keyed by Xcode build version plus a source digest exactly like the iOS device helper.

**What has and has not been verified on device.** One machine: macOS 27.0, arm64, single display, Accessibility and Screen Recording granted. Verified live there: background click, type and scroll into a Chromium window (Helium) while another application was frontmost — the click lands, the page takes focus, pid-routed Unicode inserts text, the human's previous application is restored, and the real pointer never moves; `press-key` and `hotkey`; capture and window enumeration (full-workspace still at `maxDimension` 2048 in ~55 ms, a `ping` answered in <1 ms while one was in flight); and the cursor overlay's motion, measured frame by frame (`SYNARA_CURSOR_TRACE=1`). **Not** verified: background drag into a Chromium target (implemented, best-effort, never measured); the macOS 14 path, where the key-window record is disabled and web targets fall to the visible foreground rung (implemented from the crash signature, never run on a 14.x machine); and multi-display reconfiguration (wired — `Geometry` refreshes its screen snapshot on `didChangeScreenParametersNotification`, and a region spanning two displays takes the `screencapture` path — but never exercised on a second display). The backend reports `backend-unavailable` from its passive probe on any non-macOS host, so nothing about this changes Linux behavior.

Branch: `computer-use-linux` → macOS backend on `claude/computer-use-macos-s1vpp0`
Author: investigation synthesis, 2026-08-15
Scope: how Codex-style macOS "computer use" works and how it would map onto Synara on a Mac — an agent that sees, clicks, and types on the user's real desktop with its own visible cursor, in the background, without disrupting the human's mouse, keyboard, focus, or Space.

---

## 1. Goal and non-negotiables

The user's requirement, verbatim intent:

> Work just like the macOS Codex computer use. A separate cursor, independent of mine, that can go do stuff on my computer while I keep using my computer — without disrupting each other. And I need to be able to see the cursor.

This decomposes into four hard requirements:

1. **Independent input.** The agent drives target apps without moving the real system pointer, stealing the frontmost window, or changing the active Space.
2. **A visible agent cursor.** A distinct on-screen pointer showing where the agent is acting, so the human can watch.
3. **Non-disruptive coexistence.** The human keeps using their machine at the same time; the two must not fight over the pointer, keyboard focus, or windows.
4. **Perception.** The agent can see target apps (screenshots) and read their structure (accessibility tree) to decide what to do.

These are the acceptance criteria. Everything below serves them.

### The single most important insight

**The "second cursor" is a picture, not a pointer.** macOS runs exactly one real cursor and the agent never touches it. Codex — confirmed by binary teardown — draws a borderless, click-through `NSWindow` named "Software Cursor" wherever the agent is about to act, and delivers input by **addressing the target process directly** (a synthetic event stamped with window-local coordinates, posted to the target PID) so the event never enters the HID stream that would warp the real pointer. This is the whole trick, and it is what makes requirements 1–3 simultaneously satisfiable. We replicate this model exactly.

---

## 2. How Codex actually does it (confirmed reference)

This is the behavior we are cloning. Findings are from binary disassembly of `SkyComputerUseService` / `SkyComputerUseClient` (evidence-labeled teardowns), OpenAI's own docs, and `trycua/cua`'s `cua-driver` (an independent open-source implementation of the identical technique, MIT-ish, which we can lift patterns from directly).

### 2.1 Architecture (confirmed)

- Codex ships computer use as a **bundled plugin** containing a nested helper app (`Codex Computer Use.app`) whose executable is `SkyComputerUseService`, with a CLI client `SkyComputerUseClient` run as `SkyComputerUseClient mcp`.
- The agent talks to it over **stdio MCP** (JSON-RPC). The internal transport to the native service is a length-prefixed (`uint32-LE` + UTF-8 JSON) unix socket, JSON-RPC 2.0, 8 MiB cap, protocol `CodexComputerUseIPC-2`.
- The helper is **launch-constrained**: it SIGKILLs itself unless its launching ancestor is `Codex.app`. This is deliberate — the grants belong to the app, not to the helper, and the constraint keeps the helper from running under an ancestor whose grants it would silently inherit. (Codex's own TCC database confirms the shape: one row, `com.openai.codex`, covering everything; the helper bundle has no row of its own.)
- **macOS 14.4 floor, Apple Silicon only.** The plugin is simply absent on x86_64.

### 2.2 The visible cursor (confirmed)

A borderless `NSWindow` drawn by the helper process itself (not injected into the target). Runtime-enumerated properties: owner `Codex Computer Use`, window name `Software Cursor`, `Layer: 0` (normal window level, **not** floating), 126×126 logical points, click-through. The visible arrow is _rendered at runtime_ (Core Animation `CAShapeLayer`), not a shipped PNG, and its color derives from the desktop wallpaper. Motion uses **20 candidate cubic-Bézier paths per move**, scored by a cost function (excess length, angle-change energy, max angle, total turn, in-bounds penalty) and animated with spring / Velocity-Verlet physics at `dt = 1/240` — this is the "playful path" and "wiggle while thinking" the reviews describe.

The `cua-driver` open-source analog gives us a directly copyable `NSWindow` configuration:

```
styleMask: NSWindowStyleMaskBorderless
backing: NSBackingStoreBuffered
isOpaque: false
backgroundColor: NSColor.clear
hasShadow: false
ignoresMouseEvents: true            // click-through — the human's real clicks pass through it
sharingType: NSWindowSharingReadOnly // so ScreenCaptureKit still records the agent cursor
level: 0 (NSNormalWindowLevel)       // + dynamic orderWindow:relativeTo: to sit above only the target
collectionBehavior: CanJoinAllSpaces | FullScreenAuxiliary | Stationary
orderFrontRegardless                 // show without activating the app
```

Non-obvious choices worth keeping: normal window level + dynamic z-ordering (so the cursor floats above only the target app, not everything); `NSWindowSharingReadOnly` (so the agent's own screenshots can include the cursor while an in-process capture wouldn't otherwise show it); rendered at 60fps into a `CALayer` at `NSScreen.backingScaleFactor`.

### 2.3 Non-disruptive input (confirmed mechanism, corrected from the popular myth)

**Correction of a widespread misattribution:** the internet (copying Cua's blog, which describes _Cua's own_ driver) claims Codex uses SkyLight `SLEventPostToPid`. The actual, assembly-confirmed, fixture-validated Codex path is:

1. Build an `NSEvent` (`+[NSEvent mouseEventWithType:location:...]`).
2. Convert to `CGEvent`.
3. Set integer fields: `3` = mouse button, `7` = subtype `3`, `91`/`92` = target window ID.
4. Set the global location, then call the **private `CGEventSetWindowLocation`** to stamp window-local coordinates.
5. **Post to the target PID.**

The validated crux: **keeping `CGEventSetWindowLocation` delivers `mouseDown`/`mouseUp` to a background window; removing it delivers nothing.** That one private call is what makes background, non-pointer-warping input work. Posting to a PID (rather than `CGEventPost` to the HID tap) is what prevents the real cursor from warping — WindowServer warps the pointer as a _side effect_ of HID-stream events, and PID-targeted posting skips that path.

**Focus without raising** is a subsystem Codex calls `SyntheticAppFocusEnforcer`. It maintains two parallel truths for the target — "the app _believes_ it is active / has key focus" vs. "the app _is_ actually frontmost" — so the target routes input as if focused while WindowServer never raises it or changes Space. The confirmed working mechanism (validated by the open-source `cua-driver`, whose macOS ledger passes this against a per-toolkit matrix, and what Synara's helper implements in `SkyLight.swift`) is yabai's `window_manager_focus_window_without_raise`: a **pair of 248-byte process-level event records posted with `SLPSPostEventRecordTo`** — a deactivate (`bytes[0x8A]=0x02`) to the process that is currently front, then an activate (`bytes[0x8A]=0x01`, target window id little-endian at `bytes[0x3C]`) to the target's PSN — deliberately _not_ calling `SLPSSetFrontProcessWithOptions`. (An earlier reading of the Codex binary guessed PID-targeted `NSEvent` types 13/21; the record-pair path is the one that actually flips AppKit-active state without a raise.) The target's PSN is resolved through `CGSMainConnectionID` → `SLSGetWindowOwner` → `SLSGetConnectionPSN`. After the gesture the inverse pair restores the human's previous app.

**Perception is AX-first.** `get_app_state` (internally a "skyshot") returns a screenshot **plus** the accessibility tree. Semantic actions (`set_value`, `perform_secondary_action`) are pure AX calls. But `click` is deliberately **real synthetic input, not `AXPress`** — the binary literally contains the string _"Prefer simulating physical clicks over Accessibility actions."_ AX is used to _find_ and _describe_ targets and for a few semantic writes; clicking/typing/scrolling/dragging go through synthetic events.

### 2.4 Permissions (confirmed)

Three TCC services in practice: **Accessibility** (`kTCCServiceAccessibility`) and **Screen Recording** (`kTCCServiceScreenCapture`) are documented; **Input Monitoring** (`kTCCServiceListenEvent`) is granted but undocumented by OpenAI. Per-app approval with an "Always allow" list persisted to disk. "Locked use" (operating after the Mac locks) is a separate, much deeper mechanism using a privileged `SecurityAgentPlugins` bundle — **out of scope for us initially.**

### 2.5 Confirmed non-mechanisms (ruled out, so we don't chase them)

No virtual display, no VM, no separate Space, no separate login session, no headless WindowServer. Codex drives the user's **real** desktop. "Locked use" is a real brief unlock of the real session with displays covered, not headless operation.

---

## 3. How this maps onto Synara

Synara already contains a near-exact architectural template for this feature: the **iOS device (`device_*`) tool family**. The new macOS computer-use family follows the same shape end to end. This is the central reuse argument — we are not inventing a new subsystem pattern, we are instantiating an existing one for a new backend.

### 3.1 The device family as the template

| Concern                       | Existing iOS device family                                                                                                                                          | New macOS computer-use family                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| MCP tools                     | `deviceTools.ts` (`makeAgentGatewayDeviceTools`)                                                                                                                    | `computerTools.ts` (`makeAgentGatewayComputerTools`)                         |
| Tool registry gating          | `AgentGateway.ts:732` — `...(deviceService?.supported === true ? makeAgentGatewayDeviceTools(...) : [])`                                                            | identical pattern, gated on `computerService?.supported === true`            |
| State machine                 | `DeviceManager.ts` + `DeviceBackend.ts`                                                                                                                             | `ComputerManager.ts` + `ComputerBackend.ts`                                  |
| Fake backend (Linux-testable) | `FakeDeviceBackend.ts`                                                                                                                                              | `FakeComputerBackend.ts`                                                     |
| Native helper client          | `helperClient.ts` (JSON-RPC over stdio)                                                                                                                             | reuse a shared stdio JSON-RPC transport (see §6)                             |
| Real backend                  | `IosSimulatorBackend.ts`                                                                                                                                            | `MacComputerBackend.ts`                                                      |
| Snapshot/act targeting        | `uiTreeTargeting.ts` (activationPoint over frame-centre; candidate labels in error)                                                                                 | `axTreeTargeting.ts` (same idioms, AX elements)                              |
| Frame transport               | `deviceFrameTransport.ts` + `deviceFrameRoute.ts` (`/ws/device-frames`)                                                                                             | generalize into a shared `FrameTransport` (see §6)                           |
| Approval gating               | `PROVIDERS_WITHOUT_APPROVAL_GATE`, `DEVICE_APPROVAL_REQUIRED_TOOLS`, `approvalUnavailableResult()`                                                                  | `COMPUTER_APPROVAL_REQUIRED_TOOLS` (much broader — see §7)                   |
| Native helper (Swift/ObjC)    | `apps/server/native/device-helper/Sources/` (`AXBridge.m`, `HIDBridge.m`, `FrameStream.swift`, `Screenshot.swift`, `CapabilityProbe.swift`, `SymbolManifest.swift`) | `apps/server/native/computer-helper/` (or a desktop-owned helper — see §4.2) |
| Desktop capture precedent     | `apps/desktop/native/appsnap/` (`WindowCapture.swift`, `Permissions.swift`)                                                                                         | direct precedent for ScreenCaptureKit + permission state machines            |
| Web pane                      | `DevicePanel.tsx`, `useDeviceSupport.ts`, `deviceStateStore.ts`, `useDeviceEventBridge.ts`                                                                          | `ComputerPanel.tsx` and siblings                                             |

Two native Swift helpers already exist in-tree (`device-helper` and `appsnap`), which means the toolchain, signing, `asarUnpack`, and permission-state-machine patterns are already solved here — we are extending proven ground, not starting cold.

**Names as built.** The right-hand column above is the proposal; a few landed under different names, and the code is the answer. The AX-element targeter is `macUiTree.ts` (with `atspiTreeTargeting.ts` as the Linux sibling), not `axTreeTargeting.ts`; the frame route is `computerFrameRoute.ts` over `FrameTransport` from `packages/shared`; the still-frame loop is `stillFramePublisher.ts`, shared with the KWin backend; and the helper transport is `macComputerHelperClient.ts` built on `@synara/shared/jsonrpc-stdio` — one of five consumers of that extraction (with `codexAppServerManager.ts`, `codexAppServerTransport.ts`, `device/helperClient.ts` and `atspiClient.ts`), as §6 item 1 intended, not a third copy.

### 3.2 Capability model

`AgentGatewayCapability` (`apps/server/src/agentGateway/Services/AgentGatewaySessionRegistry.ts:4`) currently spans:

```
"thread:read" | "thread:write" | "automation:write" | "diagnostics:read" | "browser:control" | "device:control"
```

Add `"computer:control"`. **Superseded (2026-09-01):** this section originally argued the capability must not join the blanket default in `PROVIDER_SESSION_CAPABILITIES`, and be opt-in per provider and per user setting. It is now granted to every provider session like the rest, because computer use is not a mode a chat is switched into — see "Computer use is not a switch" in `docs/computer-use-design.md`. What makes driving the real desktop safe is unchanged: nearly every tool in the family is approval-required (see §7), and a provider session with no approval gate has them refused.

### 3.3 Why MCP-over-stdio is exactly right here

Codex's own delivery is an MCP server over stdio, and Synara already:

- runs Codex app-server as JSON-RPC over stdio (`apps/server/src/codexAppServerManager.ts`),
- injects MCP tools into provider sessions (`mcpInjection.ts`, `mcpTransport.ts`),
- exposes browser and device tool families through the agent gateway.

So no new protocol is required. The agent-facing surface is a set of MCP tools; the backend is a native helper. This is the same seam Codex uses, and the same seam Synara's device family uses.

---

## 4. Proposed architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Synara.app (Electron desktop, owns the TCC grants)                    │
│                                                                       │
│   Electron main process ── spawns ──► computer-helper (native .app)   │
│      │  (responsible process for TCC)      │                          │
│      │                                     ├─ AppKit main thread:      │
│      │                                     │    "Software Cursor"       │
│      │                                     │    overlay NSWindow(s)     │
│      │                                     ├─ ScreenCaptureKit:         │
│      │                                     │    per-window capture      │
│      │                                     ├─ AXUIElement:              │
│      │                                     │    tree read + semantics   │
│      │                                     ├─ CGEvent→PID + window-loc: │
│      │                                     │    non-disruptive input    │
│      │                                     └─ SyntheticAppFocusEnforcer │
│      │                                          focus-without-raise     │
│      │                                                                  │
│      └─ one plane: newline-delimited JSON-RPC over stdio                │
│           (stills ride back base64 inside the `capture` result)         │
│                                                                       │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ WebSocket (existing Synara transport)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│ apps/server (Node)                                                     │
│   ComputerManager (state machine) ──► MacComputerBackend               │
│                                   └──► FakeComputerBackend (Linux/CI)   │
│   computerTools.ts ──► registered in AgentGateway when supported        │
│   ComputerFrameTransport ──► /ws/computer-frames                        │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ WebSocket push (orchestration.domainEvent)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│ apps/web (React)                                                       │
│   ComputerPanel — canvas pane showing the target + agent cursor        │
│   permission/onboarding UX, per-app approval list                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.1 Native helper responsibilities

A single long-lived, signed native helper that:

- **Perceives:** ScreenCaptureKit per-window capture (`SCContentFilter` scoped to one window), AX tree reads (`AXUIElementCopyMultipleAttributeValues` batched, per-element messaging timeout, `AXManualAccessibility` poke for Chromium/Electron targets).
- **Acts:** the confirmed Codex input path — `NSEvent`→`CGEvent`, fields 3/7/91/92, `CGEventSetWindowLocation`, post to target PID; focus-without-raise focus packets; AX semantic writes where appropriate.
- **Shows:** draws the "Software Cursor" overlay — **one** window, not one per agent. `Cursor.swift` installs a single 126×126 pt borderless, click-through, `sharingType = .readOnly` `NSWindow` whose arrow is rendered at runtime into `CAShapeLayer`s (a wider white stroke _beneath_ the accent fill, carrying the drop shadow, so the silhouette keeps its full width over any wallpaper). The colour is a fixed accent — `NSColor.controlAccentColor`, falling back to `systemBlue` when the user's accent is desaturated below 0.25, e.g. graphite — not derived from the wallpaper. Identity is carried by the name badge instead: `set-agent-cursor` sets it, and the server, not the agent, decides the name (`MacComputerBackend.setDrivingAgent`, replayed onto a fresh helper session after a reconnect).
- **Reports:** capability probe (OS version, arch, which TCC grants are present), structured errors.

**Language: Swift** is what shipped (ScreenCaptureKit's async API maps directly, no binding-crate lag when Apple ships new SCK features, and it matches the two existing in-tree Swift helpers). Note the build shape is not the one-command universal build this section originally assumed: `build.sh` invokes `xcrun swiftc` on the file list directly and targets **the host architecture only** (`$(uname -m)-apple-macosx12.3`). The universal arm64 + x86*64 helper is produced by `apps/desktop/scripts/build-computer-helper.mjs --arch universal`, which runs `build.sh` once per slice, `lipo`s them together, wraps the result in `Synara Computer Use.app` with its `Info.plist` (including the mandatory `NSScreenCaptureUsageDescription`), and ad-hoc signs it. The release identity is applied later, by electron-builder: the \_bundle* is named in `mac.binaries` (`scripts/lib/desktop-platform-build-config.ts`) because a bundle is the unit macOS signs and TCC identifies, and `assertPackagedMacComputerHelper` is what proves the signature landed. Rust + `objc2` is a documented-viable alternative if the team prefers Rust; the process boundary and protocol are identical either way. `cua-driver` (Rust) is the reference regardless of language choice — its `input/skylight.rs`, `cursor/overlay.rs`, `permissions/status.rs`, and `docs/action-support.md` (per-toolkit background-action capability matrix) save months of empirical discovery.

### 4.2 Out-of-process, spawned by Electron main — both are load-bearing

- **Out-of-process, not an in-process native addon.** `SCShareableContent` has a confirmed, still-unfixed macOS bug (radars FB12114396 / FB15779754) where it _hangs forever_. In-process, that is a permanently leaked thread inside Electron; out-of-process it is a `SIGKILL` + ~100 ms respawn. Combined with the general blast radius of driving the real desktop, the process boundary is mandatory. Kap/aperture is the verified Electron+Swift-helper precedent.
- **Spawned from inside the app bundle, never via `open`/launchd.** TCC attributes grants to the _responsible process_, which for a child process is the app that started it — so the Accessibility and Screen Recording checks the helper makes are answered against **Synara's** identity (`com.emanueledipietro.synara`), and Privacy & Security lists Synara, never the helper. Verified on this machine: run the helper straight from Terminal and it reports Terminal's grants, and the TCC database has rows for `com.emanueledipietro.synara` and none for `com.emanueledipietro.synara.computer-use-helper`. The same shape as Codex, which has one row for `com.openai.codex`. The helper is still a signed `.app` of its own inside `Synara.app` (`Contents/Helpers/Synara Computer Use.app`), same Team ID — that identity is what notarization and the hardened runtime need, not what TCC files the grant under.

  **What shipped, and why it differs from the sentence above.** The long-lived helper is spawned by the Node backend (`macComputerHelperClient.ts`), not by Electron main: the backend is itself a child of the signed app, so the responsible process is still Synara, and keeping the helper next to the code that drives it avoids proxying every RPC through IPC. Electron main spawns no helper at all — the desktop-side preflight it used to own is gone, because the prompt has to come from the process that actually needs the grant, at the moment it needs it. The live `request-permissions` RPC on the long-lived helper does that, and it is attributed to Synara for exactly the reason above.

### 4.3 Reliability rules baked in from day one (from cua-driver production code)

- Every ScreenCaptureKit call gets a **3 s deadline** (race against `Task.sleep`).
- A **single-flight gate** around `SCShareableContent` so one hang can't leak more threads; timed-out worker keeps the permit and later requests take the fallback.
- A **warm content cache** (TTL ~2 s) so the hot path skips `SCShareableContent`.
- **Fallback chain:** SCK → `screencapture -x -o -t png -l <windowID>` (or `-R` for a region) → error. Shipped as specified, and the fallback rate really is a health metric: every result carries `source`, and `MacComputerBackend.captureSourceCounts()` counts the answers per path for the life of the backend. The CLI fallback is also the whole path below macOS 14, and the path for a region spanning two displays, which one `SCContentFilter` cannot serve.
- **Supervision as built: no heartbeat and no watchdog.** Each request carries a **15 s timeout** (`REQUEST_TIMEOUT_MS` in `macComputerHelperClient.ts`); if the child exits, the client fails its pending requests, the backend drops it (`onExit` → `invalidateHelper`) and republishes health, and the **next** call spawns a fresh one — lazy respawn rather than a supervisory loop. What is asserted at every start is the wire contract: the helper announces `{"method":"ready","params":{"protocolVersion":1}}`, and a `capabilities.protocolVersion` that is not `SUPPORTED_HELPER_PROTOCOL_VERSION` fails the connect with an instruction to clear the cache, because a stale cached development binary would otherwise answer today's calls with yesterday's shapes.
- AX walk on a **dedicated serial lane** (`Lanes.accessibility`, never the capture lane), `AXUIElementSetMessagingTimeout` at 1 s per application and 0.35 s per window, one batched `AXUIElementCopyMultipleAttributeValues` per node instead of seven round trips, `AXUIElementIsAttributeSettable` only for roles that can plausibly hold a value, and hard node caps — 2048 per window, ~6000 per desktop — with an in-band `"truncated": true` on the window node. Subtrees whose frame lies entirely outside their window are skipped while zero-size layout containers are still descended, and skipped children keep their sibling index so `nodePath` stays a real child-index route. Two rules from the research were **not** adopted: there is no periodic `yield`, and no `AXObserver` at all — the helper polls on request rather than subscribing, so there is no private run loop to pump. `AXManualAccessibility` is poked on every application handle (Chromium/Electron expose no tree without it); `AXEnhancedUserInterface` is turned on only for the `describe-ui` walk and restored afterwards, because leaving it on makes some AppKit apps visibly jump on their next layout.

### 4.4 Input-path specifics carried from research

- **The real cursor is never touched** — no `CGWarpMouseCursorPosition`, no `CGSSetCursor`, and **no mouse event is ever posted to the session tap on any rung**. That is the one path that would warp the human's physical pointer, so it does not exist here; an action with no resolvable target window is refused (`targetMissing`) rather than posted globally. What does reach `.cgSessionEventTap` is **keys only**, and only on the visible foreground rung — which has no pointer component, so it cannot move the cursor either. That rung is not a consented "takeover mode": it is reached when the caller passes `deliveryMode: "foreground"` (no Synara caller does) or, in practice, by _learned escalation_ — an application caught once dropping a background gesture is remembered in `foregroundOnlyBundles` by bundle id and skips to the visible rung from then on. It refuses to post at all unless the target was **observed** to have become frontmost (`withForeground`'s settled read of WindowServer's front process, polled up to 400 ms — never the return value of the activation request), since a session-tap key goes wherever focus actually is. The set is empty for every application measured so far, Chromium and Electron included.
- **Disarm the API's hostile defaults** on the one `CGEventSource` we create: suppression interval 0, `PermitAllEvents` for both suppression states (otherwise every posted event freezes the human's real input for 0.25 s; a synthetic mouse-down freezes their mouse until the matching up).
- **Unwind handler on every path** (SIGTERM/SIGINT and a closed stdin all run `shutdown()` → `input.unwind()` → `exit`). It replays the helper's **own** bookkeeping rather than querying the system: neither `CGEventSourceKeyState` nor `CGAssociateMouseAndMouseCursorPosition` is called anywhere, because the helper never associated the pointer in the first place and the state it must undo is the state it created. `unwind()` posts the matching up for whatever button is logically held (rebuilt through the same `NSEvent` path, so it carries the window association a Chromium view requires), then releases held modifiers in reverse with the remaining flags **on the stream the press went down on** — `heldModifiersOnSessionTap` decides, because a modifier pressed on the session tap is session-wide state that a pid-targeted release would not clear. Then it pays the outstanding focus debt: `PendingFocusRestore` is recorded _before_ the gesture takes anything and claimed through one atomic `takePendingFocusRestore()`, so `Focus.end()` on the input lane and `unwind()` from the signal source cannot both post the inverse pair and deactivate the human's application twice on the way out. The classic failure this all exists for is the agent dying between a modifier-down and its up, latching the modifier so every subsequent human keystroke becomes a shortcut.
- **Text input:** `keyboardSetUnicodeString` in **20-UTF-16-unit chunks** (delivery truncates at ~20), never splitting a surrogate pair, the string set on both key-down and key-up, flags zeroed on every event — Chromium infers modifier state from the flags and would otherwise read an uppercase letter as Shift+letter with the Shift leaking onward. That path is layout-independent, so no AZERTY/Dvorak handling is needed for text. Three refinements from the research were **not** built and are not needed: there is no ZWSP prefix on whitespace-leading chunks, no `UCKeyTranslate` reverse map, and no pasteboard + Cmd+V fallback for emoji/CJK (the helper never touches the human's clipboard except through the explicit `read-clipboard`/`write-clipboard` methods). **Chords** and the session-tap typing path instead use four literal US-ANSI tables in `KeyMap` — `named` (return/tab/arrows/function keys), `ansi`, `whitespace`, and `shiftedAnsi` (`!@#$%^&*()_+{}|:"<>?~`, whose shift state cannot be derived from the character: `!` is already its own lowercase, and inferring "no shift" mapped every symbol on that row to keycode 0, so an email address arrived as `robertaexample`). Upper case is the one shift relationship derived rather than tabulated. A character no table can express is posted as keycode 0 carrying only the Unicode payload, which AppKit inserts and a keycode-driven toolkit simply ignores — borrowing another key's code would type _that_ key.
- **Click fidelity:** click-state on both down _and_ up of each click; delta fields on every move/drag; `NonCoalesced | 0x20000000` flags; ≥3 intermediate `mouseDragged` events at 8–16 ms spacing or drag-and-drop silently degrades to a click.
- **Secure Input** (password fields, Terminal "Secure Keyboard Entry") empirically does not block posting but blinds listeners. **Not implemented:** nothing polls `IsSecureEventInputEnabled()` and no holding pid is reported. It stays here as a known gap, not as a description of the helper.
- **Coordinate spaces:** AX position, CGWindow bounds, and CGEvent all share one space (top-left origin, points) — an AX-derived target feeds a synthetic click with **no conversion**; only AppKit needs the Y-flip, and pixels need per-display `backingScaleFactor` scaling. `NSScreen` is main-thread API, so `Geometry` reads the screens once on main into an immutable snapshot (workspace union, primary height, per-display frame and scale), refreshes it on `didChangeScreenParametersNotification`, and serves every lane from it. A point off every display is clamped onto the nearest edge (`clampToWorkspace`) and the clamped point is echoed back, which is what makes the backend's clamp reporting real; a _region_ is refused instead (`clampRectToWorkspace`), because a rect that misses every display has no honest saturated answer — and because `Int(1e30)` is a trapping conversion that would abort the helper from one tool call.

### 4.5 Mechanisms as built — where each one lives

Read this before guessing at a mechanism. Each row is a thing the helper actually does that the sections above either predate or describe only in outline; the file (and function) is the authority.

| Mechanism                   | Where                                                                                                | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three request lanes         | `Dispatch.swift` (`Lanes.queue(for:)`), `main.swift` (`handleLine`)                                  | **input** serial in arrival order (pointer, keyboard, clipboard, `launch-app`, `set-value`/`perform-action`, `focus-window`, `raise-window`, `set-agent-cursor`), **perception** concurrent (`capture`, `list-windows`, `screen-size`, `ping`, `capabilities`, and any unknown method), **accessibility** serial and alone (`describe-ui`). stdin parses on its own reader thread and hands off. Responses may therefore complete out of order; the JSON-RPC id correlates them and `writeMessage` serialises the writes. Bounded AX round trips (the typing read-back, the delivery watch, the focus nudge) deliberately run on the input lane, because each is part of the action it belongs to.                                                                                                                                                                                 |
| Focus without raise         | `SkyLight.activateWithoutRaise`                                                                      | A deactivate record to the front process, then an activate record to the target's process serial (yabai's `window_manager_focus_window_without_raise`), resolved through `CGSMainConnectionID` → `SLSGetWindowOwner` → `SLSGetConnectionPSN` with `GetProcessForPID` as the fallback. `SLPSSetFrontProcessWithOptions` is deliberately not used here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The make-key-window record  | `SkyLight.makeKeyWindow`                                                                             | The half that makes Chromium reachable. Active is not key: a Chromium window that is not its app's key window drops a pid-posted `mouseDown` outright (`acceptsFirstMouse`-style behaviour — measured, the page saw no `mousedown` at all). Same 248-byte envelope as the activate record, posted twice: `0xF8` at `0x04`, `0x10` at `0x3A`, the window id little-endian at `0x3C`, `0xFF` through `0x20..<0x30`, and `0x08` set to `0x01` then `0x02`. It moves key status without generating a content-level click and without touching z-order, Space, or the front application.                                                                                                                                                                                                                                                                                                |
| The 40 ms settle            | `SkyLight.postPair` (`focusRecordSettleMicroseconds`)                                                | One definition of the deactivate/activate pair, used by both the prelude and the restore, with 40 ms between the halves. Without it the activate overtakes the resign-active the deactivate started and the receiving app believes the wrong one won — and posting the restore's two back to back made the human's application the one that paid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The macOS 14 gate           | `SkyLight.keyWindowRecordIsSafe`                                                                     | On Sonoma `SLPSPostEventRecordTo` runs the record through `CGSEncodeEventRecord` → `NSKeyedArchiver`, which reads the `0xFF` fill at `0x20` as an Objective-C class pointer and aborts **the calling process**. So the record is skipped on major version 14, `capabilities.skylight.keyWindowRecord` reports `false`, the backend raises `health.backgroundInputDegraded`, and the settings panel says so in one sentence ("Typing into background windows brings them forward"). Web targets then reach the visible rung by the ordinary learned route.                                                                                                                                                                                                                                                                                                                          |
| Delivery watch              | `Input.DeliveryWatch` + `Accessibility.GestureProbe`                                                 | One `Application` handle per gesture at the 0.35 s per-window messaging timeout, under a 0.75 s wall budget. It arms only on an element that is settable-focusable and not already focused; afterwards, focus on that element is `confirmed`, focus elsewhere is `unconfirmed`, and anything else — no expectation, no readable focus, an expired budget — is `unverifiable`. An expiry is **never** an escalation: a wrong "delivered" costs nothing, a wrong "undelivered" costs a permanent flicker.                                                                                                                                                                                                                                                                                                                                                                            |
| Learned foreground-only set | `InputController.foregroundOnlyBundles`                                                              | Only an `unconfirmed` verdict writes to it, keyed by **bundle id** so the verdict survives a relaunch and two windows share one answer, touched only from the serial input lane. Empty for every application measured so far. Nothing about a toolkit is assumed in advance any more — the web-content exclusion that used to live in `routesBackgroundInput` is gone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Focus debt                  | `PendingFocusRestore`, `takePendingFocusRestore()`                                                   | Recorded before the gesture takes anything, claimed atomically, paid by exactly one of `Focus.end()` (input lane) or `unwind()` (signal source), so a SIGTERM mid-gesture restores the human's application exactly once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Window exclusions           | `Windows.enumerate()`                                                                                | Four categories dropped, not one: this pid (the overlay), every ancestor pid (`proc_pidinfo`, bounded at 16 hops), any app whose bundle id is `com.emanueledipietro.synara` or a child of it, and any other process running this same executable name (`proc_pidpath`). The middle two are what make "cannot drive Synara itself" an enforced limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Frontmost                   | `Windows.frontmost()` → `SkyLight.frontmostPID()`                                                    | `_SLPSGetFrontProcess` → `GetProcessPID`, falling back to `NSWorkspace.frontmostApplication`, then that pid's frontmost on-screen window — current immediately after a change the helper caused, which is what the focus prelude and the foreground rung settle against. Never the stacking-topmost window: a floating panel of another app sits above everything without being focused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Cursor motion               | `Cursor.swift`                                                                                       | A nonlinear spring, not a Bézier. Symplectic Euler at a fixed 1/240 s step, sub-stepped from real elapsed time and driven by `CADisplayLink` (torn down at rest, so an idle helper costs zero CPU). ω = 190·d^-0.42 rad/s clamped to [15, 95], damping ratio 0.90, restoring force faded in over 0.45/ω s; a retarget within 40 ms is treated as a _stream_ (a drag) and switches to ω = 160, ζ = 1.0; the aim point is pushed off the chord by 14 % of the distance (capped at 36 pt, ignored under 12 pt) and tapered to zero, so the path bows without a separate arrival case. `glide` blocks the input lane until the tip has arrived (within 1 pt and 30 pt/s), capped at 450 ms, so a click is never posted where the picture has not reached. Measured: 600 pt in 317–333 ms, 30 pt in 83–100 ms, 1909 pt corner-to-corner in 400 ms, 0.00 pt overshoot at every distance. |
| Capture chain               | `Capture.swift`                                                                                      | SCK (macOS 14+) with the caller's `maxDimension` as `SCStreamConfiguration.width/height` and the region as `sourceRect`, under a 3 s deadline; `SCShareableContent` cached 2 s and single-flighted, with the permit released by the completion handler so a hang (FB12114396) never leaks a second thread; `/usr/sbin/screencapture` under the same deadline as the fallback, and as the only path below macOS 14 or across two displays.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Tri-state delivery          | `packages/contracts/src/computer.ts` (`ComputerActionResult.delivery`), `computerTools.ts`           | `{path, verified}` reaches the agent with explicit guidance: only `unconfirmed` warrants a `computer_get_state`/`computer_screenshot` before continuing, `unverifiable` is the ordinary answer for most native controls and is not a failure, and no verdict justifies blindly retrying the same input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Occlusion short-circuit     | `ComputerManager.prepareResolvedTarget`, `ComputerBackend.deliversToNamedWindowRegardlessOfStacking` | The mac backend declares that input addressed at a named window reaches it whatever is stacked above, so the manager skips both the raise and the occlusion refusal and calls `focusWindow` alone. The raise was the step that pulled the human's frontmost application out from under them on every click.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Helper provisioning         | `macComputerHelperProvisioning.ts`, `computerHelperPaths.ts`                                         | Prebuilt signed bundle at `Contents/Helpers/Synara Computer Use.app` first (env `SYNARA_COMPUTER_HELPER_BINARY_PATH`), then a cached source build keyed on Xcode build version + source digest under `~/Library/Caches/synara/computer-helper`, then a fresh `build.sh` from staged sources (`SYNARA_COMPUTER_HELPER_SOURCE_DIR`) — refused outright when those sources resolve inside `app.asar`. The helper's bundle identifier is derived from `SYNARA_PRODUCTION_BUNDLE_ID`, because TCC files the grants under it and the helper's own "never drive Synara" guard matches on it.                                                                                                                                                                                                                                                                                              |

---

## 5. Agent-facing tool surface

Mirror Codex's confirmed `sky.*` / `mcp__computer_use.*` surface, adapted to Synara conventions and the device-family idioms (snapshot → act, activationPoint over frame-centre, candidate labels surfaced in error messages).

> **This section is the design target, not an inventory of what shipped.** The names below are the intended shape; the tools Synara actually registers are defined in `computerTools.ts`, and the helper methods behind them in `macComputerHelperClient.ts` (`MAC_HELPER_METHODS`). Where the two disagree, the code is the answer. What is actually registered, in full: `computer_list_windows`, `computer_get_state`, `computer_screenshot`, `computer_get_screen_size`, `computer_read_clipboard`, `computer_launch_app`, `computer_click`, `computer_double_click`, `computer_right_click`, `computer_move_cursor`, `computer_drag`, `computer_scroll`, `computer_type_text`, `computer_press_key`, `computer_hotkey`, `computer_write_clipboard`, `computer_set_value`, `computer_perform_action`. So: `computer_get_state` rather than `computer_get_window_state`, and no `computer_list_apps`, no `computer_invoke_menu`, and no agent-cursor tool of any kind. `COMPUTER_APPROVAL_REQUIRED_TOOLS` is every action tool plus `computer_read_clipboard` — the one read in the set on purpose, because the clipboard is the human's and may hold something they copied privately.

Perception / query (no approval, read-only, but still gated behind `computer:control`):

- `computer_list_apps` — running apps with windows.
- `computer_list_windows` — windows with geometry + owning pid.
- `computer_get_window_state { include_screenshot?, include_text? }` — the "skyshot": screenshot + AX tree as indexed markdown. Support three capture modes: `ax` (tree only — **no Screen Recording permission needed**), `vision` (image), `both` (default; enables element-indexed actions).
- `computer_get_screen_size`.

Action (approval-required — see §7):

- `computer_click` / `computer_double_click` / `computer_right_click` — real synthetic input, window-targeted.
- `computer_move_cursor` — moves the _agent_ cursor overlay (never the real pointer).
- `computer_drag`, `computer_scroll`.
- `computer_type_text`, `computer_press_key`, `computer_hotkey`.
- `computer_set_value` / `computer_perform_action` — AX semantic writes.
- `computer_invoke_menu` — menu items (special-cased away from physical clicks, per Codex's "Mouse action not supported for menu items").
- `computer_launch_app`.
- Cursor controls (`computer_set_agent_cursor { enabled, theme }`, `computer_get_agent_cursor_state`) were **not built, and are deliberately not agent-facing.** The overlay's name badge is set server-side by `MacComputerBackend.setDrivingAgent` from whichever thread holds the lease; the helper method behind it is `set-agent-cursor`. An agent that could rename or disable its own cursor could hide which thread is driving the desktop, which is the one thing the overlay exists to show.

**Design principle, adopted: refuse rather than guess.** Never silently fall back to global HID that could mutate the wrong window — a refused action is a better product than a wrong-window action that looks like it succeeded. The refusals as built are JSON-RPC errors, not the names this section originally proposed: **`-32001` targetMissing** (a named window that is gone, a window capture that is off screen, a keyboard action with no window aimed at yet, an event with no resolvable destination), **`-32002` notDelivered** (`raise-window` that could not reach frontmost without activating the app; the foreground keyboard rung when the target was not observed to become frontmost), **`-32602` invalidParams** (an unreadable `windowId`, an unknown key or modifier, a region that intersects no display), and **`-32000`** for a missing TCC grant. Above them, the manager has one refusal of its own — `computer_target_occluded` — and it no longer fires on macOS: the mac backend declares `deliversToNamedWindowRegardlessOfStacking`, so `prepareResolvedTarget` skips both the raise and the occlusion check and the code is now reachable only from the Linux tiers, which inject at a screen coordinate.

**Known limits to encode** (published + technique-inherent): cannot drive terminal apps or Synara itself; cannot authenticate as admin or approve security/privacy prompts; Chromium coerces synthetic right-clicks to left-clicks in web content and needs `AXManualAccessibility`; canvas/game engines need temporary foreground activation; minimized/off-Space windows are observe-only; **background scroll into Chromium/Electron targets now works** (measured, after the make-key record fix in `SkyLight.swift`), while background drag into those targets remains untested.

**Version floor as built:** the helper targets macOS 12.3, not the 14.4/Apple-Silicon-only floor Codex chose. `SCScreenshotManager` is 14.0+, so 12.3–13.x runs the `screencapture` fallback; the capability probe reports what the running OS actually allows rather than refusing at a version check. Note the two build paths differ in architecture: `build.sh` targets **the host architecture only** (`$(uname -m)-apple-macosx12.3`), and the universal arm64 + x86_64 helper exists only when `apps/desktop/scripts/build-computer-helper.mjs` is run with `--arch universal`, which builds each slice and `lipo`s them before signing. macOS 14 is also the one release where the key-window record is disabled outright (see §4.5), which is a background-input limit rather than a version floor.

---

## 6. Shared-module extractions (maintainability)

Per the repo's maintainability rule (extract shared logic; two divergent implementations is a code smell), this feature should _reduce_ duplication, not add it:

1. **Stdio JSON-RPC transport.** Synara already has two stdio JSON-RPC clients (Codex app-server in `codexAppServerManager.ts`, device helper in `helperClient.ts`). Extract the framing, request correlation, timeout, watchdog, and respawn logic into `packages/shared` (subpath export, e.g. `@synara/shared/jsonrpc-stdio`), and refactor both existing clients onto it. The computer helper becomes a third consumer, not a third copy.
2. **Frame transport.** Generalize `deviceFrameTransport.ts` / `deviceFrameRoute.ts` (`/ws/device-frames`) into a shared `FrameTransport<streamId>` so the computer pane's `/ws/computer-frames` reuses it. `packages/shared/src/deviceFrame.ts` already holds the frame-header logic to build on.
3. **UI-tree targeting.** `uiTreeTargeting.ts`'s snapshot/act idioms (activationPoint over frame-centre, candidate labels in errors) generalize to an AX-element targeter.
4. **Contracts.** New schemas go in `packages/contracts` (schema-only, no runtime logic): `ThreadComputerState`, `ComputerAvailability`, `ComputerEvent`, the frame header, and the `WsComputerRpcGroup` in `rpc.ts` — mirroring `device.ts` / the `WsDeviceRpcGroup`.
5. **Disclosure motion.** Any expand/collapse in `ComputerPanel` must reuse `apps/web/src/lib/disclosureMotion.ts` (per the UI convention), never bespoke transitions.
6. **Harness policy.** If the harness policy text changes to describe computer-use tools, bump `SYNARA_HARNESS_POLICY_VERSION` in `harnessPolicy.ts` (the test asserts on content).

---

## 7. Safety, approvals, and consent

Driving the user's real desktop is the most consequential capability Synara would have. The consent model must be stricter than browser/device:

- **Almost every action tool is approval-required.** Define `COMPUTER_APPROVAL_REQUIRED_TOOLS` covering all input/action tools; only read-only perception tools may run without per-call approval once the capability is granted.
- **Per-app "Always allow" list**, persisted (Codex's model): the agent requests permission before using a specific app; the user can grant standing permission per app. This keeps guardian/approval review tractable and is the consent UX users now expect.
- **Visible cursor is a UX aid, not a security indicator.** (cua-driver's own warning.) Authorization is enforced separately in the gateway; the cursor merely shows _where_, not _whether allowed_.
- **Human-takeover / yield.** Design a "user touched the machine" signal. Codex distinguishes synthetic-consequence input from genuine human intervention via `synthesizedActionWasPerformed()` (records uptime+pid; focus callbacks compare). At minimum, surface an ESC-to-cancel affordance and a clear indicator of which agent/thread is driving (Codex shipped _without_ per-agent labeling and immediately got a bug filed — we do it from day one, which also fits Synara's multi-provider/multi-thread nature).
- **Provider gating.** `computer:control` is leased by every provider session (2026-09-01); the near-total approval-required set is what gates it, and a provider whose session has no approval gate (`PROVIDERS_WITHOUT_APPROVAL_GATE`) has every mutating computer tool refused before it runs.
- **Out of scope initially:** "locked use" (operating after the Mac locks) — it requires a privileged `SecurityAgentPlugins` install, has a large blast radius, and even Codex's implementation is visibly buggy.

---

## 8. Permissions & onboarding

- **Two** TCC services as built, not three: **Screen Recording** (`capture` and the pane's still frames refuse without it) and **Accessibility** (`describe-ui`, `set-value`, `perform-action`, and every synthetic event — `requireInputPermission()` refuses up front, because `CGEventPostToPid` returns void and WindowServer drops the event silently for an untrusted client, so without the check the agent would believe every click landed). `Capability.report()` probes exactly those two. **Input Monitoring** is _not_ requested or checked anywhere in the computer-use helper — it belongs to `appsnap`, which installs an event tap; this helper installs none. None can be self-granted on a SIP-enabled Mac; both are user-driven clicks. Screen Recording additionally re-prompts ~monthly on Sequoia+ and can never be MDM pre-granted; Accessibility MDM pre-grant is deprecated in 26.2 / removed in 27.0 (DDM `AppSettings.Privacy` replaces it). Design so the flow tolerates a manual grant step and a relaunch.
- ~~**Preflight from the Electron main process**~~ — planned, not shipped. Electron's own grants describe Electron, not the helper that captures and posts events, so the answer could say ready while the helper had nothing. The helper answers for itself instead (below).
- The trust result is **cached per-process** and goes stale after the user flips the toggle — **relaunch the helper after a grant change** (what every shipping tool does) and/or probe live state with a throwaway listen-only `CGEventTap`. Implemented: a forced capability read (`provision()`) restarts the helper first whenever the previous probe saw a missing grant, so "grant it, then press Set up" observes the new grant instead of the dead process's cached refusal.
- `Info.plist`: `NSScreenCaptureUsageDescription` is mandatory — the system kills apps that trigger the Screen Recording prompt without it.
- The helper reports grant state from _inside_ itself, because it is the process that will actually call the APIs. Three entry points, all reporting the same facts: the one-shot **`--probe`** and **`--request-permissions`** commands (which never start the JSON-RPC server or the overlay, and are kept for debugging and the build), and the live **`request-permissions`** RPC, which is what the server calls the moment it detects a missing grant on an agent path. `MacComputerBackend` throttles that to one ask per grant per helper process, because the Accessibility dialog reappears on every request; pressing "Set up" (`computer.provision`) re-arms it. The live `capabilities` RPC reports the same facts to the backend, which believes a `-32000` refusal over the last probe in either direction. The answers describe **Synara's** grants, not the helper bundle's (see §4.2), so running the helper from a shell to debug reports that shell's grants instead.
- **Stale grants on unsigned builds.** For an ad-hoc signature TCC pins the grant to the binary's cdhash, so every local rebuild invalidates it while System Settings goes on showing Synara switched on — the helper reports `accessibility:false` next to a Privacy list that says the opposite, and macOS answers `request-permissions` from that dead row without ever showing a dialog. The server now repairs it rather than describing it: on an `adhoc` build `MacComputerBackend.requestMissingPermissions()` runs `tccutil reset <Service> com.emanueledipietro.synara` for each missing grant (`Accessibility`, `ScreenCapture` — the service names, not the labels; no `sudo` needed for the app's own bundle id, which is also why an unknown id is the only thing that errors, OSStatus -10814) immediately before it asks, and ignores a non-zero exit. On an ad-hoc build a missing grant is always either absent (no row, so the reset is a no-op) or pinned to a previous binary, so removing the app's own row is harmless and is the only way to make macOS prompt again. A Developer ID signature keys on identifier plus team and never hits this, so nothing on a signed build touches TCC: `Capability.report()` reports `"signature": "adhoc" | "signed"` (read with `SecCodeCopySelf` + `SecCodeCopySigningInformation`), it rides on `ComputerAvailability.permission-required.buildSignature` and on the setup-card activity payload, and `@synara/shared/computerPermissions` decides the wording from it — which now says "allow the dialog", with the Terminal command kept only as the fallback for when none appears.
- **A missing grant is never answered from a stale probe.** `MacComputerBackend.missingPermissions()` is async: the tool surface consults it after every computer call, and a cached "missing" kept the setup card and the model's refusal on screen after the user had already granted the permission (observed live — the same `computer_list_windows` that returned window titles, which need Screen Recording, still reported it missing). A probe that saw everything granted is still answered from memory for free; a probe that saw a gap is re-read through the ordinary `CAPABILITY_CACHE_TTL_MS` window, so a burst of calls costs one round trip and a grant that lands is seen on the next one.

---

## 9. Phased roadmap

**Phase 0 — spike (before committing).** ~30-min TCC inheritance experiment (§4.2): signed same-team helper spawned from Electron main inherits Screen Recording + Accessibility without a second prompt. If it fails, the fix is small (move capture into the Electron main via a thin shim, keep input/AX in the helper) but we want to know first. Also `otool -L` / `dyld_info` on our own prototype to confirm the private-symbol resolution path.

**Phase 1 — contracts + manager + fake backend (Linux-testable, no Mac needed).**

- Add `computer:control` capability (in the default provider-session set as of 2026-09-01).
- `packages/contracts`: `ThreadComputerState`, `ComputerAvailability`, `ComputerEvent`, frame header, `WsComputerRpcGroup`.
- `ComputerManager` state machine + `ComputerBackend` interface + `FakeComputerBackend` (deterministic, drives the full snapshot→act→event loop and the frame transport with synthetic frames).
- `computerTools.ts` with the full tool surface, registered in `AgentGateway` gated on `computerService?.supported`, with `COMPUTER_APPROVAL_REQUIRED_TOOLS`.
- Extract the shared stdio JSON-RPC transport and frame transport (§6); refactor existing consumers onto them.
- Full unit/integration coverage against the fake backend. All of `bun fmt` / `bun lint` / `bun typecheck` green; tests via `bun run test`.

**Phase 2 — native helper: perception.**

- Swift helper skeleton (capability probe, JSON-RPC serve, unbuffered stdout).
- ScreenCaptureKit per-window capture with the full reliability harness (§4.3); AX tree read with batching/timeouts/caps; `screencapture` fallback.
- `MacComputerBackend` wiring; the web `ComputerPanel` canvas pane showing live frames + AX overlay.
- Permission preflight + onboarding UX.

**Phase 3 — native helper: input + visible cursor.**

- The confirmed input path (`CGEventSetWindowLocation` + PID posting), focus-without-raise **and the key-window record**, disarmed suppression, unwind handlers, text and chord handling (no emoji-specific path: unmapped characters ride the Unicode payload).
- The "Software Cursor" overlay: one window, a fixed accent colour and a name badge — and a **nonlinear spring**, not the Bézier this plan assumed. The Bézier-scoring path is Codex's (§2.2); Synara integrates a mass-on-a-spring at a fixed 1/240 s step off a `CADisplayLink`, with the parameters and measurements in §4.5 and `Cursor.swift`.
- `refuse-rather-than-guess` routing; approval integration end to end.

**Phase 4 — hardening & coexistence.**

- Human-takeover/yield detection, ESC-to-cancel, multi-agent cursor identity, per-app "Always allow" list, PiP-style preview, click-sound option. Health metrics landed early rather than here: the capture fallback rate is counted per source by `MacComputerBackend.captureSourceCounts()`, and `health.backgroundInputDegraded` reports the missing input rung. There is no respawn count, because there is no supervisory respawn loop — see §4.3.

---

## 10. Open questions for review

1. **Helper language:** Swift (recommended) vs. Rust+`objc2`. Both viable; Swift matches existing in-tree helpers and SCK's API.
2. **Build vs. buy:** should Phase 2/3 evaluate depending on `@trycua/cua-driver` (MIT, Electron-ready, solves overlay + input + TCC responsibility chain) before writing bespoke native code? It is a near-exact match; risks are its fast cadence and heavy private-SPI use. A time-boxed spike could de-risk the whole native effort.
3. **Helper ownership:** does the helper live under `apps/server/native/` (like `device-helper`) or `apps/desktop/native/` (like `appsnap`)? Since it must be spawned by Electron main for TCC, `apps/desktop/native/` may be the better home despite the server owning the `ComputerManager`.
4. **Scope of Phase 1 tool surface:** ship the full surface against the fake backend, or a minimal click/type/screenshot core first?
5. ~~**Provider allowlist:** which providers may request `computer:control` at all?~~ Answered 2026-09-01: all of them. The approval gate on the mutating tools is the boundary, not the capability.

---

## Appendix — key source pointers

- Codex reverse-engineering (evidence-labeled): `egoist/waku` `docs/sky-macos-accessibility-reverse-engineering.md`; `iFurySt/open-codex-computer-use`; `vtomnet/codex-cua-tea`; `maka-agent` PiP teardown.
- Open-source analog to lift from: `trycua/cua` `libs/cua-driver/rust/crates/platform-macos/src/{input,cursor,permissions,tools}` and `docs/action-support.md`.
- Electron+Swift-helper precedent: `wulkano/aperture-node` + `wulkano/Aperture`.
- AX production patterns: `screenpipe` `crates/screenpipe-a11y`.
- In-tree templates: `apps/server/src/device/*`, `apps/server/native/device-helper/*`, `apps/desktop/native/appsnap/*`, `apps/server/src/agentGateway/deviceTools.ts`.
- Apple: Quartz Event Services (CGEvent), ScreenCaptureKit, AXUIElement, TCC/PPPC/DDM privacy payloads, CoreHID `HIDVirtualDevice` (long-term high-fidelity alternative).
