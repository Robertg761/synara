# Tier 2 plan: computer use on non-KDE Wayland desktops

Decided 2026-08-17. Scope decision: the feature ships full and complete, so Tier 2 is in the shippable cut (design doc open question 3). This plan replaces the design doc's original Tier 2 mechanism sketch.

## The mechanism correction

The design doc's Tier 2 sketch — a Wayland proxy that owns the app's socket and forges input events — is technically real and is the only design that preserves Tier 1's defining property, a second seat the human's focus never sees. It is also a protocol-relay compositor: object-ID and interface tracking across ~30 protocols, fd and `new_id` relaying, dmabuf import for capture, no XWayland, and version churn per protocol. Worse, a proxied client cannot know its global position under Wayland, so `ComputerWindow.bounds`, screenshot regions, and every pointer coordinate would land in a synthetic space rather than the desktop space the tool surface and the agent's proven coordinate skill depend on. **The relay proxy is not built.** The tier name stays; the mechanism changes.

## Mechanisms per capability

| Capability   | GNOME (mutter)                                                                                                                                                                                                  | wlroots (sway/Hyprland/river)                                                                                                                                            | vs Tier 1                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Input        | `org.freedesktop.portal.RemoteDesktop` + `ConnectToEIS` → libei. Absolute motion only if a ScreenCast session is joined to the same session handle; keycodes are evdev, so the existing tables are reused as-is | `zwlr_virtual_pointer_manager_v1` + `zwp_virtual_keyboard_manager_v1`, unprivileged, no prompt                                                                           | **Shared real seat.** Real cursor moves, real focus follows |
| Capture      | ScreenCast portal → `OpenPipeWireRemote` → PipeWire node; `cursor_mode: metadata` so pixels stay cursor-free and position arrives as metadata                                                                   | `zwlr_screencopy_manager_v1`, unprivileged, no prompt, per-output or region                                                                                              | Equivalent quality; region/window crop done server-side     |
| Windows      | **Nothing native.** No client-visible enumeration; AT-SPI extents are frame-relative. Answer: a GNOME Shell extension (below)                                                                                   | `zwlr_foreign_toplevel_management_v1`: title, app_id, activated/minimized, activate/close. No geometry, no stacking, no occlusion. Hyprland's IPC does give global rects | The hard gap                                                |
| Clipboard    | RemoteDesktop v2 `SelectionRead`/`SelectionWrite` inside the granted session; `wl-clipboard` fallback needs `ext-data-control` (mutter ≥ GNOME 48)                                                              | `wl-clipboard` over `wlr-data-control`, works today                                                                                                                      | Same shared-with-human semantics                            |
| Ghost cursor | Impossible. No second pointer, no overlay surface                                                                                                                                                               | Impossible as a pointer; a click-through `zwlr_layer_shell_v1` marker is decoration only                                                                                 | Lost                                                        |
| Kill switch  | Portal session dies with the D-Bus connection, libei fd closes                                                                                                                                                  | Helper exit stops input                                                                                                                                                  | Better than Tier 1's plugin-side deadline                   |

"Ghost cursor without stealing the human's pointer" cannot mean a second pointer on Tier 2. It can only mean: pixels captured without a cursor baked in, a marker drawn in the `ComputerPanel` overlay (already implemented), and cursor-position restore after each action sequence. Focus cannot be restored without an activation provider, so window-targeted typing on Tier 2 does take the human's focus. That is the tier's defining consequence and must be consented to explicitly, not discovered.

## Structure: one backend, composed providers

One class, `PortalComputerBackend`, implementing `ComputerBackend`; four provider interfaces resolved at construction by a probe. A class per desktop would duplicate what `KWinComputerBackend` shows is the actual bulk of the work — supervision, health accounting, capture serialization, glide timing, stroke sequencing, region/scale math, clamp reporting.

```
apps/server/src/computer/
  computerGeometry.ts        // extracted: workspaceRectFromWindows, screenSizeFromWindows,
                             //   readPngDimensions, alignRect, screenshotFromPng, parseWindows
  computerHealthState.ts     // extracted: consecutiveFailures/reconnects/lastFailure/publishHealth
  pointerSequencing.ts       // extracted: glide-to-deadline, stroke/hotkey press-release bookkeeping
  evdevInput.ts              // kwinInput.ts tables, renamed; not KWin-specific
  supervisedProcess.ts       // extracted from nestedKWinSession.ts: stderr ring, exitDiagnostic,
                             //   first-stdout-line, SIGTERM→SIGKILL terminate, unref
  portal/
    PortalComputerBackend.ts  providers.ts  probe.ts
    portalSession.ts  portalRequest.ts  restoreTokenStore.ts
    eiInputProvider.ts  pipewireCaptureProvider.ts
    wlrootsInputProvider.ts  wlrScreencopyProvider.ts  foreignToplevelWindowProvider.ts
    gnomeShellWindowProvider.ts  hyprlandWindowProvider.ts
    sharedSeatArbiter.ts  desktopHelperClient.ts
apps/server/native/computer-desktop-helper/   // C: wayland-client, libei, libpipewire-0.3,
                                              // vendored stb_image_write; stdio JSON-RPC + binary frames
```

Split of responsibility: TypeScript owns portal D-Bus (dbus-next is already a dependency, with `negotiateUnixFd`), consent state, restore tokens, health, and supervision; the helper owns only protocol plumbing that has no Node binding, and receives the EIS fd via an extra `stdio` slot. Transport is `@synara/shared/jsonrpc-stdio` plus the existing binary frame envelope — the same shape as `atspiClient.ts`.

## Window listing: the load-bearing gap

Without a window model the agent has no launch → locate → zoom → click loop, which is exactly what the fourth E2E run validated. Two answers:

- **GNOME Shell extension** (`synara-computer-use@synara.dev`), the direct analogue of the KWin plugin: JS running inside mutter, exposing `windowsJson`/`raiseWindow`/`activateWindow` on `org.synara.ComputerUse1` with the identical JSON so the extracted `parseWindows` is reused verbatim. Same trust story, same install-and-load script shape, same version gate (`shell-version` per GNOME release — the GNOME analogue of the KWin ABI tax). The single highest-value Tier 2 component.
- **Degrade honestly, never silently.** Returning `[]` is a lie that made the agent relaunch KCalc three times in E2E run 3. Instead: `listWindows()` rejects with a non-retryable `ComputerBackendError` naming the missing piece and the install path, and window-scoped capture/targeting refuse the same way.

Contract changes this forces (all in `packages/contracts/src/computer.ts`):

- `ComputerWindow.bounds` becomes optional, documented as "absent when the display server exposes no window geometry" (wlroots foreign-toplevel).
- `ComputerBackend.capabilities(): ComputerCapabilities` — `{ windows, windowBounds, stacking, capture, input, clipboard, activation, ghostCursor, sharedSeat }` — surfaced on `ThreadComputerState` so the panel badge and the tool descriptions are honest.
- `ComputerHealthStatus` gains `"awaiting-consent"`.

## Selection

`makeLinuxBackend()` becomes an explicit ordered resolution, with no fallback in any direction (the `unavailableNestedBackend` pattern generalized):

1. `SYNARA_COMPUTER_BACKEND` override (`kwin` | `nested` | `nested-window` | `portal`) — a failure under an override stays failed.
2. `SYNARA_COMPUTER_NESTED=1` → Tier 3, unchanged.
3. Auto: probe the session bus for the `org.kde.KWin` name — the compositor, not `XDG_CURRENT_DESKTOP`. Present → Tier 1, unchanged.
4. Else → Tier 2.

The probe must be side-effect free and must never open a portal session: session type, `org.freedesktop.portal.Desktop` presence plus its `RemoteDesktop` version and `AvailableDeviceTypes`, a cheap display connection to enumerate wlroots globals, the extension's bus name, the helper binary's existence. `availability()` names the failed step, including the package to install (`xdg-desktop-portal-gnome`, `wl-clipboard`) or the script to run. A missing grant is not unavailable: availability stays `available`, health reports `awaiting-consent`.

## Portal and permission UX

- **One dialog.** Create a single session that calls both `SelectDevices` and `SelectSources`, then one `Start`. This is also the only way to get absolute pointer coordinates mapped to the capture's coordinate space on GNOME.
- **When.** Never at boot, never at probe. Lazily on the first mutating action or first pane attach, mirroring Tier 1's lazy `start()`. `parent_window: ""` for a daemon. The panel shows `awaiting-consent` with the reason, because the user has to go find a dialog.
- **Persistence.** `persist_mode: 2` plus the stored `restore_token` on `SelectSources`; after a successful `Start`, read the new token from the response and replace the stored one — they are single-use. Store at `$XDG_STATE_HOME/synara/computer/portal-grants.json`, mode 0600, keyed by `{desktop, portalVersion}`, never logged, never sent to the web. A restore that prompts anyway is normal.
- **Denial latches**, exactly like the release-hotkey latch: a cancelled or denied `Start` is never retried automatically. It clears only on an explicit user action.
- **wlroots grants nothing and prompts for nothing.** Say so: there, Synara's own `computer:control` opt-in, the per-thread toggle, and the approval-required tools are the only gate that exists.

## Shared-seat arbitration

`sharedSeatArbiter.ts`, extending the existing thread-lease model to treat the human as a participant:

1. **Yield to the human.** Poll idle time (`org.gnome.Mutter.IdleMonitor`; `ext-idle-notify-v1` on wlroots). Human active within ~2 s → mutating actions get a retryable `computer_human_active` refusal, the panel says the agent is waiting. Perception stays free.
2. **Cursor restore.** Record the pointer position from the stream's cursor metadata before an action sequence, restore it after. Turns a click into a flicker.
3. **Focus restore** only where an activation provider exists (extension, foreign-toplevel).
4. **UI.** A distinct "Shared control — the agent is driving your real cursor and keyboard" badge whenever `capabilities.sharedSeat`, shown at enable time in the composer's permissions menu, not only in the pane. No Meta+Shift+Esc: the kill switch is the pane's stop plus the server-side deadline, and a dead server drops the portal session and the EIS fd, which is a better ungraceful-exit story than Tier 1 had.

## Tests

- **Unit, always on, no display.** Every provider is an interface with a fake. Cover the probe/selection decision table and its exact availability strings; `Request`/`Response` correlation including out-of-order, cancel, and timeout; restore-token round trip, rotation, 0600, corrupt file; the denial latch; health transitions through `awaiting-consent`; capability-gated refusals; the arbiter's yield and restore ordering; the extracted geometry/health/pointer modules against both backends.
- **Fake portal service.** Stand up a real `org.freedesktop.portal.Desktop` implementation on a private `dbus-daemon` (reusing the Tier 3 idioms) and drive the production client code against it. The only way the full session lifecycle is testable in CI, and it is cheap.
- **Integration lane: headless sway, not GNOME.** `WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 sway` boots in about a second with no DRM and exercises the whole wlroots provider set for real — virtual pointer/keyboard, screencopy, foreign-toplevel, idle-notify, clipboard. Gate behind `SYNARA_NESTED_WLROOTS_TEST=1`, mirroring `SYNARA_NESTED_KWIN_TEST=1`, on the extracted `supervisedProcess.ts`.
- **No nested GNOME lane.** `mutter --nested` boots, but the portal `Start` dialog has no supported auto-approval, so a GNOME lane would test everything except the part that is risky. GNOME coverage is the fake-portal service plus a documented live checklist on a GNOME box, in the style of the Tier 1 live checklists.

## Phasing

- **Phase A — windowed nested session (done).** Smallest shippable slice, no new native code. Shipped as `SYNARA_COMPUTER_NESTED=window`: `nestedKWinSession.ts` boots the same private session without `--virtual` and with the host `WAYLAND_DISPLAY` kept, so `kwin_wayland` runs as an ordinary Wayland client of the host compositor — a real window on the human's desktop containing an isolated agent desktop, with the dedicated seat, ghost cursor, in-plugin capture, AT-SPI, clipboard, occlusion, idle timeout, and release hotkey all intact. It refuses to start (with actionable copy) when the server has no host `WAYLAND_DISPLAY`; there is no fallback between modes. Verified live on the KDE host 2026-08-17: the nested compositor mapped as a host window, the plugin loaded on the private bus, kcalc launched and listed inside, and dispose removed the window with no orphaned processes. This delivers the design doc's Tier 2 promise (agent-launched apps, human's session provably untouched) on GNOME and wlroots, differing only in that the apps live inside one host window rather than mixed among the human's. Cost on a non-KDE host: `kwin_wayland` + `kwin-devel` + the plugin build. Remaining for later phases: a `SYNARA_COMPUTER_BACKEND` override, availability copy naming the missing package on non-KDE hosts, panel copy.
- **Phase B1 — skeleton (done).** `PortalComputerBackend` with the probe, capabilities, `awaiting-consent`, and precise unavailability messages; the shared extractions out of `KWinComputerBackend` and `nestedKWinSession`; no behavior change on KDE, regression-tested. Landed 2026-08-17: the probe is side-effect-free and never throws, capabilities derive from resolved providers rather than the probe's optimism, selection is `SYNARA_COMPUTER_BACKEND` override → `SYNARA_COMPUTER_NESTED` → `org.kde.KWin` on the bus → portal with no fallback in any direction, and a KDE host with no new env vars still constructs a bare `KWinComputerBackend` (pinned by test). Two working notes for B2: `getState()` requires the window provider because `ComputerState.windows` cannot express "unknown" (coordinate-only workflow is `getScreenSize` + region capture), and every wlroots capability is gated on the native desktop helper existing, since Wayland global enumeration has no Node binding.
- **Phase B2 — wlroots providers plus the headless-sway lane (done).** No portal, no consent, all four capabilities, and fully CI-testable. Deliberately before GNOME: it proves the provider architecture against a real compositor in CI. Landed 2026-08-17: one native C helper (`apps/server/native/computer-desktop-helper`, built by its `build.sh` into `~/.local/share/synara/computer/`) holds the single `wl_display` for virtual input, screencopy compositing/PNG encoding, and foreign-toplevel listing, speaking newline-framed JSON-RPC on stdio plus length-prefixed capture frames on fd 3; `DesktopHelperClient` supervises it with AT-SPI-shaped restart backoff and distinguishes "the compositor refuses this protocol" (non-retryable, no restart) from transport death (restart). The three helper-backed providers share one refcounted helper (`shareDesktopHelper`); wl-clipboard needs none. Foreign-toplevel reports no geometry — `providesBounds: false`, so window-scoped capture refuses honestly and the working pattern is desktop coordinates. Probe accepts `ext_data_control_manager_v1` alongside the zwlr name (wlroots 0.18+/KWin/Mutter 48 dropped the old one — proven by a live KWin run). A missing helper build blames `build.sh`/`SYNARA_COMPUTER_HELPER`, never the desktop. The live sway lane is `SYNARA_NESTED_WLROOTS_TEST=1 bun run test src/computer/portal/wlrootsSession.integration.test.ts` and needs `sway` + `foot` installed. The C helper survived an adversarial review (20 findings, all fixed before landing): the capture loop plans its per-output pieces before any dispatch and re-resolves each by registry name so an output unplugged mid-capture is a transient refusal rather than a use-after-free; any frame- or control-channel write failure is fatal by design (neither stream can resync; the client's restart is the recovery); all numeric input is range-checked at the dispatch edge with geometry math in int64; outbound strings are UTF-8-validated with U+FFFD substitution; and JSON-RPC errors carry a permanent (-32001) vs transient (-32002) split the client maps to `retryable`. `build.sh SANITIZE=1` builds with ASan/UBSan (needs libasan/libubsan); an ASan pass under the live sway lane is still owed. Deferred to B3 as planned: `sharedSeatArbiter` (needs `ext_idle_notifier_v1`), and the open question of AT-SPI as a fifth provider for window geometry on wlroots.
- **Phase B3 — GNOME portal providers** behind the fake-portal service, then the live spike. In progress; five decisions deviate from this plan and are recorded here rather than silently. (1) **Input on GNOME is the RemoteDesktop portal itself, not libei.** `Start`'s response carries the joined ScreenCast stream's `position` and `size`, so `NotifyPointerMotionAbsolute` has a coordinate space without opening PipeWire at all — GNOME input ships complete in B3, and only the pixels are gated. `PortalSession.connectToEIS()` returns the EIS fd and nothing consumes it yet; whether libei is worth adopting is now a latency question for the live spike, not a prerequisite. (2) **Capture stays unresolved with a named native gap**, because the build box has no `pipewire-devel` and a partially-wired capture provider would be the "resolved but empty" state this architecture exists to prevent. (3) **The fake portal is an in-process `PortalBus` fake, not a private `dbus-daemon`.** The whole session lifecycle (grant, latched denial, revocation mid-action, version downgrade, out-of-order Response, `Request.Close` on a stalled call, `handle_token` misdirection) is driven through the production client code with no system daemon, so the lane is always on rather than CI-only. A live-bus lane remains worth adding when a GNOME box exists. (4) **Restore tokens live in `portal-restore-tokens.json` keyed by `{desktop, deviceTypes, screencast}`**, not `portal-grants.json` keyed by `{desktop, portalVersion}`: a token issued for a keyboard-only grant does not restore a pointer grant, and the portal version does not identify what was granted. Mode 0600 comes from the existing atomic-write helper. (5) **The resolver is `portalSessionProviders.ts` and selects on the plan, not the desktop name** — any portal advertising the interfaces gets the providers, which is what the probe already decides. The live checklist for the spike is `docs/computer-use-gnome-live-checklist.md`.
- **Phase B4 — GNOME Shell extension** for enumeration, activation, and raise.
- **Phase B5, optional** — Hyprland IPC window provider; wlroots layer-shell ghost marker. An X11 provider set (XTEST, EWMH stacking, XComposite) is the cheapest coverage per user of anything here and drops into the same architecture, but it is out of the Wayland scope.

## Unknowns that need a live GNOME session

1. Whether mutter maps libei absolute motion to the joined ScreenCast stream's region, and whether one merged dialog covers devices and sources. This decides whether the coordinate contract survives.
2. Whether the extension's `get_frame_rect()` coordinates equal the stream's coordinate space under fractional scaling and multiple monitors. A mismatch reproduces the run-2 clamp bug exactly; the top correctness risk.
3. libei device lifecycle: availability latency after `Start`, and behavior at screen lock (input must fail loudly, never queue).
4. Whether `persist_mode: 2` survives logout, and whether the token binds to a specific monitor selection.
5. AT-SPI on GNOME: registry reachability without `toolkit-accessibility`, and whether extents are frame-relative as expected. This decides whether semantic targeting exists on GNOME at all.
6. `ext-data-control` presence for `wl-paste` on the target GNOME version.
7. PipeWire crop-plus-downscale throughput at 5120×2520-class desktops against the 500 ms still poll.
