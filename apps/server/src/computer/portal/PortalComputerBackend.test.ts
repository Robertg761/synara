import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { ComputerRect, ComputerWindow } from "@synara/contracts";

import { ComputerBackendError } from "../ComputerBackend.ts";
import { POINTER_SEQUENCE_OPERATIONS } from "../pointerSequencing.ts";
import { HUMAN_ACTIVE_REFUSAL, type SeatActivity } from "../sharedSeatArbiter.ts";
import { fakeDesktopHelper } from "./fakeDesktopHelper.ts";
import {
  capabilitiesFromProviders,
  createPortalComputerBackend,
  PortalComputerBackend,
  resolvePortalProviders,
} from "./PortalComputerBackend.ts";
import { REMOTE_DESKTOP_DEVICE_POINTER, WLROOTS_GLOBALS, type PortalProbe } from "./probe.ts";
import {
  missingProvider,
  resolvedProvider,
  type PortalCaptureProvider,
  type PortalClipboardProvider,
  type PortalInputProvider,
  type PortalProviders,
  type PortalWindowProvider,
} from "./providers.ts";

const WORKSPACE: ComputerRect = { x: 0, y: 0, width: 1920, height: 1080 };
/** A seat nobody has touched for long enough that the arbiter never waits. */
const SEAT_QUIET: SeatActivity = { state: "quiet", idleMs: 60_000 };

/** A 1x1 PNG whose IHDR is rewritten to the requested size. */
const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

function pngOfSize(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(PNG_1X1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

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

function fakeInput(): PortalInputProvider & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    id: "wlroots-virtual-input",
    sharedSeat: true,
    sink: {
      movePointer: (x, y, operation) => {
        calls.push(`${operation} ${Math.round(x)},${Math.round(y)}`);
        return Promise.resolve();
      },
      button: (code, pressed, operation) => {
        calls.push(`${operation} ${code} ${pressed}`);
        return Promise.resolve();
      },
      key: (code, pressed, operation) => {
        calls.push(`${operation} ${code} ${pressed}`);
        return Promise.resolve();
      },
    },
    scroll: (deltaX, deltaY) => {
      calls.push(`scroll ${deltaX},${deltaY}`);
      return Promise.resolve();
    },
    dispose: () => Promise.resolve(),
  };
}

function fakeCapture(
  workspace: ComputerRect = WORKSPACE,
): PortalCaptureProvider & { readonly requests: ComputerRect[] } {
  const requests: ComputerRect[] = [];
  return {
    requests,
    id: "wlr-screencopy",
    workspaceRect: () => Promise.resolve(workspace),
    captureRegion: (region) => {
      requests.push(region);
      return Promise.resolve({ bytes: pngOfSize(region.width, region.height), region });
    },
    dispose: () => Promise.resolve(),
  };
}

function fakeWindows(
  windows: readonly ComputerWindow[],
  options: {
    readonly providesBounds?: boolean;
    readonly providesStacking?: boolean;
    readonly activate?: boolean;
    readonly raise?: boolean;
  } = {},
): PortalWindowProvider {
  return {
    id: "wlr-foreign-toplevel",
    providesBounds: options.providesBounds ?? false,
    providesStacking: options.providesStacking ?? false,
    listWindows: () => Promise.resolve(windows),
    ...(options.activate ? { activateWindow: () => Promise.resolve() } : {}),
    ...(options.raise ? { raiseWindow: () => Promise.resolve() } : {}),
    dispose: () => Promise.resolve(),
  };
}

function fakeClipboard(): PortalClipboardProvider {
  let value = "";
  return {
    id: "wl-clipboard",
    read: () => Promise.resolve(value),
    write: (text) => {
      value = text;
      return Promise.resolve();
    },
    dispose: () => Promise.resolve(),
  };
}

function providersOf(overrides: Partial<PortalProviders> = {}): PortalProviders {
  return {
    input: resolvedProvider(fakeInput()),
    capture: resolvedProvider(fakeCapture()),
    windows: missingProvider("This desktop exposes no window enumeration."),
    clipboard: missingProvider("wl-copy and wl-paste are not on PATH."),
    ...overrides,
  };
}

function backendWith(
  providers: PortalProviders,
  overrides: Partial<ConstructorParameters<typeof PortalComputerBackend>[0]> = {},
): PortalComputerBackend {
  return new PortalComputerBackend({
    probe: probeFor(),
    providers,
    platform: "linux",
    now: () => 1_700_000_000_000,
    sleep: () => Promise.resolve(),
    glideDurationMs: 0,
    ...overrides,
  });
}

const WINDOW_WITHOUT_BOUNDS: ComputerWindow = {
  id: "toplevel-1",
  title: "Calculator",
  focused: false,
  minimized: false,
  visible: true,
};

describe("capabilitiesFromProviders", () => {
  it("reports what resolved, not what the desktop might manage", () => {
    expect(capabilitiesFromProviders(providersOf())).toEqual({
      windows: false,
      windowBounds: false,
      stacking: false,
      capture: true,
      input: true,
      clipboard: false,
      activation: false,
      ghostCursor: false,
      sharedSeat: true,
      visibleDesktop: true,
    });
  });

  it("takes windowBounds, stacking, and activation from the window provider itself", () => {
    const capabilities = capabilitiesFromProviders(
      providersOf({
        windows: resolvedProvider(
          fakeWindows([], { providesBounds: true, providesStacking: true, raise: true }),
        ),
        clipboard: resolvedProvider(fakeClipboard()),
      }),
    );

    expect(capabilities).toMatchObject({
      windows: true,
      windowBounds: true,
      stacking: true,
      activation: true,
      clipboard: true,
    });
  });

  it("never claims a ghost cursor, because no Tier 2 mechanism can draw one", () => {
    expect(capabilitiesFromProviders(providersOf()).ghostCursor).toBe(false);
  });

  it("is empty when nothing resolved", () => {
    const nothing = resolvePortalProviders(probeFor());

    expect(capabilitiesFromProviders(nothing)).toEqual({
      windows: false,
      windowBounds: false,
      stacking: false,
      capture: false,
      input: false,
      clipboard: false,
      activation: false,
      ghostCursor: false,
      sharedSeat: false,
      visibleDesktop: true,
    });
  });
});

describe("resolvePortalProviders", () => {
  it("carries the plan's sentence into every slot it could not build", () => {
    const providers = resolvePortalProviders(
      probeFor({
        waylandGlobals: [WLROOTS_GLOBALS.virtualPointer, WLROOTS_GLOBALS.screencopy],
      }),
    );

    expect(providers.input.available).toBe(false);
    expect(providers.input.available === false && providers.input.reason).toContain(
      "wlroots-virtual-input",
    );
    // The protocol is advertised and the helper is not built, so the refusal
    // has to name the build rather than the desktop.
    expect(providers.capture.available === false && providers.capture.reason).toContain("build.sh");
  });

  it("builds the wlroots providers once the helper exists", () => {
    const providers = resolvePortalProviders(
      probeFor({
        helperBinary: "/tmp/synara-computer-desktop-helper",
        wlClipboard: true,
        waylandGlobals: [
          WLROOTS_GLOBALS.virtualPointer,
          WLROOTS_GLOBALS.screencopy,
          WLROOTS_GLOBALS.foreignToplevel,
          WLROOTS_GLOBALS.dataControl,
        ],
      }),
      // The helper is never spawned here: construction must not touch the
      // compositor, so nothing below awaits a live process.
      { createHelper: () => fakeDesktopHelper() },
    );

    expect(providers.input.available && providers.input.provider.id).toBe("wlroots-virtual-input");
    expect(providers.capture.available && providers.capture.provider.id).toBe("wlr-screencopy");
    expect(providers.windows.available && providers.windows.provider.id).toBe(
      "wlr-foreign-toplevel",
    );
    expect(providers.clipboard.available && providers.clipboard.provider.id).toBe("wl-clipboard");
    expect(capabilitiesFromProviders(providers)).toEqual({
      windows: true,
      // The protocol reports no geometry and no stacking, and the capability
      // flags have to say so or window-scoped tools will be offered and refuse.
      windowBounds: false,
      stacking: false,
      capture: true,
      input: true,
      clipboard: true,
      activation: true,
      ghostCursor: false,
      sharedSeat: true,
      visibleDesktop: true,
    });
  });

  it("builds the GNOME Shell window provider when the extension is on the bus", () => {
    const providers = resolvePortalProviders(
      probeFor({ desktop: "gnome", desktopExtensionPresent: true }),
      {
        // Never awaited here: the provider connects on its first call, so
        // resolving must not open a bus.
        connectGnomeShellExtension: () => Promise.reject(new Error("connected too early")),
      },
    );

    expect(providers.windows.available && providers.windows.provider.id).toBe(
      "gnome-shell-extension",
    );
    expect(capabilitiesFromProviders(providers)).toMatchObject({
      windows: true,
      windowBounds: true,
      stacking: true,
      activation: true,
    });
  });

  it("names the extension rather than building one against KWin's bus name", () => {
    // Both own `org.kde.KWin` and neither can be told from the other by name,
    // so a KDE host forced into Tier 2 gets the refusal, not a provider that
    // would speak GNOME's protocol to the KWin plugin.
    const providers = resolvePortalProviders(
      probeFor({ desktop: "gnome", desktopExtensionPresent: true, kwinPresent: true }),
    );

    expect(providers.windows.available).toBe(false);
    expect(providers.windows.available === false && providers.windows.reason).toContain(
      "synara-computer-use@synara.dev",
    );
  });

  it("disposes the shared helper exactly once, after the last provider releases it", async () => {
    let disposals = 0;
    const providers = resolvePortalProviders(
      probeFor({
        helperBinary: "/tmp/synara-computer-desktop-helper",
        waylandGlobals: [
          WLROOTS_GLOBALS.virtualPointer,
          WLROOTS_GLOBALS.screencopy,
          WLROOTS_GLOBALS.foreignToplevel,
        ],
      }),
      {
        createHelper: () =>
          fakeDesktopHelper({
            dispose: () => {
              disposals += 1;
              return Promise.resolve();
            },
          }),
      },
    );

    await backendWith(providers).dispose();

    expect(disposals).toBe(1);
  });
});

describe("PortalComputerBackend availability", () => {
  it("is available once input and capture resolved, even with no windows or clipboard", async () => {
    // A desktop with no enumeration is degraded, not unusable: the agent works
    // in desktop coordinates. Failing availability would remove a working tier.
    await expect(backendWith(providersOf()).availability()).resolves.toEqual({
      kind: "available",
      backend: "portal",
    });
  });

  it("names both missing capabilities, with the package to install", async () => {
    const backend = backendWith(
      providersOf({
        input: missingProvider("Install xdg-desktop-portal plus your desktop's backend."),
        capture: missingProvider("Install xdg-desktop-portal plus your desktop's backend."),
      }),
    );
    const availability = await backend.availability();

    expect(availability.kind).toBe("backend-unavailable");
    expect(availability.kind === "backend-unavailable" && availability.message).toContain(
      "Input is unavailable",
    );
    expect(availability.kind === "backend-unavailable" && availability.message).toContain(
      "Screen capture is unavailable",
    );
    expect(availability.kind === "backend-unavailable" && availability.message).toContain(
      "xdg-desktop-portal",
    );
  });

  it("reports the wrong session type before blaming any provider", async () => {
    const backend = backendWith(providersOf(), { probe: probeFor({ sessionType: "x11" }) });

    await expect(backend.availability()).resolves.toEqual({
      kind: "backend-unavailable",
      message: "Linux computer control requires a Wayland session; this is an x11 session.",
    });
  });

  it("reports a non-Linux host as unsupported rather than misconfigured", async () => {
    await expect(
      backendWith(providersOf(), { platform: "darwin" }).availability(),
    ).resolves.toEqual({ kind: "unsupported-platform", platform: "darwin" });
  });
});

describe("PortalComputerBackend reprobe", () => {
  it("keeps live providers on an upgrade, adopts the new slot, and refreshes capabilities", async () => {
    const oldInput = fakeInput();
    const oldInputDispose = vi.spyOn(oldInput, "dispose");
    const freshInput = { ...fakeInput(), dispose: vi.fn(() => Promise.resolve()) };
    const freshCapture = { ...fakeCapture(), dispose: vi.fn(() => Promise.resolve()) };
    const upgraded = probeFor({
      wlClipboard: true,
      waylandGlobals: [WLROOTS_GLOBALS.dataControl],
    });
    const backend = backendWith(providersOf({ input: resolvedProvider(oldInput) }), {
      recomputeProbe: () => Promise.resolve(upgraded),
      buildProviders: () =>
        providersOf({
          input: resolvedProvider(freshInput),
          capture: resolvedProvider(freshCapture),
          clipboard: resolvedProvider(fakeClipboard()),
        }),
    });
    expect(backend.capabilities().clipboard).toBe(false);

    await backend.probeAvailability();

    // The upgraded slot arrives, and the capability set follows the providers
    // it was derived from instead of freezing the boot answer.
    expect(backend.capabilities().clipboard).toBe(true);
    // The slots that already resolved keep their live providers — sessions and
    // consent live there — and the fresh duplicates are disposed, not leaked.
    expect(oldInputDispose).not.toHaveBeenCalled();
    expect(freshInput.dispose).toHaveBeenCalledTimes(1);
    expect(freshCapture.dispose).toHaveBeenCalledTimes(1);

    await backend.click({ x: 10, y: 10 });
    expect(oldInput.calls.length).toBeGreaterThan(0);
    expect(freshInput.calls).toEqual([]);
  });

  it("installs the shipped helper only on the establishing read, then reprobes at once", async () => {
    const resolveHelper = vi
      .fn<() => Promise<{ path?: string }>>()
      .mockResolvedValue({ path: "/tmp/synara-desktop-helper" });
    const recomputeProbe = vi.fn(() => Promise.resolve(probeFor()));
    const backend = backendWith(providersOf(), {
      recomputeProbe,
      buildProviders: () => providersOf(),
      resolveHelper,
    });

    // Boot's passive read installs nothing, by contract.
    await backend.probeAvailability();
    expect(resolveHelper).not.toHaveBeenCalled();
    expect(recomputeProbe).toHaveBeenCalledTimes(1);

    // The establishing read is licensed to install, and a successful install
    // un-throttles the refresh so the new binary is probed immediately.
    await backend.availability();
    expect(resolveHelper).toHaveBeenCalledTimes(1);
    expect(recomputeProbe).toHaveBeenCalledTimes(2);

    // Throttled thereafter: one establishing read does not hammer the installer.
    await backend.availability();
    expect(resolveHelper).toHaveBeenCalledTimes(1);
  });
});

describe("PortalComputerBackend consent", () => {
  it("stays available while consent is outstanding and says so in health", async () => {
    // A missing grant is a user action, not a fault: an unavailable badge would
    // hide the one thing the user has to go and do.
    const backend = backendWith(providersOf(), {
      probe: probeFor({ portal: { present: true, remoteDesktopVersion: 2 } }),
    });
    backend.setConsentState("awaiting", "The desktop's screen-sharing dialog is open.");

    expect(backend.health().status).toBe("awaiting-consent");
    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(backend.consentState()).toEqual({
      state: "awaiting",
      reason: "The desktop's screen-sharing dialog is open.",
    });
  });

  it("latches a denial so the dialog the user just dismissed is not re-raised", () => {
    const backend = backendWith(providersOf());
    backend.setConsentState("denied", "The user cancelled the screen-sharing dialog.");
    backend.setConsentState("awaiting");
    backend.setConsentState("granted");

    expect(backend.consentState().state).toBe("denied");
    expect(backend.health().status).toBe("consent-denied");
  });

  it("blocks availability while denied, with the reason and its remedy", async () => {
    const backend = backendWith(providersOf(), {
      probe: probeFor({ portal: { present: true, remoteDesktopVersion: 2 } }),
    });
    backend.setConsentState("denied", "The user cancelled the screen-sharing dialog.");

    await expect(backend.availability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("cancelled the screen-sharing dialog"),
    });
  });

  it("clears a latched denial only through an explicit reset", () => {
    const backend = backendWith(providersOf());
    backend.setConsentState("denied", "cancelled");
    backend.setConsentState("not-requested");

    expect(backend.consentState().state).toBe("not-requested");
  });

  it("resetConsent clears a denial exactly once and reports whether it did", () => {
    const backend = backendWith(providersOf(), {
      probe: probeFor({ portal: { present: true, remoteDesktopVersion: 2 } }),
    });
    backend.setConsentState("denied", "cancelled");

    expect(backend.resetConsent()).toBe(true);
    expect(backend.consentState().state).toBe("not-requested");
    expect(backend.health().status).not.toBe("consent-denied");
    // Nothing is latched any more, so a second reset has nothing to clear.
    expect(backend.resetConsent()).toBe(false);
  });

  it("starts at not-required on a desktop with no portal to prompt from", () => {
    // wlroots grants nothing and prompts for nothing; saying "not requested"
    // there would imply a dialog is coming that never will.
    expect(backendWith(providersOf()).consentState().state).toBe("not-required");
    expect(
      backendWith(providersOf(), {
        probe: probeFor({ portal: { present: true } }),
      }).consentState().state,
    ).toBe("not-requested");
  });

  it("publishes a health change when consent moves", () => {
    const backend = backendWith(providersOf());
    const seen: string[] = [];
    backend.onEvent((event) => {
      if (event.type === "health-changed") seen.push(event.health.status);
    });
    backend.setConsentState("awaiting");
    backend.setConsentState("granted");

    expect(seen).toEqual(["awaiting-consent", "connected"]);
  });
});

describe("PortalComputerBackend refusals", () => {
  it("rejects listWindows instead of answering with an empty list", async () => {
    // Returning [] is what made an agent relaunch the same app three times.
    const backend = backendWith(providersOf());

    await expect(backend.listWindows()).rejects.toThrow(ComputerBackendError);
    await expect(backend.listWindows()).rejects.toThrow(
      /Listing windows is not available on this desktop\..*no window enumeration/s,
    );
  });

  it("refuses non-retryably, so an agent does not loop against a desktop that will never answer", async () => {
    const backend = backendWith(providersOf());

    await expect(backend.listWindows()).rejects.toMatchObject({ retryable: false });
  });

  it("refuses a window screenshot on a desktop that reports no geometry", async () => {
    const backend = backendWith(
      providersOf({ windows: resolvedProvider(fakeWindows([WINDOW_WITHOUT_BOUNDS])) }),
    );

    await expect(
      backend.captureScreenshot({ kind: "window", windowId: "toplevel-1" }),
    ).rejects.toThrow(/reports no geometry.*windowBounds is false/s);
  });

  it("still captures a region on that same desktop, which is the documented workaround", async () => {
    const backend = backendWith(
      providersOf({ windows: resolvedProvider(fakeWindows([WINDOW_WITHOUT_BOUNDS])) }),
    );
    const screenshot = await backend.captureScreenshot({
      kind: "region",
      region: { x: 100, y: 100, width: 400, height: 300 },
    });

    expect(screenshot.region).toEqual({ x: 100, y: 100, width: 400, height: 300 });
    expect(screenshot.scale).toBe(1);
  });

  it("names the provider when a window provider cannot activate or raise", async () => {
    const backend = backendWith(
      providersOf({ windows: resolvedProvider(fakeWindows([WINDOW_WITHOUT_BOUNDS])) }),
    );

    await expect(backend.focusWindow("toplevel-1")).rejects.toThrow(
      /wlr-foreign-toplevel.*cannot activate/s,
    );
    await expect(backend.raiseWindow("toplevel-1")).rejects.toThrow(
      /wlr-foreign-toplevel.*no stacking control/s,
    );
  });

  it("refuses a semantic action rather than clicking at a guessed coordinate", async () => {
    const backend = backendWith(providersOf());

    await expect(
      backend.setValue(
        {
          target: {},
          point: { x: 1, y: 1 },
          node: {
            role: "entry",
            label: "Search",
            value: null,
            description: null,
            frame: { x: 0, y: 0, width: 10, height: 10 },
            activationPoint: null,
            onScreen: true,
            windowId: null,
            children: [],
          },
        },
        "hello",
      ),
    ).rejects.toThrow(/"Search".*accessibility-tree/s);
  });

  it("fails an attach before subscribing when there is no capture provider", async () => {
    const backend = backendWith(providersOf({ capture: missingProvider("no screencopy") }));

    await expect(backend.attachStream(() => undefined)).rejects.toThrow(
      /Streaming the screen is not available/,
    );
  });
});

describe("PortalComputerBackend input", () => {
  it("drives the shared pointer sequencing, not a per-desktop copy of it", async () => {
    const input = fakeInput();
    const backend = backendWith(providersOf({ input: resolvedProvider(input) }));
    await backend.click({ x: 400, y: 300 });

    expect(input.calls.at(-2)).toBe(`${POINTER_SEQUENCE_OPERATIONS.buttonPress} 272 true`);
    expect(input.calls.at(-1)).toBe(`${POINTER_SEQUENCE_OPERATIONS.buttonRelease} 272 false`);
    expect(input.calls.filter((call) => call.startsWith("movePointer")).at(-1)).toBe(
      "movePointer 400,300",
    );
  });

  it("releases the drag button even when the glide to the destination fails", async () => {
    // A transport that dies mid-drag is the realistic version of this. A button
    // left down would drag the desktop under every later pointer move, so the
    // release has to survive the failure that interrupted it.
    const input = fakeInput();
    const failing: PortalInputProvider = {
      ...input,
      sink: {
        ...input.sink,
        movePointer: (x, y, operation) =>
          x === 800
            ? Promise.reject(new Error("transport closed"))
            : input.sink.movePointer(x, y, operation),
      },
    };
    const backend = backendWith(providersOf({ input: resolvedProvider(failing) }));

    await expect(backend.drag({ x: 0, y: 0 }, { x: 800, y: 0 }, 0)).rejects.toThrow(
      "transport closed",
    );
    expect(input.calls.at(-1)).toBe(`${POINTER_SEQUENCE_OPERATIONS.buttonRelease} 272 false`);
  });

  it("refuses every mutating action when no input provider resolved", async () => {
    const backend = backendWith(providersOf({ input: missingProvider("no virtual pointer") }));

    for (const action of [
      () => backend.click({ x: 1, y: 1 }),
      () => backend.moveCursor({ x: 1, y: 1 }),
      () => backend.typeText("hi"),
      () => backend.pressKey("enter"),
      () => backend.hotkey(["ctrl", "c"]),
      () => backend.scroll(null, 0, 10),
    ]) {
      await expect(action()).rejects.toThrow(/no virtual pointer/);
    }
  });
});

describe("PortalComputerBackend shared seat", () => {
  const HUMAN_AT_THE_KEYBOARD: SeatActivity = { state: "active", datedInputMs: 0 };

  function seatProviders(
    activity: SeatActivity,
    overrides: Partial<PortalProviders> = {},
  ): PortalProviders {
    return providersOf({
      windows: resolvedProvider(fakeWindows([WINDOW_WITHOUT_BOUNDS], { activate: true })),
      clipboard: resolvedProvider(fakeClipboard()),
      seatIdle: { sample: () => Promise.resolve(activity), dispose: () => Promise.resolve() },
      ...overrides,
    });
  }

  it("refuses every mutating action while the human is using the seat", async () => {
    const input = fakeInput();
    const backend = backendWith(
      seatProviders(HUMAN_AT_THE_KEYBOARD, { input: resolvedProvider(input) }),
    );

    for (const action of [
      () => backend.click({ x: 1, y: 1 }),
      () => backend.doubleClick({ x: 1, y: 1 }),
      () => backend.rightClick({ x: 1, y: 1 }),
      () => backend.moveCursor({ x: 1, y: 1 }),
      () => backend.drag({ x: 0, y: 0 }, { x: 10, y: 10 }, 0),
      () => backend.scroll(null, 0, 10),
      () => backend.typeText("hi"),
      () => backend.pressKey("enter"),
      () => backend.hotkey(["ctrl", "c"]),
      () => backend.focusWindow("toplevel-1"),
      () => backend.writeClipboard("copied"),
    ]) {
      await expect(action()).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);
    }
    // Nothing reached the compositor: the guard runs before the action, not
    // around a half-delivered one.
    expect(input.calls).toEqual([]);
  });

  it("keeps perception running while it is waiting for the human", async () => {
    const backend = backendWith(seatProviders(HUMAN_AT_THE_KEYBOARD));

    await expect(
      backend.captureScreenshot({ kind: "region", region: WORKSPACE }),
    ).resolves.toMatchObject({ region: WORKSPACE });
    await expect(backend.listWindows()).resolves.toEqual([WINDOW_WITHOUT_BOUNDS]);
    await expect(backend.getScreenSize()).resolves.toMatchObject({ width: 1920 });
    await expect(backend.readClipboard()).resolves.toBe("");
  });

  it("reports the yield in health, where the panel can say who is waiting", async () => {
    const backend = backendWith(seatProviders(HUMAN_AT_THE_KEYBOARD));

    expect(backend.health().seat).toEqual({ observing: true });
    await expect(backend.click({ x: 1, y: 1 })).rejects.toThrow(HUMAN_ACTIVE_REFUSAL);

    expect(backend.health().seat).toEqual({
      observing: true,
      lastYieldAt: new Date(1_700_000_000_000).toISOString(),
    });
  });

  it("acts without waiting once the seat has been quiet for the threshold", async () => {
    const input = fakeInput();
    const backend = backendWith(seatProviders(SEAT_QUIET, { input: resolvedProvider(input) }));

    await backend.click({ x: 400, y: 300 });

    expect(input.calls.at(-1)).toBe(`${POINTER_SEQUENCE_OPERATIONS.buttonRelease} 272 false`);
    expect(backend.health().seat).toEqual({ observing: true });
  });

  it("arms the idle source on first perception, never at construction", async () => {
    // Construction happens at server boot, and on a wlroots desktop the first
    // sample is what spawns the compositor-attached helper — so it must wait
    // for the feature to actually be used.
    let samples = 0;
    const backend = backendWith(
      seatProviders(SEAT_QUIET, {
        seatIdle: {
          sample: () => {
            samples += 1;
            return Promise.resolve(SEAT_QUIET);
          },
          dispose: () => Promise.resolve(),
        },
      }),
    );

    expect(samples).toBe(0);
    await backend.getScreenSize();
    expect(samples).toBe(1);
    await backend.getScreenSize();
    expect(samples).toBe(1);
  });

  it("arbitrates nothing on a seat of the agent's own", async () => {
    // A nested compositor or a dedicated seat has no human to give way to, and
    // an arbiter there would refuse on behalf of somebody who is not in the
    // room — so the idle source is present and deliberately unused.
    const input = { ...fakeInput(), sharedSeat: false };
    const backend = backendWith(
      seatProviders(HUMAN_AT_THE_KEYBOARD, { input: resolvedProvider(input) }),
    );

    await expect(backend.click({ x: 1, y: 1 })).resolves.toMatchObject({ point: { x: 1, y: 1 } });
    expect(backend.health().seat).toBeUndefined();
  });

  it("stands down with the source's own sentence rather than refusing forever", async () => {
    const input = fakeInput();
    const backend = backendWith(
      seatProviders(HUMAN_AT_THE_KEYBOARD, {
        input: resolvedProvider(input),
        seatIdle: {
          sample: () =>
            Promise.reject(
              new ComputerBackendError("org.gnome.Mutter.IdleMonitor is not on the session bus.", {
                retryable: false,
              }),
            ),
          dispose: () => Promise.resolve(),
        },
      }),
    );

    // Fails open: yielding is a courtesy the user already consented past, so a
    // broken idle clock must not take desktop control down with it.
    await expect(backend.click({ x: 1, y: 1 })).resolves.toMatchObject({ point: { x: 1, y: 1 } });
    expect(backend.health().seat).toEqual({
      observing: false,
      reason: expect.stringContaining("org.gnome.Mutter.IdleMonitor"),
    });
  });

  it("releases the idle source's share of the helper on dispose", async () => {
    let disposals = 0;
    const backend = backendWith(
      seatProviders(HUMAN_AT_THE_KEYBOARD, {
        seatIdle: {
          sample: () => Promise.resolve(HUMAN_AT_THE_KEYBOARD),
          dispose: () => {
            disposals += 1;
            return Promise.resolve();
          },
        },
      }),
    );

    await backend.dispose();

    expect(disposals).toBe(1);
  });
});

describe("PortalComputerBackend perception", () => {
  it("clips a capture request to the desktop and reports the region it really got", async () => {
    const capture = fakeCapture();
    const backend = backendWith(providersOf({ capture: resolvedProvider(capture) }));
    const screenshot = await backend.captureScreenshot({
      kind: "region",
      region: { x: 1800, y: 1000, width: 400, height: 400 },
    });

    expect(capture.requests.at(-1)).toEqual({ x: 1800, y: 1000, width: 120, height: 80 });
    expect(screenshot.region).toEqual({ x: 1800, y: 1000, width: 120, height: 80 });
  });

  it("falls back to the configured ceiling when maxDimension is not a number of pixels", async () => {
    // `Math.max(1, Math.min(32768, Math.floor(NaN)))` is NaN, and it used to
    // flow all the way into captureRegion — a request for a NaN-by-NaN image
    // instead of a refusal or a clamp. The KWin backend guards for finiteness
    // in `normalizeDimension`; both clamps have to agree, because a screenshot
    // must mean the same thing on either desktop.
    const capture = fakeCapture();
    const backend = backendWith(providersOf({ capture: resolvedProvider(capture) }), {
      captureMaxDimension: Number.NaN,
    });
    const screenshot = await backend.captureScreenshot({
      kind: "region",
      region: { x: 0, y: 0, width: 1920, height: 1080 },
      maxDimension: Number.NaN,
    });

    expect(capture.requests.at(-1)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(Number.isFinite(screenshot.scale)).toBe(true);
    expect(screenshot.region).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("refuses a region entirely off the desktop rather than returning blank pixels", async () => {
    const backend = backendWith(providersOf());

    await expect(
      backend.captureScreenshot({
        kind: "region",
        region: { x: 5000, y: 5000, width: 10, height: 10 },
      }),
    ).rejects.toThrow(/lies outside the desktop/);
  });

  it("reads the screen size from the capture provider's workspace rect", async () => {
    await expect(backendWith(providersOf()).getScreenSize()).resolves.toEqual({
      width: 1920,
      height: 1080,
      scale: 1,
    });
  });

  it("requires the window provider for getState, because the windows field cannot say unknown", async () => {
    await expect(backendWith(providersOf()).getState({})).rejects.toThrow(/Listing windows/);
    const withWindows = backendWith(
      providersOf({ windows: resolvedProvider(fakeWindows([WINDOW_WITHOUT_BOUNDS])) }),
    );

    await expect(withWindows.getState({ includeScreenshot: true })).resolves.toMatchObject({
      windows: [WINDOW_WITHOUT_BOUNDS],
      screenSize: { width: 1920, height: 1080 },
    });
  });
});

describe("PortalComputerBackend negative-origin layouts", () => {
  // A monitor left of or above the primary puts the desktop's top-left at
  // negative layout coordinates. The providers speak that space; the agent
  // speaks 0..screenSize. These pin the translation at the backend boundary —
  // the same contract the KWin backend keeps — because a screenshot that shows
  // pixels the agent cannot click is exactly the bug this exists to prevent.
  const SHIFTED: ComputerRect = { x: -1920, y: -1080, width: 3840, height: 2160 };

  it("clicks in agent space and drives the sink in layout space", async () => {
    const input = fakeInput();
    const backend = backendWith(
      providersOf({
        input: resolvedProvider(input),
        capture: resolvedProvider(fakeCapture(SHIFTED)),
      }),
    );
    // Perception first, as in a real turn: the origin comes from the freshest
    // workspace read, and before one exists the backend can only assume (0,0).
    await backend.getScreenSize();
    await backend.click({ x: 200, y: 100 });

    expect(input.calls.filter((call) => call.startsWith("movePointer")).at(-1)).toBe(
      "movePointer -1720,-980",
    );
  });

  it("reports window bounds in agent space", async () => {
    const backend = backendWith(
      providersOf({
        capture: resolvedProvider(fakeCapture(SHIFTED)),
        windows: resolvedProvider(
          fakeWindows(
            [
              {
                ...WINDOW_WITHOUT_BOUNDS,
                bounds: { x: -1800, y: -1000, width: 640, height: 480 },
              },
            ],
            { providesBounds: true },
          ),
        ),
      }),
    );

    const windows = await backend.listWindows();
    expect(windows[0]?.bounds).toEqual({ x: 120, y: 80, width: 640, height: 480 });
  });

  it("captures an agent-space region against the layout-space desktop and answers in agent space", async () => {
    const capture = fakeCapture(SHIFTED);
    const backend = backendWith(providersOf({ capture: resolvedProvider(capture) }));

    const screenshot = await backend.captureScreenshot({
      kind: "region",
      region: { x: 100, y: 50, width: 400, height: 300 },
    });

    expect(capture.requests.at(-1)).toEqual({ x: -1820, y: -1030, width: 400, height: 300 });
    expect(screenshot.region).toEqual({ x: 100, y: 50, width: 400, height: 300 });
  });

  it("keeps the whole desktop addressable: agent space spans 0..screenSize", async () => {
    const capture = fakeCapture(SHIFTED);
    const backend = backendWith(providersOf({ capture: resolvedProvider(capture) }));

    await expect(backend.getScreenSize()).resolves.toEqual({
      width: 3840,
      height: 2160,
      scale: 1,
    });
    // The far corner of the bottom-right monitor is reachable...
    const corner = await backend.captureScreenshot({
      kind: "region",
      region: { x: 3800, y: 2100, width: 40, height: 60 },
    });
    expect(capture.requests.at(-1)).toEqual({ x: 1880, y: 1020, width: 40, height: 60 });
    expect(corner.region).toEqual({ x: 3800, y: 2100, width: 40, height: 60 });
    // ...and a request outside it refuses in agent space, not layout space.
    await expect(
      backend.captureScreenshot({
        kind: "region",
        region: { x: 4000, y: 2200, width: 10, height: 10 },
      }),
    ).rejects.toThrow(/lies outside the desktop 0,0 3840×2160|lies outside the desktop/);
  });
});

describe("PortalComputerBackend lifecycle", () => {
  it("disposes every resolved provider even when one of them throws", async () => {
    const failing: PortalClipboardProvider = {
      ...fakeClipboard(),
      dispose: () => Promise.reject(new Error("session already gone")),
    };
    const windows = fakeWindows([]);
    const disposeWindows = vi.spyOn(windows, "dispose");
    const backend = backendWith(
      providersOf({ clipboard: resolvedProvider(failing), windows: resolvedProvider(windows) }),
    );

    await expect(backend.dispose()).resolves.toBeUndefined();
    expect(disposeWindows).toHaveBeenCalledOnce();
    await expect(backend.listWindows()).rejects.toThrow("has been disposed");
  });
});

describe("createPortalComputerBackend", () => {
  it("resolves the providers from the probe when none are supplied", async () => {
    const backend = createPortalComputerBackend(
      probeFor({
        desktop: "gnome",
        portal: {
          present: true,
          remoteDesktopVersion: 2,
          screenCastVersion: 5,
          availableDeviceTypes: REMOTE_DESKTOP_DEVICE_POINTER,
        },
      }),
      {
        platform: "linux",
        // Without the seam the arbiter would arm the real
        // `org.gnome.Mutter.IdleMonitor` on this machine's session bus.
        providerOptions: {
          createSeatIdleSource: () => ({ sample: () => Promise.resolve(SEAT_QUIET) }),
        },
      },
    );

    // The portal session is built lazily, so resolving providers raises no
    // dialog and touches no bus until something actually asks for input.
    expect(backend.providerPlan().input.implementation).toBe("portal-remote-desktop");
    expect(backend.capabilities().input).toBe(true);
    expect(backend.capabilities().capture).toBe(false);
    const availability = await backend.availability();
    expect(availability.kind === "backend-unavailable" && availability.message).toContain(
      "PipeWire",
    );
    await backend.dispose();
  });
});

describe("PortalComputerBackend launchApp", () => {
  it("spawns the resolved command with the caller's arguments and reports it back", async () => {
    const spawned: Array<{ app: string; args: readonly string[] }> = [];
    const backend = backendWith(providersOf(), {
      resolveApp: (app, args) => ({
        command: `/var/lib/flatpak/exports/bin/${app}`,
        args: [...args],
        via: "flatpak-export",
      }),
      spawnProcess: (app, args) => {
        spawned.push({ app, args });
        const child = new EventEmitter() as unknown as ChildProcess;
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    });

    await expect(
      backend.launchApp("app.zen_browser.zen", ["--new-window", "https://example.com"]),
    ).resolves.toMatchObject({
      app: "app.zen_browser.zen",
      resolvedCommand: "/var/lib/flatpak/exports/bin/app.zen_browser.zen",
    });
    expect(spawned).toEqual([
      {
        app: "/var/lib/flatpak/exports/bin/app.zen_browser.zen",
        args: ["--new-window", "https://example.com"],
      },
    ]);
    await backend.dispose();
  });

  it("refuses an unresolvable name without spawning anything", async () => {
    const spawnProcess = vi.fn();
    const backend = backendWith(providersOf(), {
      resolveApp: () => {
        throw new ComputerBackendError('nothing named "ghost"');
      },
      spawnProcess: spawnProcess as never,
    });

    await expect(backend.launchApp("ghost", [])).rejects.toThrow('nothing named "ghost"');
    expect(spawnProcess).not.toHaveBeenCalled();
    await backend.dispose();
  });
});
