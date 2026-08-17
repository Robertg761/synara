/**
 * What this desktop can be driven with, established without touching it.
 *
 * The probe is the first thing Tier 2 does and the only thing it is allowed to
 * do unasked, so it is held to two rules. It is **side-effect free**: it reads
 * environment variables, asks the session bus which names are owned, reads two
 * properties, enumerates Wayland globals on a throwaway connection, and stats a
 * file. It never opens a portal session — a `RemoteDesktop.CreateSession` puts
 * a consent dialog on the user's screen, and a dialog nobody asked for at
 * server boot is exactly the behavior the "never at boot, never at probe" rule
 * exists to prevent. And it **never throws**: every step that fails becomes a
 * recorded gap, because a probe that rejects turns one missing package into a
 * backend that cannot explain itself.
 *
 * The output is a decision table, not a backend. `planPortalProviders` turns it
 * into a provider choice per capability, and that pair is what the unit tests
 * pin: the mapping from a desktop's observable facts to the exact sentence the
 * user is shown.
 */
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

import { KWIN_SERVICE } from "../kwinDbus.ts";
import { readSessionBusProperty, sessionBusNameHasOwner } from "../sessionBusNames.ts";
import { unwrapDbusValue } from "../computerGeometry.ts";
import { readWaylandGlobals } from "./desktopHelperClient.ts";
import type { PortalCapabilitySlot, PortalProviderId } from "./providers.ts";

/** Bus name of the portal front-end every portal backend registers behind. */
export const PORTAL_BUS_NAME = "org.freedesktop.portal.Desktop";
export const PORTAL_OBJECT_PATH = "/org/freedesktop/portal/desktop";
export const PORTAL_REMOTE_DESKTOP_INTERFACE = "org.freedesktop.portal.RemoteDesktop";
export const PORTAL_SCREENCAST_INTERFACE = "org.freedesktop.portal.ScreenCast";
/**
 * The GNOME Shell extension's bus name. Deliberately the same name and
 * interface the KWin plugin owns: the extension exposes the identical
 * `windowsJson` payload so `parseWindows` is reused verbatim rather than
 * reimplemented per desktop.
 */
export const SYNARA_DESKTOP_EXTENSION_BUS_NAME = "org.synara.ComputerUse";

/** `AvailableDeviceTypes` bit flags from the RemoteDesktop portal spec. */
export const REMOTE_DESKTOP_DEVICE_KEYBOARD = 1;
export const REMOTE_DESKTOP_DEVICE_POINTER = 2;
export const REMOTE_DESKTOP_DEVICE_TOUCHSCREEN = 4;

/**
 * Wayland globals the wlroots provider set needs. Names, not versions: a global
 * that is advertised at all is what decides whether the provider exists, and
 * the version negotiation belongs to the provider that binds it.
 */
export const WLROOTS_GLOBALS = {
  virtualPointer: "zwlr_virtual_pointer_manager_v1",
  virtualKeyboard: "zwp_virtual_keyboard_manager_v1",
  screencopy: "zwlr_screencopy_manager_v1",
  foreignToplevel: "zwlr_foreign_toplevel_management_v1",
  idleNotify: "ext_idle_notifier_v1",
  dataControl: "zwlr_data_control_manager_v1",
  /**
   * The upstreamed successor. wlroots 0.18+, KWin, and Mutter 48 advertise this
   * and are dropping the wlr name, and wl-clipboard 2.2+ speaks either, so a
   * check for only the older one would call a working clipboard unsupported.
   */
  extDataControl: "ext_data_control_manager_v1",
} as const;

/**
 * Which desktop this is, decided by what is actually running rather than by
 * `XDG_CURRENT_DESKTOP`, which a user can set to anything and a login manager
 * often gets wrong. The env var is the last resort, not the first.
 */
export type DesktopKind = "kde" | "gnome" | "wlroots" | "unknown";

/** One thing the probe looked for and did not find, with what to do about it. */
export interface PortalProbeGap {
  readonly step: string;
  readonly message: string;
}

export interface PortalProbe {
  /** `wayland`, `x11`, or empty when nothing said. Lowercased. */
  readonly sessionType: string;
  readonly desktop: DesktopKind;
  /** Whether the compositor owns `org.kde.KWin`, which is what selects Tier 1. */
  readonly kwinPresent: boolean;
  /** `false` when the session bus itself could not be reached. */
  readonly sessionBusReachable: boolean;
  readonly portal: {
    readonly present: boolean;
    readonly remoteDesktopVersion?: number;
    readonly availableDeviceTypes?: number;
    readonly screenCastVersion?: number;
  };
  /** Every Wayland global the throwaway connection saw, or `undefined` if it failed. */
  readonly waylandGlobals?: readonly string[];
  /** Whether the Synara desktop extension is loaded and owns its bus name. */
  readonly desktopExtensionPresent: boolean;
  /** Absolute path of the native desktop helper, when it is built and executable. */
  readonly helperBinary?: string;
  readonly wlClipboard: boolean;
  readonly gaps: readonly PortalProbeGap[];
}

/**
 * Everything the probe touches, injected so the decision table is unit-testable
 * with no display, no bus, and no filesystem. Each dependency may reject; the
 * probe converts a rejection into a gap rather than propagating it.
 */
export interface PortalProbeDependencies {
  readonly env?: NodeJS.ProcessEnv;
  /** `org.freedesktop.DBus.NameHasOwner` on the session bus. */
  readonly busNameHasOwner?: (name: string) => Promise<boolean>;
  /** A single `org.freedesktop.DBus.Properties.Get` against the portal object. */
  readonly readPortalProperty?: (
    interfaceName: string,
    propertyName: string,
  ) => Promise<unknown | undefined>;
  /** Global names advertised by the compositor on a throwaway connection. */
  readonly waylandGlobals?: () => Promise<readonly string[]>;
  /** Whether a path exists and is executable. */
  readonly executableExists?: (path: string) => Promise<boolean>;
  /** Whether a bare command name resolves on `PATH`. */
  readonly commandExists?: (command: string) => Promise<boolean>;
}

/**
 * Runs every probe step, in a fixed order, collecting gaps.
 *
 * Steps run sequentially rather than concurrently: they are all cheap, one of
 * them (`kwinPresent`) short-circuits the whole of Tier 2 in the selection path
 * above, and a fixed order makes the gap list read like a checklist an operator
 * can walk down.
 */
export async function probeDesktop(
  dependencies: PortalProbeDependencies = {},
): Promise<PortalProbe> {
  const env = dependencies.env ?? process.env;
  const gaps: PortalProbeGap[] = [];
  const record = (step: string, message: string) => {
    gaps.push({ step, message });
  };

  const sessionType = readSessionType(env);
  if (sessionType !== "wayland") {
    record(
      "session",
      sessionType === ""
        ? "This process is not in a graphical session: neither XDG_SESSION_TYPE nor WAYLAND_DISPLAY is set. " +
            "Start the server from inside the desktop session you want it to drive."
        : `This is an ${sessionType} session, and Synara's desktop control is Wayland-only. ` +
            "Log in to a Wayland session, or use SYNARA_COMPUTER_NESTED=window to run an isolated agent desktop in a window.",
    );
  }

  const busNameHasOwner = dependencies.busNameHasOwner ?? sessionBusNameHasOwner;
  let sessionBusReachable = true;
  const nameOwned = async (name: string): Promise<boolean> => {
    try {
      return await busNameHasOwner(name);
    } catch (error) {
      if (sessionBusReachable) {
        sessionBusReachable = false;
        record(
          "session-bus",
          `The session D-Bus could not be reached (${describe(error)}), so nothing about this desktop could be established. ` +
            "Check DBUS_SESSION_BUS_ADDRESS, or start the server from inside the user session.",
        );
      }
      return false;
    }
  };

  const kwinPresent = await nameOwned(KWIN_SERVICE);
  const portalPresent = await nameOwned(PORTAL_BUS_NAME);
  const desktopExtensionPresent = await nameOwned(SYNARA_DESKTOP_EXTENSION_BUS_NAME);

  let remoteDesktopVersion: number | undefined;
  let screenCastVersion: number | undefined;
  let availableDeviceTypes: number | undefined;
  if (portalPresent) {
    const readProperty = dependencies.readPortalProperty ?? defaultReadPortalProperty;
    const readNumber = async (
      interfaceName: string,
      propertyName: string,
    ): Promise<number | undefined> => {
      try {
        const value = unwrapDbusValue(await readProperty(interfaceName, propertyName));
        return typeof value === "number" && Number.isFinite(value) ? value : undefined;
      } catch {
        // A portal front-end without the interface is the common case here, and
        // it is already reported as the interface being absent below. A read
        // that fails for any other reason is indistinguishable from that at
        // this level, so it is folded into the same gap rather than doubled.
        return undefined;
      }
    };
    remoteDesktopVersion = await readNumber(PORTAL_REMOTE_DESKTOP_INTERFACE, "version");
    screenCastVersion = await readNumber(PORTAL_SCREENCAST_INTERFACE, "version");
    availableDeviceTypes = await readNumber(
      PORTAL_REMOTE_DESKTOP_INTERFACE,
      "AvailableDeviceTypes",
    );
    if (remoteDesktopVersion === undefined) {
      record(
        "portal-remote-desktop",
        `${PORTAL_BUS_NAME} is running but exposes no ${PORTAL_REMOTE_DESKTOP_INTERFACE} interface, so input cannot be injected through it. ` +
          "Install the portal backend for this desktop (xdg-desktop-portal-gnome on GNOME, xdg-desktop-portal-wlr on wlroots).",
      );
    }
    if (screenCastVersion === undefined) {
      record(
        "portal-screencast",
        `${PORTAL_BUS_NAME} exposes no ${PORTAL_SCREENCAST_INTERFACE} interface, so the screen cannot be captured through it. ` +
          "Install the portal backend for this desktop (xdg-desktop-portal-gnome on GNOME, xdg-desktop-portal-wlr on wlroots).",
      );
    }
  } else if (sessionBusReachable) {
    record(
      "portal",
      `No process owns ${PORTAL_BUS_NAME}, so this desktop offers no portals at all. ` +
        "Install and start xdg-desktop-portal plus the backend for your desktop.",
    );
  }

  let waylandGlobals: readonly string[] | undefined;
  if (sessionType === "wayland") {
    try {
      waylandGlobals = await (dependencies.waylandGlobals ?? (() => defaultWaylandGlobals(env)))();
    } catch (error) {
      record(
        "wayland-globals",
        `The compositor's global list could not be read (${describe(error)}), so the unprivileged wlroots protocols could not be detected. ` +
          "This is expected when the native desktop helper is not built; see apps/server/native/computer-desktop-helper.",
      );
    }
  }

  const executableExists = dependencies.executableExists ?? defaultExecutableExists;
  const helperPath = desktopHelperPath(env);
  const helperBinary = (await executableExists(helperPath)) ? helperPath : undefined;
  if (!helperBinary) {
    record(
      "desktop-helper",
      `The native desktop helper is not built at ${helperPath}, so libei input, PipeWire capture, and the wlroots protocols have no transport. ` +
        "Build it with the computer-desktop-helper target, or point SYNARA_COMPUTER_HELPER at an existing build.",
    );
  }

  const commandExists = dependencies.commandExists ?? defaultCommandExists;
  const wlClipboard = (await commandExists("wl-copy")) && (await commandExists("wl-paste"));
  if (!wlClipboard) {
    record(
      "wl-clipboard",
      "wl-copy and wl-paste are not on PATH, so the shared clipboard cannot be read or written. Install the wl-clipboard package.",
    );
  }

  return {
    sessionType,
    desktop: desktopKind({ env, kwinPresent, ...(waylandGlobals ? { waylandGlobals } : {}) }),
    kwinPresent,
    sessionBusReachable,
    portal: {
      present: portalPresent,
      ...(remoteDesktopVersion === undefined ? {} : { remoteDesktopVersion }),
      ...(screenCastVersion === undefined ? {} : { screenCastVersion }),
      ...(availableDeviceTypes === undefined ? {} : { availableDeviceTypes }),
    },
    ...(waylandGlobals ? { waylandGlobals } : {}),
    desktopExtensionPresent,
    ...(helperBinary ? { helperBinary } : {}),
    wlClipboard,
    gaps,
  };
}

/**
 * Which desktop, from strongest evidence to weakest: a compositor that owns a
 * bus name, a compositor-specific socket in the environment, an advertised
 * wlroots-only global, and only then `XDG_CURRENT_DESKTOP`.
 */
export function desktopKind(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly kwinPresent: boolean;
  readonly waylandGlobals?: readonly string[];
}): DesktopKind {
  if (input.kwinPresent) return "kde";
  const env = input.env;
  if (env.HYPRLAND_INSTANCE_SIGNATURE || env.SWAYSOCK || env.WAYFIRE_SOCKET) return "wlroots";
  if (input.waylandGlobals?.includes(WLROOTS_GLOBALS.foreignToplevel)) return "wlroots";
  if (input.waylandGlobals?.includes(WLROOTS_GLOBALS.virtualPointer)) return "wlroots";
  const names = (env.XDG_CURRENT_DESKTOP ?? env.XDG_SESSION_DESKTOP ?? env.DESKTOP_SESSION ?? "")
    .toLowerCase()
    .split(":")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.some((name) => name.includes("gnome"))) return "gnome";
  if (names.some((name) => name.includes("kde") || name.includes("plasma"))) return "kde";
  if (names.some((name) => ["sway", "hyprland", "river", "wayfire", "labwc"].includes(name))) {
    return "wlroots";
  }
  return "unknown";
}

export interface PortalProviderChoice {
  /** The implementation this desktop would use, or absent when none fits. */
  readonly implementation?: PortalProviderId;
  /**
   * Why the capability is unavailable: nothing fits, or the chosen
   * implementation has not been built yet. Absent means the choice is usable.
   */
  readonly blockedBy?: string;
}

export type PortalProviderPlan = {
  readonly [Slot in PortalCapabilitySlot]: PortalProviderChoice;
};

/**
 * The provider each capability would use on the probed desktop.
 *
 * Split from construction on purpose. Which provider fits a desktop is a pure
 * function of the probe and can be pinned by a test today; whether that
 * provider can be *built* depends on which phase has landed. Keeping them
 * apart means the decision table does not have to be rewritten as the
 * implementations arrive, and a user on an unimplemented desktop is told what
 * their desktop would use rather than a flat "unsupported".
 */
export function planPortalProviders(probe: PortalProbe): PortalProviderPlan {
  return {
    input: planInput(probe),
    capture: planCapture(probe),
    windows: planWindows(probe),
    clipboard: planClipboard(probe),
  };
}

/**
 * Whether a slot's choice is this implementation with nothing blocking it.
 *
 * Lives with the plan rather than in each resolver, because it is the one
 * question every resolver asks and three copies of it is three chances for a
 * blocked choice to be built anyway.
 */
export function usesProvider(
  plan: PortalProviderPlan,
  slot: PortalCapabilitySlot,
  implementation: PortalProviderId,
): boolean {
  const choice = plan[slot];
  return choice.implementation === implementation && choice.blockedBy === undefined;
}

function planInput(probe: PortalProbe): PortalProviderChoice {
  if (probe.sessionType !== "wayland") return { blockedBy: sessionGap(probe) };
  if (probe.waylandGlobals?.includes(WLROOTS_GLOBALS.virtualPointer)) {
    return helperBacked("wlroots-virtual-input", probe);
  }
  if (probe.portal.remoteDesktopVersion !== undefined) {
    const devices = probe.portal.availableDeviceTypes;
    if (devices !== undefined && (devices & REMOTE_DESKTOP_DEVICE_POINTER) === 0) {
      return {
        implementation: "portal-remote-desktop",
        blockedBy:
          `${PORTAL_REMOTE_DESKTOP_INTERFACE} reports no pointer device (AvailableDeviceTypes=${devices}), ` +
          "so this portal backend cannot inject pointer input. Update xdg-desktop-portal and its backend for this desktop.",
      };
    }
    // Absolute motion addresses a ScreenCast stream, so a portal with no
    // ScreenCast interface can only offer relative motion — which cannot
    // implement "click the button at this coordinate" at all. Naming that is
    // more useful than resolving a provider whose every click lands elsewhere.
    if (probe.portal.screenCastVersion === undefined) {
      return {
        implementation: "portal-remote-desktop",
        blockedBy:
          `${PORTAL_REMOTE_DESKTOP_INTERFACE} can inject input, but this desktop exposes no ${PORTAL_SCREENCAST_INTERFACE} ` +
          "interface to join the session to, and the portal only offers absolute pointer motion relative to a screen stream. " +
          "Install the xdg-desktop-portal backend for this desktop so it provides ScreenCast.",
      };
    }
    return { implementation: "portal-remote-desktop" };
  }
  return {
    blockedBy:
      "This desktop offers neither the wlroots virtual-pointer protocol nor a RemoteDesktop portal, so there is no way to inject input. " +
      "Install xdg-desktop-portal plus your desktop's backend, or use SYNARA_COMPUTER_NESTED=window to run an isolated agent desktop in a window.",
  };
}

function planCapture(probe: PortalProbe): PortalProviderChoice {
  if (probe.sessionType !== "wayland") return { blockedBy: sessionGap(probe) };
  if (probe.waylandGlobals?.includes(WLROOTS_GLOBALS.screencopy)) {
    return helperBacked("wlr-screencopy", probe);
  }
  if (probe.portal.screenCastVersion !== undefined) return nativeCaptureGap();
  return {
    blockedBy:
      "This desktop offers neither the wlroots screencopy protocol nor a ScreenCast portal, so the screen cannot be captured. " +
      "Install xdg-desktop-portal plus your desktop's backend.",
  };
}

function planWindows(probe: PortalProbe): PortalProviderChoice {
  // The extension and the KWin plugin own the same bus name and never coexist:
  // KWin's presence is what selects Tier 1 in the first place. Requiring its
  // absence here means a KDE host forced into Tier 2 by an override is not
  // handed a GNOME provider to talk to the KWin plugin with — that mismatch is
  // caught lazily by `Version()`, and never reaching it is better.
  if (probe.desktopExtensionPresent && !probe.kwinPresent) {
    return { implementation: "gnome-shell-extension" };
  }
  if (probe.waylandGlobals?.includes(WLROOTS_GLOBALS.foreignToplevel)) {
    return helperBacked("wlr-foreign-toplevel", probe);
  }
  if (probe.desktop === "gnome") {
    return {
      blockedBy:
        "GNOME exposes no client-visible window list, so Synara cannot enumerate windows until the " +
        "synara-computer-use@synara.dev Shell extension is installed and enabled. Until then, use full-screen " +
        "capture and desktop coordinates; window-scoped capture and targeting will refuse.",
    };
  }
  return {
    blockedBy:
      "This desktop exposes no window enumeration: there is no foreign-toplevel protocol and no Synara desktop extension. " +
      "Use full-screen capture and desktop coordinates; window-scoped capture and targeting will refuse rather than return an empty list.",
  };
}

/** Either data-control protocol lets wl-paste read a selection it does not own. */
function hasDataControl(globals: readonly string[] | undefined): boolean {
  return (
    globals?.includes(WLROOTS_GLOBALS.dataControl) === true ||
    globals?.includes(WLROOTS_GLOBALS.extDataControl) === true
  );
}

function planClipboard(probe: PortalProbe): PortalProviderChoice {
  if (probe.wlClipboard && hasDataControl(probe.waylandGlobals)) {
    // No helper: wl-copy and wl-paste are their own Wayland clients.
    return { implementation: "wl-clipboard" };
  }
  if ((probe.portal.remoteDesktopVersion ?? 0) >= 2) return { implementation: "portal-selection" };
  if (!probe.wlClipboard) {
    return {
      blockedBy:
        "wl-copy and wl-paste are not on PATH and this desktop's portal is too old for SelectionRead/SelectionWrite, " +
        "so the clipboard cannot be read or written. Install the wl-clipboard package.",
    };
  }
  return {
    blockedBy:
      "wl-clipboard is installed but this compositor advertises no data-control protocol, and its portal is too old for " +
      "SelectionRead/SelectionWrite. Clipboard access needs wlr-data-control (or ext-data-control on GNOME 48+).",
  };
}

/**
 * A wlroots provider, which is usable exactly when the native helper that
 * speaks the protocol is built.
 *
 * The compositor advertising the global is only half the answer: Node cannot
 * hold a `wl_display`, so an unbuilt helper means the protocol is there and
 * unreachable. Saying which of the two is missing is the difference between a
 * user running one build script and a user concluding their desktop is
 * unsupported.
 */
function helperBacked(implementation: PortalProviderId, probe: PortalProbe): PortalProviderChoice {
  if (probe.helperBinary !== undefined) return { implementation };
  return {
    implementation,
    blockedBy:
      `This desktop would use the ${implementation} provider, but the native desktop helper that speaks ` +
      "the protocol is not built. Build it with apps/server/native/computer-desktop-helper/build.sh, " +
      "or point SYNARA_COMPUTER_HELPER at an existing build.",
  };
}

/**
 * The one Tier 2 gap that is a missing *library*, not missing code.
 *
 * The ScreenCast portal is reachable and its session is already brokered — the
 * granted stream's node id, position, and size come back in the `Start`
 * response, which is what makes absolute pointing work on this desktop today.
 * What is missing is the other half: the frames themselves arrive over
 * PipeWire, and neither Node nor the current native helper can receive them.
 * Saying that precisely is what stops a user concluding GNOME is unsupported.
 */
function nativeCaptureGap(): PortalProviderChoice {
  return {
    implementation: "pipewire-screencast",
    blockedBy:
      "This desktop captures through the ScreenCast portal, which delivers frames over PipeWire, and Synara's native " +
      "desktop helper has no PipeWire support compiled in: it needs the PipeWire development headers present at build " +
      "time (dnf install pipewire-devel / apt install libpipewire-0.3-dev) and a rebuild with " +
      "apps/server/native/computer-desktop-helper/build.sh. Until then this desktop's screen cannot be read; " +
      "SYNARA_COMPUTER_NESTED=window runs an isolated agent desktop that can be captured today.",
  };
}

function sessionGap(probe: PortalProbe): string {
  return probe.sessionType === ""
    ? "This process is not in a graphical session, so there is no desktop to drive."
    : `This is an ${probe.sessionType} session, and Synara's desktop control is Wayland-only.`;
}

/** Lowercased session type, with `WAYLAND_DISPLAY` as the fallback evidence. */
export function readSessionType(env: NodeJS.ProcessEnv): string {
  const declared = env.XDG_SESSION_TYPE?.trim().toLowerCase();
  if (declared) return declared;
  return env.WAYLAND_DISPLAY ? "wayland" : "";
}

/**
 * Where the native desktop helper lives. `SYNARA_COMPUTER_HELPER` overrides it
 * so a developer build and a packaged one are the same code path.
 */
export function desktopHelperPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SYNARA_COMPUTER_HELPER?.trim();
  if (override) return override;
  return join(
    env.XDG_DATA_HOME?.trim() || join(env.HOME ?? "", ".local", "share"),
    "synara",
    "computer",
    "synara-computer-desktop-helper",
  );
}

function defaultReadPortalProperty(interfaceName: string, propertyName: string): Promise<unknown> {
  return readSessionBusProperty({
    busName: PORTAL_BUS_NAME,
    objectPath: PORTAL_OBJECT_PATH,
    interfaceName,
    propertyName,
  });
}

/**
 * Enumerating Wayland globals needs a `wl_display` connection, which Node has
 * no binding for; the native desktop helper owns it.
 *
 * A short-lived `--print-globals` invocation rather than a supervised helper:
 * this runs at server boot on desktops that may have no wlroots protocols at
 * all, and holding a process on the compositor for the server's lifetime to
 * answer one question is a cost the probe has not earned. The rejection when
 * the helper is not built is the honest answer — it is what makes every wlroots
 * capability report "not built" rather than "your desktop cannot do this".
 */
async function defaultWaylandGlobals(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const command = desktopHelperPath(env);
  if (!(await defaultExecutableExists(command))) {
    throw new Error(
      `the native desktop helper, which owns the Wayland connection, is not built at ${command}`,
    );
  }
  return await readWaylandGlobals({ command, env });
}

async function defaultExecutableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultCommandExists(command: string): Promise<boolean> {
  const directories = (process.env.PATH ?? "").split(":").filter((entry) => entry.length > 0);
  for (const directory of directories) {
    if (await defaultExecutableExists(join(directory, command))) return true;
  }
  return false;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
