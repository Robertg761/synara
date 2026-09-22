# Computer use on Linux

How the server chooses and hosts a Linux desktop backend. The Cua host (the
macOS beta, and observation-only on Linux) is described in
[computer-use-cua](computer-use-cua/README.md); the native Linux backends share
Synara's computer-use core with it and are documented here, one section per
backend.

## Seat policy

One rule outranks every other decision here: the agent never drives the seat
the human is sitting at. A Linux backend gives the agent a cursor and an input
path of its own and leaves the human's pointer, keyboard focus and active
window untouched, or it does not exist. No shared-seat backend is in the tree,
so none can be selected, forced or fallen back to.

## Core seams

The core is shared with the macOS Cua backend and lives in
`apps/server/src/computer/`. The seams a Linux backend plugs into:

- `ComputerBackend.statusAvailability()`: the passive status read for a
  backend whose desktop boots on demand. `ComputerManager.getStatus` uses it
  for every status read when the backend has one, so the settings screen's
  poll never boots or respawns a desktop; the desktop starts again on the next
  real use or from Set up. Backends without it keep the existing behaviour
  (the passive probe before engagement, the establishing read after).
- `ComputerBackend.resetInputDelivery()`: the full seat hand-back the manager
  runs on every desktop lease change and release, where `clearFocusWindow`
  alone would clear only the aim. A compositor seat outlives the thread that
  drove it.
- `ComputerBackend.dedicatedSeat`: the opt-in a backend sets when the agent
  drives the desktop through a seat of its own. The computer service registers
  the manager's `ComputerGuidanceProfile` (dialect plus this flag) for the
  process, because the session-start guidance is rendered by provider adapters
  that never see the backend. A backend that sets nothing keeps the Cua host's
  wording unchanged.
- `ComputerBackend.textRangeSelection`: `false` refuses `computer_select_text`
  in the manager before the lease is claimed and the window restacked and
  aimed for a dispatch the backend would refuse anyway.

## Backend selection

`Layers/ComputerService.ts` resolves the backend once at startup, with no
fallback in any direction once a choice is made:

1. `SYNARA_COMPUTER_BACKEND`, when set. `fake` and `cua` are platform-neutral;
   the Linux tiers are refused off Linux. An unknown value is not ignored: it
   becomes an unavailable backend whose message lists the names that exist, so
   a typo never boots a different backend and looks like the variable does
   nothing. A forced backend that fails stays failed and says why.
2. The Linux detection tiers in `linuxBackendSelection.ts`, best desktop first.
   `LINUX_BACKEND_CHOICES` and the service layer's `LINUX_BACKENDS` factory
   table are filled by the backend layers; each backend registers its choice,
   its detection tier and its constructor together, so the three cannot drift.
3. The Cua host, on macOS or wherever `SYNARA_CUA_HOST_SOCKET` names an
   endpoint. It comes after the Linux tiers on purpose: the desktop app
   configures its host socket on Linux too, so socket presence cannot be what
   decides between a compositor backend and the observation-only Cua host.
4. Otherwise an unavailable backend that says why.

## Backend: KWin plugin (Plasma Wayland)

`KWinComputerBackend.ts` drives `apps/server/native/computer-use-kwin/`, a
`KWin::Plugin` loaded into the human's own `kwin_wayland`. It reports backend
`kwin`, `visibleDesktop: true`, the full capability set, `dedicatedSeat` and
`textRangeSelection: false`. Selected when `org.kde.KWin` is owned on the
session bus and the session is Wayland; Plasma on X11 owns the name too, but
the plugin's dedicated seat exists only on Wayland, so that host is left
unclaimed rather than given a backend that refuses forever.

### Seat policy, as the plugin implements it

- The agent's cursor is a scene overlay item drawn by the plugin, in its own
  colour, with a badge naming the driving thread. It is never the human's
  cursor moved somewhere else.
- The dedicated seat `synara-agent` delivers to clients that bound their
  pointer on it (Qt, GTK). Clients that only bind the first seat (Chromium and
  Electron through Ozone, Xwayland for every X11 client) are driven by direct
  per-client injection onto their own seat0 resources; the human's seat state
  is observed, never changed, and the same-client rule refuses input aimed at
  a surface whose client the human is active in.
- When the human is active in a window, agent actions aimed at that window
  are refused with the retryable token `computer_human_active`, whether the
  compositor or the server raised it.
- `Meta+Shift+Esc` stops the session and latches until pressed again; a plugin
  that could not register the shortcut is reported as a setup blocker rather
  than advertising a hotkey that does not exist.
- Anything that would break the policy is refused rather than approximated:
  protocol drag-and-drop, client-side titlebar moves, modifier-held clicks.

### Plugin contract

The plugin exports the D-Bus object `org.synara.ComputerUse` at
`/org/synara/ComputerUse`, interface `org.synara.ComputerUse1`; `kwinDbus.ts`
(`KWinComputerPluginApi`) is the server-side typing. The server takes the
exclusive bus name `org.synara.ComputerUse.Server`, writes a random token to a
0600 file (`computerSessionAuth.ts`) and calls `authenticate`; every other
method except `healthJson` requires the authenticated caller, and the plugin
drops the caller when the server name changes owner.

- `focusWindow`, `raiseWindow` and `clearFocusWindow` aim keys and scope
  pointer input without activating; `resetInputDelivery` does everything a
  lease hand-over needs in one call and is what the manager runs on every
  lease change, release and emergency stop. The backend runs it only on a
  session that is up: a reset never restarts an idled-out session.
- A locked or inactive session refuses capture and input with
  `SessionLocked`. The backend maps it to a retryable refusal carrying an
  `inputPause` (token `computer_session_locked`) that names the window the
  seat was aimed at, when any; the manager latches the pause until a scoped
  observation of that window — or, for a pause naming no window, an unscoped
  observation with a screenshot — sees the desktop unlocked through
  `checkInputReady`, which reads plugin health through the same checks as the
  establishing read. The transition into the lock is announced once as a
  `desktop-interrupted` event so standing task consent does not carry across
  it.
- Captures render offscreen at the next safe compositor point; the agent's
  cursor is painted in, the human's never is.
- Text selection is refused up front (`textRangeSelection: false`): AT-SPI
  exposes no settable selection this backend can read back, and nothing
  approximates it.

### Guidance

The backend declares `dedicatedSeat`, and the session-start instructions and
the `linux` help chapter render from that profile: native input available,
`ctrl` chords, `computer_human_active` as the wait-and-retry signal, and no
`computer_browser_*` route. Every other profile keeps the Cua host's text.

### Perception

`atspi_helper.py` is a Python process speaking newline-framed JSON on stdio,
supervised by `AtspiHelperClient` (`atspiClient.ts`) with a request deadline, a
frame cap and bounded restart. Its walk is bounded per window and per
application; partial results carry a marker rather than failing the read.
`atspiTreeTargeting.ts` fuses each tree with the plugin's window bounds into
the desktop-space `ComputerUiNode` tree the manager exposes.

### Provisioning and packaging

Everything except distribution packages installs under the user's home,
without root, from the server process, and only `provision()` (the settings
panel's Set up) installs anything. With no matching prebuilt,
`scripts/install-and-load.sh --build-only` compiles against the local headers
(KWin 6, Qt 6, KF6, ECM; Ubuntu before 24.10 and Debian before 13 are refused
by name). Each install lands as a new `SynaraComputerUsePluginV<n>.so`, since
the compositor keeps a loaded library mapped; the first install on a machine
takes effect at the next login because Qt reads `QT_PLUGIN_PATH` at compositor
start.

Prebuilds come from `.github/workflows/kwin-plugin-prebuilds.yml` (one job per
distribution image and architecture, assembled by
`scripts/assemble-kwin-plugin-prebuilds.mjs` into `manifest.json` with
`kwinVersion`, `arch`, `builtOn`, `file`, `sha256`); `selectPrebuilt` matches
all three fields exactly, with SHA-256 verified before install. The release
builds them inside the release run, best effort: prebuilds never block or
delay a release. A distribution the matrix cannot build is skipped and
reported, and a prebuild run that fails or finishes late leaves the packaging
jobs to ship with a `::warning::`; the users concerned keep the source-build
fallback. The binaries never enter the portable build, which every packaging
job verifies native-free: the Linux desktop leg polls for the artifact after
the verified import — stopping as soon as the prebuild jobs have concluded —
and passes it to the desktop build (`--kwin-plugin-prebuilt-dir`), which
stages it under the packaged server dist, and the CLI and server-tarball jobs
stage it into the restored dist when the prebuild run succeeded. No packaging
job waits on or is gated by the prebuild matrix.

The AT-SPI helper and the plugin sources ship outside ASAR
(`LINUX_COMPUTER_USE_ASAR_UNPACK_GLOBS`): python3, bash and cmake read them off
the disk. `apps/server/scripts/cli.ts` copies both into `dist/`,
`scripts/release-smoke.ts` checks the packaging, and the packaged runtime smoke
loads `dbus-next` the way the backend does.

Environment: `SYNARA_KWIN_PLUGIN_DIR`, `SYNARA_KWIN_PREBUILT_DIR`,
`SYNARA_KWIN_SOURCE_DIR`, `SYNARA_KWIN_STATE_ROOT` override paths;
`SYNARA_COMPUTER_IDLE_TIMEOUT_MS` and `SYNARA_COMPUTER_HUMAN_ACTIVE_MS` tune the
session; `SYNARA_ATSPI_PYTHON` and `SYNARA_ATSPI_HELPER` point at the helper.
Every variable the server reads for computer use is listed in `turbo.json`'s
`globalPassThroughEnv`, which turbo strips otherwise in strict mode; a backend
that reads a new one adds it there.

### Testing

Backend tests inject `FakeDbus` and `FakePlugin` (`computerPluginTestDoubles.ts`);
no test touches a real bus or compositor. `atspiHelper.python.test.ts` runs the
helper's own unit tests and its stdio framing against the real interpreter with
a fake `Atspi`. The plugin's fixture tests (`native/computer-use-kwin/tests`)
compile production functions against stub protocol resources. Seat delivery,
the same-client rule, the guard, the shortcut and lock refusal need a live
compositor and are exercised only against a disposable nested `kwin_wayland`.

## Known gaps

- Nothing here is verified against a live compositor by the test suite.
- Keyboard layout support is US-only: text and character keys are refused on
  any other layout; named keys still work.
- No protocol-level drag-and-drop and no client-side titlebar moves; both need
  a button serial on the human's seat. Modified pointer input (modifier plus
  click or scroll) is refused.
- `launchApp` never reports `focusChangedDuringLaunch`: the agent's seat cannot
  take the human's focus, and the backend does not observe whether the
  application activated itself.
- X11 sessions are unsupported; Xwayland clients inside a Wayland session are
  in scope, except that their override-redirect menus are not pointer targets
  on KWin.
- The plugin is built per compositor version, so every KWin release needs a
  new build; a KWin upgrade leaves no plugin loaded until the next login
  provisions one.
