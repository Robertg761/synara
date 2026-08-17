import { describe, expect, it } from "vitest";

import {
  desktopKind,
  planPortalProviders,
  probeDesktop,
  readSessionType,
  REMOTE_DESKTOP_DEVICE_KEYBOARD,
  REMOTE_DESKTOP_DEVICE_POINTER,
  PORTAL_BUS_NAME,
  PORTAL_REMOTE_DESKTOP_INTERFACE,
  PORTAL_SCREENCAST_INTERFACE,
  SYNARA_DESKTOP_EXTENSION_BUS_NAME,
  WLROOTS_GLOBALS,
  type PortalProbe,
  type PortalProbeDependencies,
} from "./probe.ts";
import { KWIN_SERVICE } from "../kwinDbus.ts";

/**
 * A desktop described by what it owns and advertises. Everything the probe can
 * touch is injected, so no test here needs a bus, a display, or a filesystem.
 */
function desktop(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly names?: readonly string[];
    readonly globals?: readonly string[];
    readonly globalsError?: string;
    readonly portalProperties?: Readonly<Record<string, number>>;
    readonly helper?: boolean;
    readonly commands?: readonly string[];
    readonly busError?: string;
  } = {},
): PortalProbeDependencies {
  const names = new Set(options.names ?? []);
  const commands = new Set(options.commands ?? []);
  return {
    env: options.env ?? { XDG_SESSION_TYPE: "wayland", HOME: "/home/tester" },
    busNameHasOwner: (name) =>
      options.busError
        ? Promise.reject(new Error(options.busError))
        : Promise.resolve(names.has(name)),
    readPortalProperty: (interfaceName, propertyName) => {
      const value = options.portalProperties?.[`${interfaceName}.${propertyName}`];
      return value === undefined
        ? Promise.reject(new Error("no such property"))
        : Promise.resolve(value);
    },
    waylandGlobals: () =>
      options.globalsError
        ? Promise.reject(new Error(options.globalsError))
        : Promise.resolve(options.globals ?? []),
    executableExists: () => Promise.resolve(options.helper === true),
    commandExists: (command) => Promise.resolve(commands.has(command)),
  };
}

const WL_CLIPBOARD = ["wl-copy", "wl-paste"] as const;

describe("readSessionType", () => {
  it("prefers the declared session type and falls back to the Wayland socket", () => {
    expect(readSessionType({ XDG_SESSION_TYPE: "X11" })).toBe("x11");
    expect(readSessionType({ WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland");
    expect(readSessionType({})).toBe("");
  });
});

describe("desktopKind", () => {
  it("trusts the running compositor over XDG_CURRENT_DESKTOP", () => {
    // A KDE session started from a tty often has no XDG_CURRENT_DESKTOP, and a
    // user can set it to anything; the bus name is the fact.
    expect(desktopKind({ env: { XDG_CURRENT_DESKTOP: "GNOME" }, kwinPresent: true })).toBe("kde");
    expect(
      desktopKind({
        env: { XDG_CURRENT_DESKTOP: "GNOME" },
        kwinPresent: false,
        waylandGlobals: [WLROOTS_GLOBALS.foreignToplevel],
      }),
    ).toBe("wlroots");
    expect(
      desktopKind({
        env: { HYPRLAND_INSTANCE_SIGNATURE: "abc", XDG_CURRENT_DESKTOP: "" },
        kwinPresent: false,
      }),
    ).toBe("wlroots");
  });

  it("falls back to the desktop name only when nothing else answered", () => {
    expect(desktopKind({ env: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, kwinPresent: false })).toBe(
      "gnome",
    );
    expect(desktopKind({ env: { DESKTOP_SESSION: "sway" }, kwinPresent: false })).toBe("wlroots");
    expect(desktopKind({ env: {}, kwinPresent: false })).toBe("unknown");
  });
});

describe("probeDesktop", () => {
  it("never throws when every step fails, and records each as a gap", async () => {
    const probe = await probeDesktop(desktop({ busError: "no session bus" }));

    expect(probe.sessionBusReachable).toBe(false);
    expect(probe.kwinPresent).toBe(false);
    expect(probe.portal.present).toBe(false);
    expect(probe.gaps.map((gap) => gap.step)).toContain("session-bus");
    // One unreachable bus is one gap, not one per name asked.
    expect(probe.gaps.filter((gap) => gap.step === "session-bus")).toHaveLength(1);
  });

  it("names the package to install for each missing piece", async () => {
    const probe = await probeDesktop(desktop({ env: { XDG_SESSION_TYPE: "wayland" } }));
    const messages = Object.fromEntries(probe.gaps.map((gap) => [gap.step, gap.message]));

    expect(messages.portal).toContain("xdg-desktop-portal");
    expect(messages["wl-clipboard"]).toContain("wl-clipboard");
    expect(messages["desktop-helper"]).toContain("SYNARA_COMPUTER_HELPER");
  });

  it("reports an X11 session as the wrong session type, with the nested escape hatch", async () => {
    const probe = await probeDesktop(desktop({ env: { XDG_SESSION_TYPE: "x11" } }));

    expect(probe.sessionType).toBe("x11");
    expect(probe.gaps.find((gap) => gap.step === "session")?.message).toContain(
      "SYNARA_COMPUTER_NESTED=window",
    );
    // No display connection is attempted off Wayland, so no global list exists.
    expect(probe.waylandGlobals).toBeUndefined();
  });

  it("reads the portal's RemoteDesktop and ScreenCast versions when it is running", async () => {
    const probe = await probeDesktop(
      desktop({
        names: [PORTAL_BUS_NAME],
        portalProperties: {
          [`${PORTAL_REMOTE_DESKTOP_INTERFACE}.version`]: 2,
          [`${PORTAL_REMOTE_DESKTOP_INTERFACE}.AvailableDeviceTypes`]:
            REMOTE_DESKTOP_DEVICE_KEYBOARD | REMOTE_DESKTOP_DEVICE_POINTER,
          [`${PORTAL_SCREENCAST_INTERFACE}.version`]: 5,
        },
      }),
    );

    expect(probe.portal).toEqual({
      present: true,
      remoteDesktopVersion: 2,
      screenCastVersion: 5,
      availableDeviceTypes: 3,
    });
    expect(probe.gaps.map((gap) => gap.step)).not.toContain("portal-remote-desktop");
  });

  it("does not mistake a KWin host for a Tier 2 desktop", async () => {
    const probe = await probeDesktop(desktop({ names: [KWIN_SERVICE] }));

    expect(probe.kwinPresent).toBe(true);
    expect(probe.desktop).toBe("kde");
  });
});

/** A probe result with only the fields a plan actually reads. */
function probeFor(overrides: Partial<PortalProbe> = {}): PortalProbe {
  return {
    sessionType: "wayland",
    desktop: "unknown",
    kwinPresent: false,
    sessionBusReachable: true,
    portal: { present: false },
    desktopExtensionPresent: false,
    wlClipboard: false,
    gaps: [],
    ...overrides,
  };
}

describe("planPortalProviders", () => {
  it("picks the unprivileged wlroots protocols when the compositor advertises them", async () => {
    const probe = await probeDesktop(
      desktop({
        globals: [
          WLROOTS_GLOBALS.virtualPointer,
          WLROOTS_GLOBALS.virtualKeyboard,
          WLROOTS_GLOBALS.screencopy,
          WLROOTS_GLOBALS.foreignToplevel,
          WLROOTS_GLOBALS.dataControl,
        ],
        commands: WL_CLIPBOARD,
        env: { XDG_SESSION_TYPE: "wayland", SWAYSOCK: "/run/sway.sock" },
      }),
    );
    const plan = planPortalProviders(probe);

    expect(probe.desktop).toBe("wlroots");
    expect(plan.input.implementation).toBe("wlroots-virtual-input");
    expect(plan.capture.implementation).toBe("wlr-screencopy");
    expect(plan.windows.implementation).toBe("wlr-foreign-toplevel");
    expect(plan.clipboard.implementation).toBe("wl-clipboard");
    // Selected, but not built: the difference between "your desktop cannot do
    // this" and "Synara has not written this part yet".
    for (const choice of Object.values(plan)) {
      expect(choice.blockedBy).toContain("phase B");
    }
  });

  it("prefers wlroots protocols over the portal even when both are present", () => {
    // The wlroots path needs no dialog and no grant, so a compositor offering
    // both must not be made to prompt.
    const plan = planPortalProviders(
      probeFor({
        portal: { present: true, remoteDesktopVersion: 2, screenCastVersion: 5 },
        waylandGlobals: [WLROOTS_GLOBALS.virtualPointer, WLROOTS_GLOBALS.screencopy],
      }),
    );

    expect(plan.input.implementation).toBe("wlroots-virtual-input");
    expect(plan.capture.implementation).toBe("wlr-screencopy");
  });

  it("picks libei and PipeWire on a portal-only desktop", () => {
    const plan = planPortalProviders(
      probeFor({
        desktop: "gnome",
        portal: {
          present: true,
          remoteDesktopVersion: 2,
          screenCastVersion: 5,
          availableDeviceTypes: REMOTE_DESKTOP_DEVICE_KEYBOARD | REMOTE_DESKTOP_DEVICE_POINTER,
        },
      }),
    );

    expect(plan.input.implementation).toBe("libei");
    expect(plan.capture.implementation).toBe("pipewire-screencast");
    expect(plan.clipboard.implementation).toBe("portal-selection");
  });

  it("refuses a portal that advertises no pointer device, naming the flags it saw", () => {
    const plan = planPortalProviders(
      probeFor({
        portal: {
          present: true,
          remoteDesktopVersion: 2,
          availableDeviceTypes: REMOTE_DESKTOP_DEVICE_KEYBOARD,
        },
      }),
    );

    expect(plan.input.blockedBy).toContain("AvailableDeviceTypes=1");
    expect(plan.input.blockedBy).not.toContain("phase B");
  });

  it("tells a GNOME user to install the Shell extension rather than calling GNOME unsupported", () => {
    const plan = planPortalProviders(
      probeFor({ desktop: "gnome", portal: { present: true, remoteDesktopVersion: 2 } }),
    );

    expect(plan.windows.implementation).toBeUndefined();
    expect(plan.windows.blockedBy).toContain("synara-computer-use@synara.dev");
    // The coordinate-only workflow is the answer, so it has to be in the text.
    expect(plan.windows.blockedBy).toContain("desktop coordinates");
  });

  it("uses the desktop extension for windows the moment it owns its bus name", async () => {
    const probe = await probeDesktop(
      desktop({ names: [SYNARA_DESKTOP_EXTENSION_BUS_NAME], env: { XDG_SESSION_TYPE: "wayland" } }),
    );

    expect(probe.desktopExtensionPresent).toBe(true);
    expect(planPortalProviders(probe).windows.implementation).toBe("gnome-shell-extension");
  });

  it("blocks every capability on a session that is not Wayland", () => {
    const plan = planPortalProviders(probeFor({ sessionType: "x11" }));

    expect(plan.input.implementation).toBeUndefined();
    expect(plan.capture.implementation).toBeUndefined();
    expect(plan.input.blockedBy).toContain("Wayland-only");
  });

  it("says wl-clipboard is installed but unusable when no data-control protocol exists", () => {
    const plan = planPortalProviders(probeFor({ wlClipboard: true, waylandGlobals: [] }));

    expect(plan.clipboard.blockedBy).toContain("data-control");
    expect(plan.clipboard.blockedBy).not.toContain("Install the wl-clipboard package");
  });
});
