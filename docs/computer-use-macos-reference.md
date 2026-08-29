# macOS computer use — reference and design

Status: **Being implemented.** This began as reverse-engineering research for the Linux design (`docs/computer-use-design.md`) and is now the design for Synara's macOS backend, which lands alongside the Linux tiers on the way to `main`. The mechanism below is what the backend and native helper implement:

- `apps/server/src/computer/MacComputerBackend.ts` — the `ComputerBackend` implementation (coordinate translation, health supervision, still-frame publishing, lazy build-and-spawn of the helper).
- `apps/server/native/computer-use-macos/` — the native Swift helper (JSON-RPC over stdio; window enumeration, capture, AX, the confirmed input path, and the Software Cursor overlay). See its `HEADER.md` for the wire protocol.
- `apps/server/src/computer/macComputerHelperClient.ts` / `macComputerHelperProvisioning.ts` — the transport and the build-on-demand cache, keyed by Xcode build version plus a source digest exactly like the iOS device helper.

The input path, AX walk, and overlay implement the confirmed technique but await on-device verification on a real Mac, the same way the Linux tiers were live-verified on the reference machine before landing; the backend reports `backend-unavailable` from its passive probe on any non-macOS host, so nothing about this changes Linux behavior.

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
- The helper is **launch-constrained**: it SIGKILLs itself unless its launching ancestor is `Codex.app`. This is deliberate — macOS attributes TCC grants (Screen Recording, Accessibility) to the _responsible bundle_, and the constraint keeps that attribution stable.
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

**Focus without raising** is a subsystem Codex calls `SyntheticAppFocusEnforcer`. It maintains two parallel truths for the target — "the app _believes_ it is active / has key focus" (synthetic state delivered to the target) vs. "the app _is_ actually frontmost" (real system state) — by posting synthetic focus packets to the target PID (`NSEvent` types 13/21 with specific subtypes) and guarding them with a private annotated-session event tap on private event-type `32`. Net effect: the target routes input as if focused, while WindowServer never actually raises it or changes Space. This is semantically yabai's "focus without raise," but implemented as PID-targeted focus packets, not the `SLPSPostEventRecordTo` call everyone assumed.

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

### 3.2 Capability model

`AgentGatewayCapability` (`apps/server/src/agentGateway/Services/AgentGatewaySessionRegistry.ts:4`) currently spans:

```
"thread:read" | "thread:write" | "automation:write" | "diagnostics:read" | "browser:control" | "device:control"
```

Add `"computer:control"`. **Critical difference from `browser:control` and `device:control`:** those are granted to essentially every provider session by default (`PROVIDER_SESSION_CAPABILITIES` in `Layers/AgentGatewaySessionRegistry.ts:12`). `computer:control` must **not** inherit that default. Driving the user's real desktop is far more consequential than driving a sandboxed browser or a simulator. The capability must be opt-in per provider (and likely per user setting), and nearly every tool in the family is approval-required (see §7).

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
│      ├─ control plane: newline-delimited JSON-RPC over stdio           │
│      └─ frame plane:   unix domain socket (screenshot bytes)           │
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
- **Shows:** draws the "Software Cursor" overlay window(s), one sprite per concurrent agent, each a distinct wallpaper-independent color + fading name badge.
- **Reports:** capability probe (OS version, arch, which TCC grants are present), structured errors.

**Language: Swift** is the recommended default (ScreenCaptureKit's async API maps directly, universal binary in one `swift build --arch arm64 --arch x86_64`, no binding-crate lag when Apple ships new SCK features, and it matches the two existing in-tree Swift helpers). Rust + `objc2` is a documented-viable alternative if the team prefers Rust; the process boundary and protocol are identical either way. `cua-driver` (Rust) is the reference regardless of language choice — its `input/skylight.rs`, `cursor/overlay.rs`, `permissions/status.rs`, and `docs/action-support.md` (per-toolkit background-action capability matrix) save months of empirical discovery.

### 4.2 Out-of-process, spawned by Electron main — both are load-bearing

- **Out-of-process, not an in-process native addon.** `SCShareableContent` has a confirmed, still-unfixed macOS bug (radars FB12114396 / FB15779754) where it _hangs forever_. In-process, that is a permanently leaked thread inside Electron; out-of-process it is a `SIGKILL` + ~100 ms respawn. Combined with the general blast radius of driving the real desktop, the process boundary is mandatory. Kap/aperture is the verified Electron+Swift-helper precedent.
- **Spawned by the Electron main process, not the Node server.** TCC attributes grants to the _responsible process_ — the app bundle. The helper must be a signed `.app` inside `Synara.app`, same Team ID, spawned by the app (never by the separate `node` server, never via `open`/launchd), so its Accessibility/Screen Recording/Input Monitoring grants are covered by the app's identity. Codex enforces this with a hard launch constraint; we should adopt the same posture. **This TCC inheritance is the one assumption to verify with a ~30-minute experiment before committing to the design** (spawn a signed same-team helper from the Electron main process and confirm it inherits the grants without a second prompt).

### 4.3 Reliability rules baked in from day one (from cua-driver production code)

- Every ScreenCaptureKit call gets a **3 s deadline** (race against `Task.sleep`).
- A **single-flight gate** around `SCShareableContent` so one hang can't leak more threads; timed-out worker keeps the permit and later requests take the fallback.
- A **warm content cache** (TTL ~2 s) so the hot path skips `SCShareableContent`.
- **Fallback chain:** SCK → `screencapture -x -o -l <windowID>` → error; report which path was used and track fallback rate as a health metric.
- **Watchdog** in the Node/Electron parent: missed heartbeats or 2× deadline → `SIGKILL` + respawn with backoff.
- AX walk on a **dedicated worker thread** (never the SCK queue), per-element `AXUIElementSetMessagingTimeout`, batched multi-attribute reads, `yield` every ~100 elements so AX IPC doesn't starve HID input, hard depth/node caps with an in-band truncation marker. `AXObserver` (if used) on its own thread with a **private, slice-pumped** run loop — never the main run loop.

### 4.4 Input-path specifics carried from research

- **The real cursor is never touched** — no `CGWarpMouseCursorPosition`, no `CGSSetCursor`, no HID-tap posting on the default path. HID-tap posting is reserved for an explicit, consented "takeover" mode for canvas/game apps that only read hardware-level state (those cannot be driven in the background and require temporary foreground activation).
- **Disarm the API's hostile defaults** on the one `CGEventSource` we create: suppression interval 0, `PermitAllEvents` for both suppression states (otherwise every posted event freezes the human's real input for 0.25 s; a synthetic mouse-down freezes their mouse until the matching up).
- **Unwind handler on every path** (including signals/panics): release held mouse buttons, release held modifiers after checking `CGEventSourceKeyState`, `CGAssociateMouseAndMouseCursorPosition(true)`. The classic failure is the agent dying between a modifier-down and modifier-up, latching the modifier so every subsequent human keystroke becomes a shortcut.
- **Text input:** `CGEventKeyboardSetUnicodeString` in **20-UTF-16-unit chunks** (delivery truncates at ~20; never split a surrogate pair; ZWSP-prefix chunks starting with whitespace; string set on both key-down and key-up; flags zeroed). Layout-independent — no AZERTY/Dvorak handling needed for text. **Chords** (Cmd+V) go through a `UCKeyTranslate` reverse map built at runtime, never hardcoded keycodes. **Emoji/CJK** fall back to pasteboard + Cmd+V (save/restore clipboard).
- **Click fidelity:** click-state on both down _and_ up of each click; delta fields on every move/drag; `NonCoalesced | 0x20000000` flags; ≥3 intermediate `mouseDragged` events at 8–16 ms spacing or drag-and-drop silently degrades to a click.
- **Secure Input** (password fields, Terminal "Secure Keyboard Entry") empirically does not block posting but blinds listeners — poll `IsSecureEventInputEnabled()` (~3 s) and report the holding pid rather than silently no-op.
- **Coordinate spaces:** AX position, CGWindow bounds, and CGEvent all share one space (top-left origin, points) — an AX-derived target feeds a synthetic click with **no conversion**; only AppKit needs the Y-flip, and pixels need per-display `backingScaleFactor` scaling.

---

## 5. Agent-facing tool surface

Mirror Codex's confirmed `sky.*` / `mcp__computer_use.*` surface, adapted to Synara conventions and the device-family idioms (snapshot → act, activationPoint over frame-centre, candidate labels surfaced in error messages).

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
- Cursor controls: `computer_set_agent_cursor { enabled, theme }`, `computer_get_agent_cursor_state`.

**Design principle to adopt from cua-driver: refuse rather than guess.** Input routing order is semantic-AX → exact window-local pointer → PID keyboard with delivery proof → **structured refusal** (`background_unavailable`, `background_occluded`). Never silently fall back to global HID that could mutate the wrong window. A refused action is a better product than a wrong-window action that looks like it succeeded.

**Known limits to encode** (published + technique-inherent): cannot drive terminal apps or Synara itself; cannot authenticate as admin or approve security/privacy prompts; Chromium coerces synthetic right-clicks to left-clicks in web content and needs `AXManualAccessibility`; canvas/game engines need temporary foreground activation; minimized/off-Space windows are observe-only; **Electron target apps refuse background scroll and drag on macOS** (relevant since Synara is itself Electron). macOS 14.4+, Apple Silicon only.

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

- **`computer:control` is opt-in**, never a default provider capability.
- **Almost every action tool is approval-required.** Define `COMPUTER_APPROVAL_REQUIRED_TOOLS` covering all input/action tools; only read-only perception tools may run without per-call approval once the capability is granted.
- **Per-app "Always allow" list**, persisted (Codex's model): the agent requests permission before using a specific app; the user can grant standing permission per app. This keeps guardian/approval review tractable and is the consent UX users now expect.
- **Visible cursor is a UX aid, not a security indicator.** (cua-driver's own warning.) Authorization is enforced separately in the gateway; the cursor merely shows _where_, not _whether allowed_.
- **Human-takeover / yield.** Design a "user touched the machine" signal. Codex distinguishes synthetic-consequence input from genuine human intervention via `synthesizedActionWasPerformed()` (records uptime+pid; focus callbacks compare). At minimum, surface an ESC-to-cancel affordance and a clear indicator of which agent/thread is driving (Codex shipped _without_ per-agent labeling and immediately got a bug filed — we do it from day one, which also fits Synara's multi-provider/multi-thread nature).
- **Provider gating.** `browser:control` is broad by default; `computer:control` needs a near-total approval-required set and an explicit allowlist of providers permitted to request it.
- **Out of scope initially:** "locked use" (operating after the Mac locks) — it requires a privileged `SecurityAgentPlugins` install, has a large blast radius, and even Codex's implementation is visibly buggy.

---

## 8. Permissions & onboarding

- Three TCC services: **Screen Recording** and **Accessibility** (documented, required), plus **Input Monitoring** (needed in practice for the event-tap preflight path). None can be self-granted on a SIP-enabled Mac; all are user-driven clicks. Screen Recording additionally re-prompts ~monthly on Sequoia+ and can never be MDM pre-granted; Accessibility MDM pre-grant is deprecated in 26.2 / removed in 27.0 (DDM `AppSettings.Privacy` replaces it). Design so the flow tolerates a manual grant step and a relaunch.
- **Preflight from the Electron main process** (no helper needed): `systemPreferences.getMediaAccessStatus('screen')` and `systemPreferences.isTrustedAccessibilityClient(false)`. Prompt only on explicit user action; deep-link to the right Settings pane on denial.
- The trust result is **cached per-process** and goes stale after the user flips the toggle — **relaunch the helper after a grant change** (what every shipping tool does) and/or probe live state with a throwaway listen-only `CGEventTap`.
- `Info.plist`: `NSScreenCaptureUsageDescription` is mandatory — the system kills apps that trigger the Screen Recording prompt without it.
- Ship a `computer-helper check-permissions` subcommand that reports grant state from _inside the helper_, to catch responsible-process misattribution in the field.

---

## 9. Phased roadmap

**Phase 0 — spike (before committing).** ~30-min TCC inheritance experiment (§4.2): signed same-team helper spawned from Electron main inherits Screen Recording + Accessibility without a second prompt. If it fails, the fix is small (move capture into the Electron main via a thin shim, keep input/AX in the helper) but we want to know first. Also `otool -L` / `dyld_info` on our own prototype to confirm the private-symbol resolution path.

**Phase 1 — contracts + manager + fake backend (Linux-testable, no Mac needed).**

- Add `computer:control` capability (opt-in, not in the default set).
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

- The confirmed input path (`CGEventSetWindowLocation` + PID posting), focus-without-raise, disarmed suppression, unwind handlers, text/chords/emoji handling.
- The "Software Cursor" overlay (per-agent color + name badge, Bézier motion).
- `refuse-rather-than-guess` routing; approval integration end to end.

**Phase 4 — hardening & coexistence.**

- Human-takeover/yield detection, ESC-to-cancel, multi-agent cursor identity, per-app "Always allow" list, PiP-style preview, click-sound option, health metrics (fallback rate, respawn count).

---

## 10. Open questions for review

1. **Helper language:** Swift (recommended) vs. Rust+`objc2`. Both viable; Swift matches existing in-tree helpers and SCK's API.
2. **Build vs. buy:** should Phase 2/3 evaluate depending on `@trycua/cua-driver` (MIT, Electron-ready, solves overlay + input + TCC responsibility chain) before writing bespoke native code? It is a near-exact match; risks are its fast cadence and heavy private-SPI use. A time-boxed spike could de-risk the whole native effort.
3. **Helper ownership:** does the helper live under `apps/server/native/` (like `device-helper`) or `apps/desktop/native/` (like `appsnap`)? Since it must be spawned by Electron main for TCC, `apps/desktop/native/` may be the better home despite the server owning the `ComputerManager`.
4. **Scope of Phase 1 tool surface:** ship the full surface against the fake backend, or a minimal click/type/screenshot core first?
5. **Provider allowlist:** which providers may request `computer:control` at all?

---

## Appendix — key source pointers

- Codex reverse-engineering (evidence-labeled): `egoist/waku` `docs/sky-macos-accessibility-reverse-engineering.md`; `iFurySt/open-codex-computer-use`; `vtomnet/codex-cua-tea`; `maka-agent` PiP teardown.
- Open-source analog to lift from: `trycua/cua` `libs/cua-driver/rust/crates/platform-macos/src/{input,cursor,permissions,tools}` and `docs/action-support.md`.
- Electron+Swift-helper precedent: `wulkano/aperture-node` + `wulkano/Aperture`.
- AX production patterns: `screenpipe` `crates/screenpipe-a11y`.
- In-tree templates: `apps/server/src/device/*`, `apps/server/native/device-helper/*`, `apps/desktop/native/appsnap/*`, `apps/server/src/agentGateway/deviceTools.ts`.
- Apple: Quartz Event Services (CGEvent), ScreenCaptureKit, AXUIElement, TCC/PPPC/DDM privacy payloads, CoreHID `HIDVirtualDevice` (long-term high-fidelity alternative).
