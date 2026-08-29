import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
    readonly prebuiltRoot?: string;
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
    // Pinned at a directory that cannot exist, so no test here depends on
    // whether the checkout it runs in happens to have prebuilt helpers in it.
    prebuiltRoot: options.prebuiltRoot ?? join(tmpdir(), "synara-no-prebuilt-helpers"),
  };
}

const WL_CLIPBOARD = ["wl-copy", "wl-paste"] as const;

/** A sway-like desktop: every wlroots global, wl-clipboard installed. */
function wlrootsDesktop(options: { readonly helper: boolean }): PortalProbeDependencies {
  return desktop({
    globals: [
      WLROOTS_GLOBALS.virtualPointer,
      WLROOTS_GLOBALS.virtualKeyboard,
      WLROOTS_GLOBALS.screencopy,
      WLROOTS_GLOBALS.foreignToplevel,
      WLROOTS_GLOBALS.dataControl,
    ],
    commands: WL_CLIPBOARD,
    helper: options.helper,
    env: { XDG_SESSION_TYPE: "wayland", SWAYSOCK: "/run/sway.sock" },
  });
}

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

  it("records the missing helper without installing anything, deferring resolution to first use", async () => {
    const probe = await probeDesktop(desktop({ env: { XDG_SESSION_TYPE: "wayland" } }));
    const message = probe.gaps.find((gap) => gap.step === "desktop-helper")?.message ?? "";

    // The sentence a user acts on has not moved. The probe itself installs
    // nothing — boot must not put a binary in place — so the shipped-bundle
    // check happens later, when someone actually uses the desktop.
    expect(message).toContain("The native desktop helper is not built at");
    expect(message).toContain(
      "Build it with the computer-desktop-helper target, or point SYNARA_COMPUTER_HELPER at an existing build.",
    );
  });

  it("uses a helper that is already present without touching the manifest", async () => {
    const probe = await probeDesktop(desktop({ helper: true }));

    expect(probe.helperBinary).toBe(
      "/home/tester/.local/share/synara/computer/synara-computer-desktop-helper",
    );
    expect(probe.gaps.find((gap) => gap.step === "desktop-helper")).toBeUndefined();
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
    helperPath: "/home/test/.local/share/synara/computer/synara-computer-desktop-helper",
    gaps: [],
    ...overrides,
  };
}

describe("planPortalProviders", () => {
  it("picks the unprivileged wlroots protocols when the compositor advertises them", async () => {
    const probe = await probeDesktop(wlrootsDesktop({ helper: true }));
    const plan = planPortalProviders(probe);

    expect(probe.desktop).toBe("wlroots");
    expect(plan.input.implementation).toBe("wlroots-virtual-input");
    expect(plan.capture.implementation).toBe("wlr-screencopy");
    expect(plan.windows.implementation).toBe("wlr-foreign-toplevel");
    expect(plan.clipboard.implementation).toBe("wl-clipboard");
    // Every one of them is usable: the protocols are advertised and the helper
    // that speaks them is built.
    for (const choice of Object.values(plan)) {
      expect(choice.blockedBy).toBeUndefined();
    }
  });

  it("blames the unbuilt helper, not the desktop, when the protocols are all there", async () => {
    const probe = await probeDesktop(wlrootsDesktop({ helper: false }));
    const plan = planPortalProviders(probe);

    // Still selected — the difference between "your desktop cannot do this" and
    // "Synara has not been built for it yet" is the difference between
    // uninstalling and running one script.
    expect(plan.input.implementation).toBe("wlroots-virtual-input");
    for (const slot of ["input", "capture", "windows"] as const) {
      expect(plan[slot].blockedBy).toContain("build.sh");
      expect(plan[slot].blockedBy).toContain("SYNARA_COMPUTER_HELPER");
    }
    // The clipboard is its own pair of processes and needs no helper at all.
    expect(plan.clipboard.blockedBy).toBeUndefined();
  });

  it("names the unbuilt helper rather than calling a wlroots desktop unsupported", () => {
    // The exact shape that made this necessary: Hyprland, which advertises
    // every protocol Synara needs, with no helper built. The globals cannot be
    // read *because* the helper is what reads them, so the old plan concluded
    // the compositor offered nothing and told the user to install a portal
    // backend they already had — and to compile PipeWire support for a
    // mechanism this desktop never uses.
    const plan = planPortalProviders(
      probeFor({
        desktop: "wlroots",
        portal: { present: true, screenCastVersion: 6 },
        // Installed, as it is on the machine this was found on: whether it can
        // actually *read* a selection depends on a data-control global, which
        // is exactly what could not be looked up.
        wlClipboard: true,
        // No `waylandGlobals` and no `helperBinary`: unknown, not empty.
      }),
    );

    for (const slot of ["input", "capture", "windows", "clipboard"] as const) {
      expect(plan[slot].blockedBy).toContain("native desktop helper is not built");
    }
    expect(plan.input.blockedBy).not.toContain("offers neither");
    expect(plan.capture.blockedBy).not.toContain("PipeWire");
    expect(plan.windows.blockedBy).not.toContain("exposes no window enumeration");
    expect(plan.clipboard.blockedBy).not.toContain("advertises no data-control");
  });

  it("still blames PipeWire on GNOME, where PipeWire really is the capture path", () => {
    // The one desktop where an unreadable global list changes nothing: GNOME
    // captures through the ScreenCast portal either way, and that refusal
    // already names the helper and the build script.
    const plan = planPortalProviders(
      probeFor({
        desktop: "gnome",
        portal: { present: true, remoteDesktopVersion: 2, screenCastVersion: 5 },
      }),
    );

    expect(plan.capture.implementation).toBe("pipewire-screencast");
    expect(plan.capture.blockedBy).toContain("PipeWire");
    // Input is the portal's, which needs no helper and no global list.
    expect(plan.input.implementation).toBe("portal-remote-desktop");
    expect(plan.input.blockedBy).toBeUndefined();
  });

  it("keeps saying a real protocol is absent when the globals were actually read", () => {
    // The guard must not swallow the honest answer: a desktop whose list was
    // read and simply does not contain the protocol is still told so.
    const plan = planPortalProviders(
      probeFor({
        desktop: "wlroots",
        helperBinary: "/tmp/synara-computer-desktop-helper",
        waylandGlobals: [],
      }),
    );

    expect(plan.input.blockedBy).toContain("offers neither");
    expect(plan.windows.blockedBy).toContain("exposes no window enumeration");
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

  it("drives a portal-only desktop through RemoteDesktop, and blocks only the pixels", () => {
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

    // Input ships whole: Start hands back the ScreenCast stream's position and
    // size, so absolute motion has a coordinate space without opening PipeWire.
    expect(plan.input.implementation).toBe("portal-remote-desktop");
    expect(plan.input.blockedBy).toBeUndefined();
    expect(plan.clipboard.implementation).toBe("portal-selection");
    // Only the frames are missing, and the sentence says so honestly: no
    // rebuild adds a PipeWire receiver, so none may be promised.
    expect(plan.capture.implementation).toBe("pipewire-screencast");
    expect(plan.capture.blockedBy).toMatch(/cannot receive PipeWire streams yet/);
    expect(plan.capture.blockedBy).toMatch(/SYNARA_COMPUTER_NESTED=window/);
    expect(plan.capture.blockedBy).not.toMatch(/pipewire-devel|build\.sh/);
  });

  it("blocks portal input when the desktop has no ScreenCast to anchor motion to", () => {
    const plan = planPortalProviders(
      probeFor({
        desktop: "gnome",
        portal: {
          present: true,
          remoteDesktopVersion: 2,
          availableDeviceTypes: REMOTE_DESKTOP_DEVICE_KEYBOARD | REMOTE_DESKTOP_DEVICE_POINTER,
        },
      }),
    );

    expect(plan.input.implementation).toBe("portal-remote-desktop");
    expect(plan.input.blockedBy).toMatch(/no org\.freedesktop\.portal\.ScreenCast interface/);
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

  it("accepts either data-control protocol, because the wlr one is being retired", () => {
    // wlroots 0.18+, KWin and Mutter 48 advertise only `ext_data_control_manager_v1`,
    // and wl-clipboard 2.2+ speaks it; checking for the wlr name alone would
    // call a working clipboard unsupported on every current compositor.
    for (const global of ["zwlr_data_control_manager_v1", "ext_data_control_manager_v1"]) {
      const plan = planPortalProviders(probeFor({ wlClipboard: true, waylandGlobals: [global] }));
      expect(plan.clipboard).toEqual({ implementation: "wl-clipboard" });
    }
  });
});
