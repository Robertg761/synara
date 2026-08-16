# Computer use on Linux

Status: **Phases 0–2 done and verified live on this machine (2026-08-16).** Tier 1 works end to end: ghost cursor on a dedicated `synara-agent` seat (Phase 0 demo drove kcalc to a verified 78 × 6 = 468 while the user's pointer and keyboard stayed untouched), in-compositor capture from the plugin (window and region PNGs, both cursors excluded, verified pixel-correct against the live desktop), and the server backend running the whole path — supervision, reconnect, capture serialization, AT-SPI perception, provisioning across all nine providers. Phase 2's nine review findings are fixed and re-verified; the full verification suite passes. Phase 3a (web ComputerPanel, computer-control opt-in end to end) is implemented, reviewed, and verified live in the browser: the pane streams the real desktop and the composer opt-in toggle works. Next is Phase 3b (input/cursor hardening, release-control hotkey) and Phase 4 (portability, Tier 2/3).
Branch: `computer-use-linux`
Target: Linux desktop. Primary reference machine is Fedora, KDE Plasma 6.7.3, Wayland session.
Companion files: `docs/computer-use-phase0-results.md` records the spike (build, load, verify, findings). `docs/computer-use-macos-reference.md` holds the Codex/macOS reverse-engineering research, reference only. This file is the build target.
Working plugin: `apps/server/native/computer-use-kwin/`. Seeded from the author's sibling `Androdex-Desktop` project, which is the concrete reference implementation for later phases.

## What you asked for

A second cursor, independent of yours, that does things on your real desktop while you keep working, with no fighting over the pointer, and you can see the agent's cursor. Just like the macOS version.

We can build this, and Phase 0 has now proven the load-bearing part on the reference machine. A KWin plugin built here loaded into the live compositor, painted its own overlay cursor, and enumerated the real desktop's windows, all without touching the human pointer. The full record is in `docs/computer-use-phase0-results.md`. An earlier draft of this document said the mechanism was impossible on Wayland. That was wrong: it measured Linux at the wrong privilege level. This version reflects what actually built and ran.

## The insight, and where I got it wrong

macOS does not let a normal application move a second cursor. It has one system cursor, same as Wayland. Codex's ghost cursor works because it borrows authority that sits _below_ the shared input pipeline: it hands each event straight to the target application's process, stamped with window-local coordinates, using a private call that only works with WindowServer-level trust. The real pointer never moves because the event never enters the stream that would move it. Then Codex draws a fake cursor picture on top so you can see where it is acting.

My earlier draft compared that to an unprivileged Wayland client and concluded "impossible." True, but irrelevant. An unprivileged client cannot do it on macOS either. The question is not "can a client do it," it is "who has the authority to route an event to one window without touching the seat pointer, and can we run our code there."

On Linux, that authority is the compositor. On this machine the compositor is KWin, and **KWin takes plugins.** A plugin runs inside the compositor process with the same authority KWin has over input routing. That is the exact privilege level Codex operates at on macOS. So the macOS mechanism ports, structurally, one to one.

## The mechanism

Wayland input is just messages on a per-client socket. When KWin wants an app to see a click, it sends `wl_pointer.enter`, `wl_pointer.motion`, `wl_pointer.button`, `wl_pointer.frame` to that client's pointer resource. The app trusts those messages because they came from the compositor. Nothing in the protocol says the compositor may only talk to one client at a time. It normally does, because there is one physical pointer, but that is policy, not a limit.

So a KWin plugin can:

1. Pick a target window (its `SurfaceInterface`, and from that the `wl_client`).
2. Emit a full pointer or keyboard sequence directly to that client's input resources, with coordinates local to that window.
3. Leave the real seat pointer completely alone. Your cursor does not move. No other client sees anything.

Two apps now believe they have pointer focus at once. That is fine. They cannot see each other. This is the line-for-line Linux twin of Codex's per-process event posting.

The visible agent cursor is a KWin scene overlay `Item`, a `ShapeCursorSource` fed into an `ImageItem` at z=1000, parented to `effects->scene()->overlayItem()`. This mirrors KWin's own `CursorItem`, and Phase 0 confirmed it is the right approach. An earlier draft proposed a `zwlr_layer_shell_v1` surface for this; that would work but it is the wrong tool once the code already runs inside the compositor, where drawing straight into the scene is simpler and needs no separate client. Either way it is a non-interactive overlay, the twin of Codex's click-through "Software Cursor" window: your real clicks never hit it because it is not an input target.

**Independence comes from a dedicated agent seat.** The plugin creates a second `SeatInterface` named `synara-agent` on the Wayland display (public KWin API) and delivers all agent input on it. Wayland toolkits handle seats appearing at runtime, so every client picks it up live. The agent seat mirrors the real keyboard's xkb keymap and tracks its own `xkb_state` for modifier events. The user's real seat is never touched in either direction: agent keys cannot land in the user's window, user keys cannot be captured by the agent's target, and both can type at once. An earlier build time-shared the real seat's focus instead, and a live test with the user active showed exactly the crossover that design invites; the dedicated seat closed it.

Side by side:

| macOS (Codex)                                    | Linux (KWin plugin)                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| WindowServer routes input                        | KWin routes input                                                                |
| Private `CGEventSetWindowLocation` + post to PID | server-side `wl_pointer.enter/motion/button/frame` to the target client resource |
| Real pointer untouched, bypasses the HID stream  | real seat pointer untouched, direct per-resource send                            |
| Runs at WindowServer trust via private API       | runs inside the compositor as a plugin                                           |
| "Software Cursor" click-through NSWindow overlay | KWin scene overlay `Item` (`ShapeCursorSource` + `ImageItem`), like `CursorItem` |
| Perception via AXUIElement tree                  | perception via AT-SPI2 tree                                                      |
| Capture via ScreenCaptureKit                     | capture via PipeWire / KWin `ScreenShot2`                                        |
| Gated by TCC permission                          | plugin is trusted code the user installs                                         |

## Confirmed on this machine

Not speculation. The plugin built, loaded, and ran here on 2026-08-15 (full record in `docs/computer-use-phase0-results.md`).

- Compositor: KWin 6.7.3, Plasma 6.7.3, Wayland session.
- **`kwin-devel-6.7.3` is installed.** Internal KWin headers are present under `/usr/include/kwin/` (`core/`, `cursor.h`, `cursorsource.h`, `compositor.h`, and the rest). The plugin compiles against this exact KWin.
- **Runtime plugin load works.** `busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins LoadPlugin s SynaraComputerUsePlugin` returned `true`, and `UnloadPlugin` removes it cleanly. (This is the `/Plugins` binary-plugin interface, distinct from `/Effects loadEffect` and `/Scripting loadScript`.)
- **Scene overlay and window enumeration confirmed live.** `healthJson` reported the overlay, workspace, and effects handles all reachable; `windowsJson` returned real window bounds and PIDs across all three monitors.
- AT-SPI2 running (`org.a11y.Bus`, owned by KWin) for the accessibility tree.
- PipeWire running for capture, and KWin exposes `org.kde.KWin.ScreenShot2`.
- No external fake-input global (`org_kde_kwin_fake_input`, wlroots virtual pointer) is exposed. That confirms the outside-in client paths are closed here, which is precisely why the answer lives inside the compositor.

Everything the primary design needs is already on the machine, and the core of it has run.

## The honest costs

I would rather name these now than have them surface in review.

- **KWin's internal API is not ABI-stable.** A native plugin is built against one KWin version. We pin to 6.7.x and rebuild per KWin release. This is the direct Linux analog of macOS private APIs breaking between releases, and it is the main ongoing tax. Mitigation: keep the plugin small and mechanical, isolate all version-specific calls behind a thin shim, and gate load on a version check with a clear message when KWin moves.
- **It is KDE-specific.** The plugin path works on KWin. GNOME (Mutter) has no comparable out-of-tree plugin interface, and other wlroots compositors differ again. We handle that with the tiered design below, so KWin gets the full macOS-equivalent experience and other environments get a working, lesser mode rather than nothing.
- **Trust.** The plugin runs inside the compositor. That is real privilege. It is the same bargain macOS makes with TCC-granted accessibility, but the user is installing compositor-level code, so the consent and provenance story has to be explicit.

## Three tiers, best available wins

One backend interface, three implementations, chosen at runtime by what the environment supports. This keeps the ambitious path and a graceful fall-off.

**Tier 1, KWin plugin. The macOS-equivalent path. Primary on this machine.**
A dedicated agent seat plus a scene-overlay ghost cursor, on your real desktop, able to drive arbitrary windows including ones you already have open. This is the full "just like macOS" experience. Requires KWin and the matching plugin build.

**Tier 2, Wayland proxy. Portable, agent-launched apps on the real desktop.**
We run a small Wayland proxy and launch the agent's apps with `WAYLAND_DISPLAY` pointing at it. The proxy forwards their buffers to the real compositor, so their windows appear as normal windows on your actual screen, mixed with yours. Because we sit on the far end of those apps' sockets, we inject synthetic input straight into them, exactly as the app expects, without touching your pointer. This is the same philosophy as Codex, intercept at event delivery to the target, and it works on any Wayland compositor, not just KWin. The one gap versus Tier 1: it can only drive apps it launched through the proxy, not windows that were already open under the real compositor. For agent work that is usually fine and safer.

**Tier 3, nested compositor. Isolated sandbox for CI, headless, and unsupported desktops.**
Run a full nested compositor (a wlroots kiosk like `cage`/`sway`, or nested `kwin_wayland`), give the agent its own isolated desktop, capture it over PipeWire into a Synara pane, inject into the seat we own. Fully isolated, needs no special compositor support, runs with no display in CI against the fake backend. This is the safe floor and the test harness, not the headline experience.

Recommended default: Tier 1 where KWin is present, Tier 2 elsewhere, Tier 3 for CI and headless. The backend interface hides the difference from the tool layer.

## Architecture

```
Host KDE/Wayland session
│
├─ KWin (org.kde.KWin)
│     └─ Synara computer-use plugin (Tier 1)
│            ├─ per-surface pointer/keyboard injection to a chosen window
│            ├─ scene-overlay ghost cursor (ShapeCursorSource + ImageItem)
│            └─ D-Bus control: org.synara.ComputerUse1 ◄─┐
│                                                        │
├─ apps/desktop (Electron)                               │ D-Bus
│     ├─ loads/unloads the plugin via org.kde.KWin/Plugins
│     ├─ drives it via org.synara.ComputerUse1 ──────────┘
│     ├─ capture: PipeWire / ScreenShot2
│     └─ perception: AT-SPI2 over D-Bus
│
└─ WebSocket (existing Synara transport)
      │
      ▼
apps/server (Node)
   ComputerManager (state machine)
     ├─ KWinPluginBackend      (Tier 1)
     ├─ WaylandProxyBackend    (Tier 2)
     ├─ NestedCompositorBackend(Tier 3)
     └─ FakeComputerBackend    (CI, no display)
   computerTools.ts ──► registered in AgentGateway when supported
   ComputerFrameTransport ──► /ws/computer-frames
      │
      ▼
apps/web (React)
   ComputerPanel, live view + the agent's cursor
   consent / session controls
```

### Capture

PipeWire is the standard Wayland capture transport and is already running. For Tier 1 and Tier 2 the windows live on the real compositor, so capture the relevant output or window and feed frames into the existing frame transport (`deviceFrameTransport.ts`, `/ws/device-frames`), generalized to also serve the computer pane. For Tier 3 we capture the nested compositor's own output. Encode to the format the device pane already renders so the web side is close to free.

The Phase 2 capture spike (`docs/computer-use-capture-notes.md`) settled the path ordering on KDE. `org.kde.KWin.ScreenShot2` is gated on a desktop-entry authorization and was observed rejecting a normal process with `NoAuthorized` on this machine, so it is not a daemon option. The portal ScreenCast route works but normally costs an interactive consent dialog at `Start`. The primary path is therefore capture inside the Tier 1 plugin itself (offscreen filtered `SceneView` render, the same mechanism KWin's own screenshot plugin uses), with portal ScreenCast as the consent-aware fallback and for Tier 2/3.

### Input

- Tier 1: all agent input rides the dedicated `synara-agent` seat from inside the plugin, driven through the plugin's D-Bus interface `org.synara.ComputerUse1` (`movePointer`, `button`, `axis`, `key`, `focusWindow`, `clearFocusWindow`, plus `healthJson` / `stateJson` / `windowsJson` for introspection and `start` / `stop` for the session). Keys go through `SeatInterface::notifyKeyboardKey` on the agent seat with plugin-tracked xkb modifier state; the real keyboard pipeline is never involved. Pressed buttons and keys are tracked and released on stop or plugin destruction, so a mid-action stop cannot latch a stuck modifier. This is the whole point of the tier.
- Tier 2: synthetic events written into the proxied client streams.
- Tier 3: virtual pointer/keyboard into the seat we own (wlroots virtual-input protocols on `cage`/`sway`, or `libei` against nested `kwin_wayland`).

`libei`, `libeis`, `libinput` are all installed, and `/dev/uinput` exists, so the lower-level fallbacks are available if a tier needs them. `ydotool` at the kernel level stays a last resort only, because it injects globally and would move the real pointer, which defeats the entire goal.

### Perception

AT-SPI2 first for structure (roles, names, positions), the Linux analog of the macOS AX tree, with `org.a11y.Bus` already live. Pixels second, from the capture stream, for anything AT-SPI does not expose. Targeting reuses the device family's snapshot-then-act idiom: act on a named element, prefer an element's own point over a frame center, and surface candidate labels in the error when a target is ambiguous.

## Mapping onto Synara

Mirror the iOS `device_*` family. It is already an isolated, streamed, input-driven environment with a snapshot-then-act loop and an approval posture, so it is the right template regardless of which tier is active.

| Concern                       | iOS device family                                                     | Linux computer-use family                                                     |
| ----------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| MCP tools                     | `deviceTools.ts`                                                      | `computerTools.ts`                                                            |
| Registry gating               | `AgentGateway.ts:732`, `deviceService?.supported === true ? ... : []` | same pattern, `computerService?.supported === true`                           |
| State machine                 | `DeviceManager.ts` + `DeviceBackend.ts`                               | `ComputerManager.ts` + `ComputerBackend.ts`                                   |
| Fake backend (CI, no display) | `FakeDeviceBackend.ts`                                                | `FakeComputerBackend.ts`                                                      |
| Real backend                  | `IosSimulatorBackend.ts`                                              | `KWinPluginBackend` / `WaylandProxyBackend` / `NestedCompositorBackend`       |
| Helper transport              | `helperClient.ts` (JSON-RPC over stdio)                               | D-Bus to the plugin (`org.synara.ComputerUse1`); stdio JSON-RPC for Tiers 2/3 |
| Targeting                     | `uiTreeTargeting.ts`                                                  | `atspiTreeTargeting.ts`                                                       |
| Frame transport               | `deviceFrameTransport.ts`, `/ws/device-frames`                        | generalized `FrameTransport`, `/ws/computer-frames`                           |
| Approval gating               | `PROVIDERS_WITHOUT_APPROVAL_GATE`, `DEVICE_APPROVAL_REQUIRED_TOOLS`   | `COMPUTER_APPROVAL_REQUIRED_TOOLS`                                            |
| Web pane                      | `DevicePanel.tsx` and siblings                                        | `ComputerPanel.tsx` and siblings                                              |

### Capability model

`AgentGatewayCapability` in `apps/server/src/agentGateway/Services/AgentGatewaySessionRegistry.ts:4` currently spans `thread:read`, `thread:write`, `automation:write`, `diagnostics:read`, `browser:control`, `device:control`. Add `computer:control`.

It must not join the blanket default in `PROVIDER_SESSION_CAPABILITIES` (`Layers/AgentGatewaySessionRegistry.ts:12`), which grants every listed capability to every provider session. Driving the real desktop through a compositor plugin is the most consequential thing Synara could do, so `computer:control` is opt-in per provider, and the action tools are approval-required.

### Tool surface

Perception, read-only, no approval, still behind `computer:control`:

- `computer_list_windows`, `computer_get_state { include_screenshot?, include_text? }`, `computer_get_screen_size`, `computer_launch_app`.

Action, approval-required:

- `computer_click`, `computer_double_click`, `computer_right_click`, `computer_move_cursor`, `computer_drag`, `computer_scroll`.
- `computer_type_text`, `computer_press_key`, `computer_hotkey`.
- `computer_set_value`, `computer_perform_action` for AT-SPI semantic writes.

Same refuse-rather-than-guess rule as the device family. If a target is ambiguous or off-screen, return a structured error with candidates instead of clicking the wrong thing.

### Shared extractions

Per the repo's maintainability rule, this should cut duplication, not add it.

1. Stdio JSON-RPC transport. There are already two copies (Codex app-server in `codexAppServerManager.ts`, device helper in `helperClient.ts`). Extract framing, correlation, timeout, and respawn into `packages/shared` (subpath export, `@synara/shared/jsonrpc-stdio`) and move both onto it. Tier 1 talks to the plugin over D-Bus, not stdio, but Tiers 2 and 3 need this transport, so they reuse the shared copy rather than adding a third.
2. Frame transport. Generalize `deviceFrameTransport.ts` and `deviceFrameRoute.ts` into a shared `FrameTransport` so `/ws/computer-frames` reuses it. `packages/shared/src/deviceFrame.ts` already holds the header logic.
3. Targeting. `uiTreeTargeting.ts`'s snapshot-then-act idioms generalize to an AT-SPI targeter.
4. Contracts in `packages/contracts` (schema only): `ThreadComputerState`, `ComputerAvailability`, `ComputerEvent`, the frame header, and a `WsComputerRpcGroup` in `rpc.ts`, mirroring `device.ts`.
5. Any expand/collapse in `ComputerPanel` reuses `apps/web/src/lib/disclosureMotion.ts`. No bespoke toggle animation.

## Consent and safety

- `computer:control` is opt-in, never a default provider capability.
- Action tools are approval-required via `COMPUTER_APPROVAL_REQUIRED_TOOLS`. Perception is read-only.
- The plugin ships as identifiable, versioned code, loaded explicitly over `org.kde.KWin/Plugins` with the user's consent, and reports which KWin version it was built for (a mismatched build is refused by KWin, as Phase 0 confirmed). Installing compositor-level code is a deliberate act, presented as one.
- A visible session indicator shows which thread is driving and offers an immediate stop. Since Tier 1 acts on your real desktop, add a global "release control" hotkey and a clear on-screen marker whenever the agent's cursor is live.
- The agent cannot drive KWin's own security or authentication prompts, matching the macOS limitation, so it cannot approve its own escalations.

## Phased roadmap

**Phase 0, the load-bearing spike. Done, 2026-08-15, including the live input demo and the dedicated-seat fix.**
Built a KWin 6.7.3 plugin (`apps/server/native/computer-use-kwin/`), loaded it into the live compositor over D-Bus, verified read-only introspection against the real desktop (health, window enumeration, session state), then, with the user's approval, ran synthetic input end to end: the ghost cursor glided to kcalc, clicked buttons, typed digits, and computed 78 × 6 = 468, verified by reading kcalc's display over AT-SPI, all while the real pointer never moved. A first build time-shared the real seat's focus, and a live run with the user active showed input crossover both ways; the same day the plugin got its dedicated `synara-agent` seat (own keymap, own xkb modifier state) and the full demo passed on it with the desktop in normal use. Other findings: the expected KWin ABI drift (`ItemRenderer::createImageItem()` removed in 6.7; `ImageItem` now has a public constructor); AT-SPI extents on Wayland are frame-relative, so targeting must fuse them with the plugin's window bounds; and KWin pins a loaded plugin library, so the dev loop needs versioned plugin filenames per rebuild. Full record: `docs/computer-use-phase0-results.md`.

**Phase 1, contracts, manager, fake backend. Runs in CI with no display. Implemented 2026-08-15, review fixes in progress.**
Add `computer:control` (opt-in). Add contracts. Build `ComputerManager`, the `ComputerBackend` interface, and `FakeComputerBackend` driving the full snapshot, act, event loop with synthetic frames. Add `computerTools.ts`, registered in `AgentGateway` gated on support, with `COMPUTER_APPROVAL_REQUIRED_TOOLS`. Extract the shared stdio JSON-RPC transport and frame transport. Full unit coverage against the fake backend.
Landed as specced (built by gpt-5.6-luna, verified fmt/lint/typecheck/full test suite): `packages/contracts/src/computer.ts` + `WsComputerRpcGroup` (defined, served in Phase 2), `@synara/shared/jsonrpc-stdio` with both former copies (codex app-server transport, device helper client) migrated, shared `FrameTransport` + `computerFrame` codec with the device wire format byte-identical, `apps/server/src/computer/`, and `computerTools.ts`. The default service wires `FakeComputerBackend` with `supported: false`, so no tools are exposed until Phase 2 turns on a real backend. An independent review (Opus) confirmed the extractions faithful and the gating sound, and surfaced fixes now being applied: gate `computer_launch_app` like `device_launch`, stop trimming `type_text`/`set_value` input, two `ComputerManager` lifecycle races, and byte-level wire tests for the shared codecs.

**Phase 2, Tier 1 backend, perception. Done, 2026-08-16, verified live.**
Grow the Phase 0 plugin into the real thing: window enumeration, capture over PipeWire / ScreenShot2, AT-SPI2 tree reads, plugin lifecycle and supervision from Electron, the control socket, and the web `ComputerPanel` showing the live view.
Landed: in-compositor capture in the plugin (`captureWindow`/`captureRegion`, offscreen filtered render excluding both cursors, single in-flight latch, 2 s render + 5 s encode deadlines), `KWinComputerBackend` (D-Bus supervision with reconnect/backoff, capture serialization queue, lazy `start()` so the ghost cursor only appears on the first real action, method-level vs connection-level error classification, per-call D-Bus timeouts), the AT-SPI helper with role-based window matching, and the provisioning chain (`enableComputerControl` → lease capability → tools) across all nine providers. Nine review findings (A–I: capture races, bus teardown on benign errors, `launchApp` crash, boot-time ghost cursor, AT-SPI application-node mismatch, missing timeouts, single-element array corruption, missing space key, lifecycle leaks) were fixed by gpt-5.6-luna and re-verified line by line. Live verification on this machine 2026-08-16 with plugin V3 loaded into the running compositor: `healthJson` reports `capture: true` and `workspaceGeometry` 5120×2520; window capture of a live widget came back pixel-sharp at its exact 500×600 client size with translucency intact, no cursors baked in, and no premultiplied-alpha fringing; region and scaled captures correct; the server backend ran the same paths end to end including two concurrent captures (serialized cleanly against the plugin latch) and a bogus-window error that propagated without dropping the bus connection; `dispose()` stopped the plugin and removed the ghost cursor. One live-only bug surfaced and fixed: KWin 6.7 exposes the loaded-plugin list as the `LoadedPlugins` property and returns void from `UnloadPlugin`, where both the backend and the install script expected a `loadedPlugins` method and a boolean reply; both now prefer the property and tolerate the void reply, with the method as fallback.

**Phase 3, Tier 1 backend, input and cursor.**
The core input mechanism (dedicated seat, pointer, keyboard with modifiers, ghost cursor) already works from Phase 0. This phase hardens it into product: drag, scroll, hotkey sequences, smooth cursor motion curves, AT-SPI semantic writes, refuse-rather-than-guess targeting (fusing AT-SPI layout with plugin window bounds, per the Phase 0 finding), approval flow, and the release-control hotkey end to end.

_Phase 3a, web surface + opt-in. Done, 2026-08-16 (built by gpt-5.6-luna, reviewed line by line by the main agent, all checks green; verified live in a dev-server browser session)._
Landed: the `ComputerPanel` right-dock pane (live desktop canvas fed by standalone PNG keyframes over the dedicated `/ws/computer-frames` socket, uint32-modular sequence gate with gap-triggered resync, letterboxed to the reported screen size, agent-cursor overlay and "Agent controlling" indicator, availability/blocked states from `computer.getThreadState`); a shared `binaryFrameSource` module now backing both the device and computer frame routes (device wire behavior unchanged); `computerStateStore` + `useComputerEventBridge` for the `computer.event` push channel; and the per-thread **Computer control** opt-in (default off) flowing composer draft → orchestration contracts (`enableComputerControl` on turn-start, queued-dispatch, edit-resend) → `ProviderCommandReactor` → `ProviderService.startSession`, with draft persistence and all six web dispatch paths covered. Review fixes applied on top of the build: the reactor compares a requested flag against the session's effective default (`?? false`) so legacy-started sessions aren't gratuitously restarted by the web client's always-present flag, and a computer-control-only restart keeps the resume cursor since provisioning is re-derived at every session start; the composer seeds thread computer state itself (shared `useThreadComputerStateSeed` hook) so the toggle works before the pane is ever opened; frame-source rationale comments restored in the shared module. Approval flow stays provider-native (each provider's own tool-approval gate covers computer tools; `PROVIDERS_WITHOUT_APPROVAL_GATE` refuses). Deferred to 3b: panel input forwarding, release-control hotkey, `windows-changed`/`action` events carrying a thread id.
Live verification notes (2026-08-16): the pane streams the real 5120×2520 desktop letterboxed into the dock, availability seeds correctly, and the Computer control switch in the composer's permissions menu enables, toggles, and reverts. Two findings came out of the run. First, Turborepo's strict env mode stripped `XDG_SESSION_TYPE` and `WAYLAND_DISPLAY` from the dev server, so `bun dev` always reported "requires a Wayland session"; `turbo.json` now lists both (plus `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` explicitly) in `globalPassThroughEnv`. The packaged Electron server never goes through turbo and was unaffected. Second, killing the server mid-stream leaves the plugin session (and ghost cursor) running because Effect finalizers don't run on a hard kill — a 3b hardening item; a plugin-side idle timeout that stops the seat when no capture or input arrives for a while would cover every ungraceful-exit path.

Recorded input test (2026-08-16, video at `~/Videos/synara-input-test-2026-08-16.mp4`): every remaining input primitive verified end to end against a live KWrite window through the real `ComputerManager` → `KWinComputerBackend` → plugin path — click (caret placed at the target point, agent-seat keyboard focus followed), `ctrl+end`/`ctrl+home` hotkeys (viewport jumped to line 301 and back), wheel scroll in both directions (deltaY −600 moved the view up 15 lines, +600 returned it exactly), a diagonal press-move-release drag (produced a real text selection ending at 11:54), `ctrl+a`, and `typeText` (replaced the 300-line buffer with the typed sentence). Dispose stopped the plugin session cleanly (`running:false`, no stuck buttons or keys). Two observations: the ghost cursor overlay IS visible in external Spectacle screenshots (only the plugin's own captures exclude it), which is exactly right for user-facing evidence; and `drag`'s `durationMs` doesn't control wall time — `easedPoints` derives the step count from it but `drag` sleeps a fixed 8 ms per step, so a 1500 ms request glides in ~300 ms. Harmless for correctness, but 3b's smooth-motion work should make the sleep duration-derived.

Real-agent E2E test, first run (2026-08-16): a GPT-5.5 Codex thread in a scratch dev project, permission mode "Ask for approval", Computer control enabled, prompted to compute 12×34 in KCalc by mouse. The agent found the tools and called `computer_launch_app` — and the call was auto-rejected before it ran. Root cause: in approval-required mode (`approvalPolicy: "untrusted"`), Codex app-server asks the client to approve MCP tool calls via a `mcpServer/elicitation/request` server request (`_meta.codex_approval_kind: "mcp_tool_call"`, with `tool_name`, `tool_params_display`, and a `persist: ["session","always"]` capability list). `codexAppServerManager.handleServerRequest` didn't recognize the method and replied `-32601 Unsupported server request`, which Codex records as "user rejected MCP tool call". So with approval mode on, every agent-gateway tool call (not just computer tools) was silently refused. The fix (a new `"tool"` `ProviderRequestKind` end to end, plus the elicitation response contract `{action: accept|decline|cancel, content, _meta:{persist}}` mirrored from the codex-rs TUI implementation) routes these through Synara's normal approval card; non-approval elicitations (auth forms, `mode:"url"`) get a graceful `cancel` instead of a protocol error.

Real-agent E2E test, second run (2026-08-16, Claude Sonnet 5, same scratch project and prompt): surfaced four defects, two now fixed and verified live, two under fix. First, the orchestration decider dropped `enableComputerControl` from all three event payloads it builds (`thread.turn.start`, `thread.turn.dispatch-queued`, `thread.message.edit-and-resend`), so the reactor never saw the flag, the session lease never carried `computer:control`, and every computer tool call failed with `capability_denied` — the web client, contracts, normalization, and reactor were all correct; only the decider lost the field. Second, Claude tool approvals arrived as `request.opened` with the adapter's item-type string `dynamic_tool_call` instead of a canonical approval type, which has no request-kind mapping, so the approval card never rendered and the turn hung; the same latent hole existed for OpenCode (default `"unknown"`) and ACP kinds `search`/`fetch`/`think`/`other` on Cursor/Grok/Droid. All three adapters now fall back to canonical `tool_approval`, persisted `dynamic_tool_call` events still map to the tool kind, and the projection derives `toolName`/`toolParamsDisplay` from Claude-shaped `canUseTool` args alongside the Codex `_meta` shape. With both fixes live the run proceeded: capability granted after a `computerControlChanged: true` session restart, approval card rendered, "always allow" honored, and `computer_launch_app` opened KCalc on the real desktop. Then the perception layer failed it: `computer_get_state` screenshots captured a single window chosen by a fragile fallback (target → focused → first visible), which resolved to a static desktop surface — the agent received byte-identical wallpaper PNGs the whole run and correctly refused to invent a result — and the screenshot's window-local pixels carry no mapping to the global coordinates the pointer tools use, so a screenshot-derived click at (44,44) sat in the top-monitor dead zone and KWin clamped it to (44,1080). The fix in flight: `getState` captures the full workspace via `captureRegion`, the screenshot payload gains `region` + `scale` metadata, tool descriptions spell out the mapping, and pointer actions report back when the compositor clamped the landing point.

**Phase 4, portability and hardening.**
Tier 2 (Wayland proxy) for non-KWin compositors and Tier 3 (nested compositor) for CI and headless, behind the same backend interface. Multi-session, health metrics, crash recovery, clipboard handling, and the KWin-version gate with a clean upgrade message.

## Open questions for review

1. Confirm Tier 1 (KWin plugin, real desktop, arbitrary windows) as the headline target. It is the true "just like macOS" answer and this machine can build it today. The cost is per-KWin-version rebuilds.
2. Plugin language and build: C++ against the installed `kwin-devel` headers is the direct route. Confirm we are comfortable owning a compiled KWin plugin and pinning to KWin 6.7.x.
3. Do we want Tier 2 (proxy) in the first shippable cut for non-KDE users, or is Tier 1 plus the Tier 3 sandbox enough to start?
4. Scope of the Phase 1 tool surface: full surface against the fake backend, or a minimal click, type, screenshot core first?
5. Which providers may request `computer:control` at all?
