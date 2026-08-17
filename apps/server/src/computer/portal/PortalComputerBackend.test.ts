import { describe, expect, it, vi } from "vitest";

import type { ComputerRect, ComputerWindow } from "@synara/contracts";

import { ComputerBackendError } from "../ComputerBackend.ts";
import { POINTER_SEQUENCE_OPERATIONS } from "../pointerSequencing.ts";
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

function fakeCapture(): PortalCaptureProvider & { readonly requests: ComputerRect[] } {
  const requests: ComputerRect[] = [];
  return {
    requests,
    id: "wlr-screencopy",
    workspaceRect: () => Promise.resolve(WORKSPACE),
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
    });
  });
});

describe("resolvePortalProviders", () => {
  it("carries the plan's sentence into every slot, phase and all", () => {
    const providers = resolvePortalProviders(
      probeFor({
        waylandGlobals: [WLROOTS_GLOBALS.virtualPointer, WLROOTS_GLOBALS.screencopy],
      }),
    );

    expect(providers.input.available).toBe(false);
    expect(providers.input.available === false && providers.input.reason).toContain(
      "wlroots-virtual-input",
    );
    expect(providers.capture.available === false && providers.capture.reason).toContain("phase B2");
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
    expect(backend.health().status).toBe("unavailable");
  });

  it("clears a latched denial only through an explicit reset", () => {
    const backend = backendWith(providersOf());
    backend.setConsentState("denied", "cancelled");
    backend.setConsentState("not-requested");

    expect(backend.consentState().state).toBe("not-requested");
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
      { platform: "linux" },
    );

    expect(backend.providerPlan().input.implementation).toBe("libei");
    expect(backend.capabilities().input).toBe(false);
    const availability = await backend.availability();
    expect(availability.kind === "backend-unavailable" && availability.message).toContain(
      "not implemented yet",
    );
  });
});
