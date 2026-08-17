/**
 * Synara computer-use GNOME Shell extension.
 *
 * GNOME is the one desktop in Synara's Tier 2 set with no client-visible window
 * model at all: no Wayland client can ask mutter what windows exist, where they
 * are, or which one is focused, and AT-SPI extents are frame-relative rather
 * than global. Everything else Tier 2 needs — input, capture, clipboard — has a
 * portal or an unprivileged protocol behind it. Windows do not. So this
 * extension is the GNOME analogue of Synara's KWin plugin: a small amount of JS
 * running *inside* the compositor, exposing exactly the four window operations
 * the agent loop needs (list, activate, raise, close) and nothing else.
 *
 * Deliberate non-goals, because each one would widen the trust surface for no
 * gain: no input injection (libei through the RemoteDesktop portal does that),
 * no screen capture (the ScreenCast portal does that), no eval, no arbitrary
 * property access, no signal subscriptions, no timers. The service is stateless
 * between calls, so `disable()` has nothing to leak.
 *
 * The window document this emits is byte-for-byte the one Synara's KWin plugin
 * emits from `windowsJson`, so the server parses both with a single parser
 * (`computerGeometry.parseWindows`) and an agent's coordinates mean the same
 * thing on either desktop.
 */
import Gio from "gi://Gio";
import Meta from "gi://Meta";
import Shell from "gi://Shell";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

/**
 * Wire-protocol version, answered by `Version()`.
 *
 * The server refuses to use an extension whose protocol it does not speak
 * rather than guessing, because a silently mismatched window document is the
 * failure that puts a click on the wrong monitor. Bump this whenever the JSON
 * document or a method signature changes in a way an older server would
 * misread; do not bump it for additive fields an older server ignores.
 */
const PROTOCOL_VERSION = 1;

const BUS_NAME = "org.synara.ComputerUse";
const OBJECT_PATH = "/org/synara/ComputerUse";
const INTERFACE_NAME = "org.synara.ComputerUse1";

const INTERFACE_XML = `
<node>
  <interface name="${INTERFACE_NAME}">
    <method name="Version">
      <arg type="i" direction="out" name="version"/>
    </method>
    <method name="ListWindows">
      <arg type="s" direction="out" name="windowsJson"/>
    </method>
    <method name="ActivateWindow">
      <arg type="s" direction="in" name="windowId"/>
    </method>
    <method name="RaiseWindow">
      <arg type="s" direction="in" name="windowId"/>
    </method>
    <method name="CloseWindow">
      <arg type="s" direction="in" name="windowId"/>
    </method>
  </interface>
</node>`;

/**
 * A failure the caller is meant to read.
 *
 * GJS turns an exception thrown out of a wrapped D-Bus method into a D-Bus
 * error reply, using `error.name` as the error name when it contains a dot.
 * Naming it after the interface keeps the reply an honest refusal with the
 * message intact — which is the whole contract here, because the alternative
 * (answering with an empty window list) is the lie that had an agent relaunch
 * the same application until its turn ended.
 */
class ComputerUseError extends Error {
  constructor(message) {
    super(message);
    this.name = `${INTERFACE_NAME}.Failed`;
  }
}

/**
 * A timestamp mutter will accept for activation.
 *
 * `global.get_current_time()` answers with the timestamp of the event being
 * processed, and a D-Bus call is not an event, so it answers 0 — which
 * mutter's focus-stealing prevention may refuse. The roundtrip call exists for
 * exactly this case and gives a real server timestamp.
 */
function currentTime() {
  const eventTime = global.get_current_time();
  if (eventTime !== 0) return eventTime;
  const display = global.display;
  if (typeof display?.get_current_time_roundtrip === "function") {
    return display.get_current_time_roundtrip();
  }
  return 0;
}

/**
 * Every window actor, bottom of the stack first.
 *
 * Two spellings because the accessor moved: gnome-shell has carried
 * `global.get_window_actors()` since 3.x, and newer mutter also exposes it on
 * the compositor object. Feature detection rather than a shell-version check,
 * since the version is a packaging fact and the method either exists or does
 * not.
 */
function windowActors() {
  if (typeof global.get_window_actors === "function") return global.get_window_actors();
  const compositor = global.compositor;
  if (typeof compositor?.get_window_actors === "function") return compositor.get_window_actors();
  throw new ComputerUseError(
    "This GNOME Shell exposes neither global.get_window_actors() nor " +
      "global.compositor.get_window_actors(), so windows cannot be enumerated. " +
      "Update the Synara GNOME Shell extension (synara-computer-use@synara.dev).",
  );
}

function metaWindowOf(actor) {
  if (typeof actor?.get_meta_window === "function") return actor.get_meta_window();
  return actor?.meta_window ?? null;
}

/**
 * The managed windows, topmost first.
 *
 * `sort_windows_by_stacking` is asked first because it is mutter's own answer
 * to "what is above what", and stacking is what `stackingIndex` and
 * `occludedBy` claim to report. The actor order is the same order in every
 * shell that has shipped, but it is documented nowhere, so it is the fallback
 * rather than the source.
 *
 * Override-redirect surfaces (menus, tooltips, drag icons) are dropped: they
 * cannot be activated, raised, or closed, and listing something the other three
 * methods refuse is a window model that lies about itself.
 */
function stackedWindows() {
  const windows = [];
  for (const actor of windowActors()) {
    const window = metaWindowOf(actor);
    if (!window) continue;
    if (typeof window.is_override_redirect === "function" && window.is_override_redirect())
      continue;
    windows.push(window);
  }
  const display = global.display;
  const sorted =
    typeof display?.sort_windows_by_stacking === "function"
      ? display.sort_windows_by_stacking(windows)
      : windows;
  // Reversed by hand rather than with `reverse`/`toReversed`: `sorted` may be a
  // list mutter handed back, and neither mutating it nor assuming a recent
  // Array method is worth the shortening.
  const topmostFirst = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) topmostFirst.push(sorted[index]);
  return topmostFirst;
}

/**
 * The id the server addresses a window by, stable for the window's lifetime.
 *
 * `get_stable_sequence()` is mutter's own per-window serial: it is assigned on
 * creation, never reused while the window lives, and — unlike an XID, a
 * Wayland surface id, or the window's index in any list — it does not change
 * when the window is remapped, moved between workspaces, or re-parented.
 */
function windowId(window) {
  return String(window.get_stable_sequence());
}

/** Whether the window is currently drawn somewhere the user could click it. */
function isVisible(window) {
  if (window.minimized) return false;
  if (typeof window.showing_on_its_workspace === "function") {
    return window.showing_on_its_workspace();
  }
  return true;
}

function isMaximized(window) {
  if (typeof window.get_maximized !== "function") return false;
  const flags = window.get_maximized();
  const both = Meta.MaximizeFlags.BOTH;
  return (flags & both) === both;
}

/**
 * The application id, preferring the `.desktop` id the shell resolved, because
 * that is the same identity `computer.launchApp` launches by. `wm_class` is
 * the last resort and is reported separately as `resourceClass` regardless, so
 * a caller matching on either one finds it.
 */
function applicationId(window) {
  try {
    const app = Shell.WindowTracker.get_default()?.get_window_app(window);
    const id = app?.get_id?.();
    if (id) return id;
  } catch {
    // A tracker that cannot resolve an app is not a reason to fail the list.
  }
  if (typeof window.get_gtk_application_id === "function") {
    const gtkId = window.get_gtk_application_id();
    if (gtkId) return gtkId;
  }
  if (typeof window.get_sandboxed_app_id === "function") {
    const sandboxed = window.get_sandboxed_app_id();
    if (sandboxed) return sandboxed;
  }
  return resourceClass(window);
}

function resourceClass(window) {
  if (typeof window.get_wm_class === "function") return window.get_wm_class() ?? "";
  return "";
}

function windowTypeName(window) {
  if (typeof window.get_window_type !== "function") return "unknown";
  const type = window.get_window_type();
  for (const [name, value] of Object.entries(Meta.WindowType)) {
    if (value === type) return name.toLowerCase();
  }
  return "unknown";
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The window list as JSON, topmost first.
 *
 * Topmost-first is load-bearing twice over: `stackingIndex` then reads as
 * depth (0 is on top), and each window's occluders are exactly the windows
 * already emitted, so occlusion is one pass. The overlap test is frame-rect
 * intersection rather than true pixel occlusion — a translucent or shaped
 * window above still counts — because overstating it is the safe direction:
 * the remedy, scoping the click to a window, is the same either way.
 */
function windowsJson() {
  const covering = [];
  const entries = [];
  let stackingIndex = 0;
  for (const window of stackedWindows()) {
    const id = windowId(window);
    const frame = window.get_frame_rect();
    const bounds = {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
    };
    const visible = isVisible(window);
    const occludedBy = [];
    for (const above of covering) {
      if (rectsIntersect(above.bounds, bounds)) occludedBy.push(above.id);
    }
    const pid = typeof window.get_pid === "function" ? window.get_pid() : 0;
    entries.push({
      id,
      title: window.get_title() ?? "",
      appId: applicationId(window),
      resourceClass: resourceClass(window),
      pid: pid > 0 ? pid : 0,
      bounds,
      visible,
      minimized: window.minimized === true,
      maximized: isMaximized(window),
      fullscreen: typeof window.is_fullscreen === "function" ? window.is_fullscreen() : false,
      focused: window.has_focus(),
      // On mutter the focused window *is* the activated one: there is a single
      // focus window per display and toolkits gate shortcut dispatch on it.
      // Reported separately anyway so the field means the same thing here as
      // it does on KWin, where the two can differ.
      active: window.has_focus(),
      windowType: windowTypeName(window),
      monitor: typeof window.get_monitor === "function" ? window.get_monitor() : -1,
      stackingIndex,
      occludedBy,
    });
    stackingIndex += 1;
    if (visible) covering.push({ id, bounds });
  }
  return JSON.stringify(entries);
}

function lookupWindow(id) {
  if (typeof id !== "string" || id.length === 0) {
    throw new ComputerUseError("A window id is required.");
  }
  for (const window of stackedWindows()) {
    if (windowId(window) === id) return window;
  }
  throw new ComputerUseError(
    `No window with id ${JSON.stringify(id)} exists on this desktop. ` +
      "It was closed, or the id came from a different session; call ListWindows again.",
  );
}

/**
 * The D-Bus surface, exactly five methods wide.
 *
 * Method names match the interface XML because `wrapJSObject` dispatches by
 * name.
 */
class SynaraComputerUseService {
  Version() {
    return PROTOCOL_VERSION;
  }

  ListWindows() {
    return windowsJson();
  }

  /**
   * Focus a window, moving the human's keyboard focus with it — on GNOME there
   * is one seat and no way around that. `Main.activateWindow` rather than
   * `Meta.Window.activate` because a window on another workspace has to have
   * its workspace activated first, and because it is the path the shell's own
   * UI takes, so an agent's activation behaves like a click on the dash.
   */
  ActivateWindow(id) {
    Main.activateWindow(lookupWindow(id), currentTime());
  }

  /**
   * Restack without touching focus. The point of having it separate: a click
   * only needs the target to be the topmost window at that coordinate, and
   * stealing focus for that is a bigger interruption than the action.
   */
  RaiseWindow(id) {
    const window = lookupWindow(id);
    if (typeof window.raise === "function") {
      window.raise();
      return;
    }
    // mutter has been moving `raise` towards workspace-aware spellings; take
    // whichever this build has rather than pinning a shell version.
    if (typeof window.raise_and_make_recent_on_workspace === "function") {
      window.raise_and_make_recent_on_workspace(window.get_workspace());
      return;
    }
    if (typeof window.raise_and_make_recent === "function") {
      window.raise_and_make_recent();
      return;
    }
    throw new ComputerUseError(
      "This mutter build exposes no way to raise a window without focusing it. " +
        "Update the Synara GNOME Shell extension (synara-computer-use@synara.dev), or use ActivateWindow.",
    );
  }

  /** A polite close: the client gets its close request and may still refuse. */
  CloseWindow(id) {
    lookupWindow(id).delete(currentTime());
  }
}

export default class SynaraComputerUseExtension extends Extension {
  enable() {
    this._impl = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, new SynaraComputerUseService());
    // Export before owning the name, so a client that sees the name owned can
    // always reach the object: the name appearing is Synara's readiness signal.
    this._impl.export(Gio.DBus.session, OBJECT_PATH);
    this._nameId = Gio.bus_own_name_on_connection(
      Gio.DBus.session,
      BUS_NAME,
      Gio.BusNameOwnerFlags.NONE,
      null,
      () => {
        console.warn(
          `${BUS_NAME} was lost to another owner; Synara window control is inactive in this session.`,
        );
      },
    );
  }

  disable() {
    // Order mirrors enable: drop the name first so no call arrives at an
    // object that is about to go, then unexport. `flush` lets replies already
    // queued reach their callers instead of being dropped mid-flight.
    if (this._nameId) {
      Gio.bus_unown_name(this._nameId);
      this._nameId = 0;
    }
    if (this._impl) {
      this._impl.flush();
      this._impl.unexport();
      this._impl = null;
    }
  }
}
