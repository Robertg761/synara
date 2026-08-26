# Computer use, Phase 0 results

Status: **Phase 0 proven on real hardware, including live synthetic input.** 2026-08-15.
Reference machine: Fedora, KDE Plasma 6.7.3, KWin 6.7.3, Wayland session.
Design doc: `docs/computer-use-design.md`. Plugin source: `apps/server/native/computer-use-kwin/`.

## What Phase 0 had to prove

The whole Tier 1 architecture rests on one claim: a KWin plugin can run inside
the compositor, paint its own cursor, and route input to a chosen window without
moving the real pointer. If that claim were false, the macOS-equivalent path
would be dead and we would fall back to the lesser tiers. Phase 0 exists to test
that claim as cheaply as possible before any Synara integration is written.

It passed. The mechanism is real on this machine.

## The build → load → verify chain

1. **Build.** The plugin under `apps/server/native/computer-use-kwin/` compiles
   cleanly against the installed `kwin-devel` 6.7.3 headers with CMake + Ninja,
   C++23, linking `KWin::kwin`, `KF6::CoreAddons`, and Qt6 Core/DBus/Gui/Quick/Widgets.
   Output: `SynaraComputerUsePlugin.so`.

2. **Install.** Copied to the KWin plugin search path,
   `/usr/lib64/qt6/plugins/kwin/plugins/SynaraComputerUsePlugin.so`.

3. **Load.** Loaded into the live KWin session over D-Bus:

   ```sh
   busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins LoadPlugin s SynaraComputerUsePlugin
   # → b true
   ```

   The plugin registered its own D-Bus service `org.synara.ComputerUse` at
   `/org/synara/ComputerUse`, interface `org.synara.ComputerUse1`.

4. **Verify (read-only).** Introspection calls against the live desktop:
   - `healthJson` → `ok: true, overlay: true, workspace: true, effects: true, running: false`.
     The plugin reached KWin's scene overlay, the workspace, and the effects
     system, so it has every handle it needs to draw a cursor and route input.
   - `windowsJson` → enumerated the real open windows with their titles, bounds,
     and owning PIDs, correctly spanning all three physical monitors.
   - `stateJson` → confirmed no agent session active (`running: false`), no
     latched buttons or keys.

5. **Unload.** Removed cleanly:

   ```sh
   busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins UnloadPlugin s SynaraComputerUsePlugin
   ```

   The `org.synara.ComputerUse` service unregistered on unload. No stuck state,
   no session disruption.

## Live input demo, user-approved

The spike itself stopped at read-only introspection; synthetic input at live
windows waited for the user's go-ahead. The user approved it and the demo ran
the same day, end to end, on the real desktop:

1. Launched `kcalc` with `QT_ACCESSIBILITY=1` and found its window through the
   plugin's `windowsJson` (id, frame bounds `956,1519 648x518`, pid).
2. Located targets through AT-SPI. One Wayland wrinkle: clients do not know
   their global position, so kcalc's AT-SPI extents are frame-relative fiction
   (its frame claimed `0,1080`). The fix is to compose the two sources: take
   widget layout from AT-SPI, take true window bounds from the plugin, and add
   the decoration offset. The plugin frame was 648x518 against a 640x480 client
   area, giving a `(+4, +34)` client origin. Every computed target hit.
3. `start` showed the agent ghost cursor, `focusWindow` pinned kcalc, and eased
   `movePointer` glides moved the visible cursor across the screen.
4. Clicked the Seven button (`button 272 press/release`, BTN_LEFT). kcalc's
   display, read back over AT-SPI, showed `7`.
5. Typed 8 through the keyboard path (`key 9`, evdev KEY_8). Display: `78`.
6. Clicked Multiply, typed 6, clicked Equals. Display: `468`. 78 × 6 = 468.
7. `stop` released all state, kcalc was closed, and `UnloadPlugin` removed the
   plugin. The `org.synara.ComputerUse` service unregistered.

The user's real pointer was never touched. Both input paths, per-surface
pointer injection and compositor keyboard delivery, are now proven against a
real Wayland client with programmatic verification, not just eyeballs.

Two findings for the Tier 1 backend:

- **Targeting must fuse AT-SPI layout with plugin window bounds.** Neither
  source alone gives global widget coordinates on Wayland. The
  `atspiTreeTargeting` module planned in the design doc owns this composition,
  including the decoration offset derived from frame-vs-client size.
- **The current implementation shares the one seat, so agent and user contend
  for focus.** The pointer path redirects the seat's pointer focus to the
  target (`notifyPointerEnter`), and the user's next real mouse motion grabs it
  back; the keyboard path is worse, routing through
  `input()->keyboard()->processKey` after pointing seat keyboard focus at the
  target, so keystrokes land wherever the seat points at that instant. The
  user's cursor never moves, which is the visible half of the promise, but
  true simultaneous non-interference needs the events delivered per-client
  (a second `SeatInterface`, or direct sends to the target's own input
  resources) rather than time-sharing the real seat. That is the main Phase 3
  engineering item, and the design doc's mechanism section describes exactly
  that end state. A second live run, with the user actively using the desktop,
  demonstrated both directions of the contention: the agent's `key()` events
  went to the user's active window instead of the target, and the user's real
  keystrokes were captured into kcalc after agent clicks re-pointed seat
  keyboard focus there. Pointer clicks landed correctly in both runs; the
  pointer path only holds focus while the user's mouse is still.
  **Resolved the same day; see "The fix: a dedicated agent seat" below.**

## The fix: a dedicated agent seat

The seat contention was fixed immediately rather than deferred to Phase 3. The
plugin now creates its own `SeatInterface` named `synara-agent` on the Wayland
display (public KWin API, constructor takes the display and a name) instead of
borrowing `waylandServer()->seat()`. Wayland toolkits handle seats appearing at
runtime, so every client picks up the new seat's pointer and keyboard without a
restart.

- Pointer and keyboard events are delivered on the agent seat only. The user's
  real seat is never touched, in either direction: agent keys cannot land in
  the user's window, and user keys cannot be captured by the agent's target.
- The agent seat mirrors the real keyboard's xkb keymap
  (`xkb_keymap_get_as_string` from `input()->keyboard()->xkb()->keymap()` into
  `KeyboardInterface::setKeymap`), and the plugin tracks its own `xkb_state`,
  sending correct modifier events for the agent's key stream.
- Keys go through `SeatInterface::notifyKeyboardKey` on the agent seat, no
  longer through `input()->keyboard()->processKey`, so KWin's real keyboard
  pipeline is out of the loop entirely.

Verified live: the full kcalc demo (clicks and keyboard mixed, 78 × 6 = 468)
ran on the dedicated seat with correct results, with the desktop in normal use.

One new operational finding: **KWin pins a plugin library once loaded.** After
`UnloadPlugin`, reloading the same plugin id serves the still-mapped old
binary; a rebuilt `.so` under the same name never takes effect. On Wayland,
KWin is the session, so "restart the compositor" is not an iteration strategy.
The workaround is a versioned plugin filename per build during development
(`SynaraComputerUsePluginV2.so`, ...). The production installer should pick one
canonical name, since users load a given build once, but the dev loop and the
auto-rebuild units must version the filename.

## The one real finding: KWin ABI drift

KWin's internal API is not ABI-stable, exactly as the design doc's "honest costs"
section warned. Two concrete instances:

1. **Version-pinned load refusal.** A plugin built against an older KWin refuses
   to load into 6.7.3. The journal reports `has mismatching plugin version`. The
   factory IID carries the KWin version, and the running KWin checks it. This is
   the Linux twin of macOS private APIs breaking between releases, and it is the
   main ongoing tax. Mitigation stands: rebuild per KWin version, keep the plugin
   small, gate on a version check.

2. **`ItemRenderer::createImageItem()` removed.** KWin 6.7 dropped that factory
   method. `ImageItem` now has a public constructor instead. The fix, mirroring
   KWin's own `CursorItem::refresh()`:

   ```cpp
   // KWin 6.7 removed ItemRenderer::createImageItem(); ImageItem now has a
   // public constructor. This mirrors KWin's own CursorItem::refresh().
   if (!m_imageItem) {
       m_imageItem = std::make_unique<ImageItem>(this);
   }
   ```

   This was the only source change needed to bring the reference implementation
   forward to 6.7.3.

## Correction to the design doc's ghost-cursor mechanism

Phase 0 confirmed the working ghost cursor is a **KWin scene overlay `Item`**
(`ShapeCursorSource` + `ImageItem`, z=1000, parented to
`effects->scene()->overlayItem()`), matching KWin's own `CursorItem`. It is not a
`zwlr_layer_shell_v1` surface, which is what the original design draft assumed.
Drawing inside the scene is simpler and correct because the plugin already lives
in the compositor. `docs/computer-use-design.md` has been updated to match.

## Reference implementation

The Synara plugin was seeded from a proven prior implementation in the sibling
`Androdex-Desktop` project by the same author, then renamed and updated for KWin
6.7.3. Androdex also carries TypeScript-side drivers
(`LinuxWaylandDriver`, `LinuxX11Driver` + MPX, `VirtualDisplayDriver`) and a
`ComputerUseManager` / `ComputerUsePolicy` that map closely onto the tiered
backend and manager described in the design doc. It is the concrete reference for
Phases 1 through 4.

## What Phase 0 unblocks

The Tier 1 mechanism is proven end to end: build, load, introspect, ghost
cursor, pointer clicks, keyboard input on a dedicated agent seat, verified
result, clean unload. The seat-contention problem that would have been Phase
3's hardest item is already fixed. The roadmap proceeds as written. Next is
Phase 1: contracts, `ComputerManager`, `FakeComputerBackend`, the opt-in
`computer:control` capability, `computerTools.ts`, and the shared stdio
JSON-RPC and frame-transport extractions, all runnable in CI with no display.
The live plugin then grows into the Tier 1 backend in Phases 2 and 3.
