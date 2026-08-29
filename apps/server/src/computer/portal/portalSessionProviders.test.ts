import { describe, expect, it } from "vitest";

import { ComputerBackendError } from "../ComputerBackend.ts";
import { FakePortalService } from "./fakePortalService.ts";
import { createPortalComputerBackend } from "./PortalComputerBackend.ts";
import { PortalSession } from "./portalSession.ts";
import { PortalSelectionClipboardProvider } from "./portalSelectionClipboardProvider.ts";
import { PORTAL_RESPONSE_CANCELLED } from "./portalRequest.ts";
import {
  resolvePortalSessionProviders,
  type PortalSessionProviderOptions,
} from "./portalSessionProviders.ts";
import { planPortalProviders, type PortalProbe } from "./probe.ts";
import { inMemoryRestoreTokenStore } from "./restoreTokenStore.ts";

function gnomeProbe(overrides: Partial<PortalProbe> = {}): PortalProbe {
  return {
    sessionType: "wayland",
    desktop: "gnome",
    kwinPresent: false,
    sessionBusReachable: true,
    portal: {
      present: true,
      remoteDesktopVersion: 2,
      screenCastVersion: 5,
      availableDeviceTypes: 3,
    },
    helperPath: "/home/test/.local/share/synara/computer/synara-computer-desktop-helper",
    desktopExtensionPresent: false,
    wlClipboard: false,
    gaps: [],
    ...overrides,
  };
}

/** The whole GNOME set, wired to one fake portal, as the backend would build it. */
function resolveFor(
  portal: FakePortalService,
  probe: PortalProbe = gnomeProbe(),
  options: PortalSessionProviderOptions = {},
) {
  return resolvePortalSessionProviders(probe, planPortalProviders(probe), {
    createSession: (sessionOptions) =>
      new PortalSession({
        ...sessionOptions,
        connect: () => Promise.resolve(portal),
        restoreTokens: inMemoryRestoreTokenStore(),
        startTimeoutMs: 1_000,
      }),
    ...options,
  });
}

describe("resolvePortalSessionProviders", () => {
  it("gives GNOME input and clipboard from one grant, so one dialog covers both", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const providers = resolveFor(portal);

    expect(providers.input?.available).toBe(true);
    expect(providers.clipboard?.available).toBe(true);
    // Capture and windows are deliberately absent: the plan's sentence answers
    // for them, so a missing PipeWire build never masquerades as a provider.
    expect(providers.capture).toBeUndefined();
    expect(providers.windows).toBeUndefined();

    if (!providers.input?.available || !providers.clipboard?.available)
      throw new Error("unresolved");
    await providers.input.provider.sink.key(30, true, "Typing");
    await providers.clipboard.provider.read().catch(() => undefined);
    expect(portal.startCount()).toBe(1);

    await providers.input.provider.dispose();
    await providers.clipboard.provider.dispose();
  });

  it("keeps the grant alive until the last provider lets go of it", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const providers = resolveFor(portal);
    if (!providers.input?.available || !providers.clipboard?.available)
      throw new Error("unresolved");

    await providers.input.provider.sink.key(30, true, "Typing");
    await providers.input.provider.dispose();
    expect(portal.calls).not.toContain("org.freedesktop.portal.Session.Close");

    await providers.clipboard.provider.dispose();
    expect(portal.calls).toContain("org.freedesktop.portal.Session.Close");
  });

  it("builds no clipboard provider on a RemoteDesktop v1 portal", () => {
    const probe = gnomeProbe({
      portal: {
        present: true,
        remoteDesktopVersion: 1,
        screenCastVersion: 5,
        availableDeviceTypes: 3,
      },
    });
    const providers = resolveFor(new FakePortalService({ remoteDesktopVersion: 1 }), probe);

    expect(providers.input?.available).toBe(true);
    expect(providers.clipboard).toBeUndefined();
    expect(planPortalProviders(probe).clipboard.blockedBy).toMatch(
      /wl-copy and wl-paste are not on PATH and this desktop's portal is too old/,
    );
  });

  it("puts the seat back up when input is disposed mid-chord", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const providers = resolveFor(portal);
    if (!providers.input?.available) throw new Error("unresolved");

    await providers.input.provider.sink.key(29, true, "Typing");
    await providers.input.provider.sink.button(272, true, "Clicking");
    portal.notifications.length = 0;
    await providers.input.provider.dispose();

    expect(portal.notifications).toEqual([
      { member: "NotifyPointerButton", body: [expect.any(String), {}, 272, 0] },
      { member: "NotifyKeyboardKeycode", body: [expect.any(String), {}, 29, 0] },
    ]);
  });
});

describe("PortalSelectionClipboardProvider", () => {
  function clipboardFor(portal: FakePortalService) {
    const session = new PortalSession({
      connect: () => Promise.resolve(portal),
      remoteDesktopVersion: 2,
      restoreTokens: inMemoryRestoreTokenStore(),
    });
    const provider = new PortalSelectionClipboardProvider(session, () => session.dispose(), {
      readFd: (fd) => Promise.resolve(Buffer.from(portal.writtenFds.get(fd) ?? "", "utf8")),
      writeFd: (fd, bytes) => {
        portal.writtenFds.set(fd, bytes.toString("utf8"));
        return Promise.resolve();
      },
    });
    return { session, provider };
  }

  it("reads the selection through the granted session", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    portal.clipboardText = "copied from another window";
    const { provider } = clipboardFor(portal);

    await expect(provider.read()).resolves.toBe("copied from another window");
    await provider.dispose();
  });

  it("claims the selection on write and serves the bytes when something pastes", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { provider } = clipboardFor(portal);

    await provider.write("hello from the agent");
    expect(portal.calls).toContain("org.freedesktop.portal.Clipboard.SetSelection");

    portal.requestSelectionTransfer("text/plain;charset=utf-8", 7);
    await new Promise((resolve) => setImmediate(resolve));

    expect([...portal.writtenFds.values()]).toContain("hello from the agent");
    expect(portal.calls).toContain("org.freedesktop.portal.Clipboard.SelectionWriteDone");
    await provider.dispose();
  });

  it("refuses a paste of a type it cannot produce rather than leaving the asker blocked", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { provider } = clipboardFor(portal);

    await provider.write("text only");
    portal.requestSelectionTransfer("image/png", 9);
    await new Promise((resolve) => setImmediate(resolve));

    expect(portal.calls).toContain("org.freedesktop.portal.Clipboard.SelectionWriteDone");
    expect([...portal.writtenFds.values()]).not.toContain("text only");
    await provider.dispose();
  });

  it("names the missing portal interface when a v2 portal has no clipboard", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5, clipboardSupported: false });
    const { provider } = clipboardFor(portal);

    await expect(provider.read()).rejects.toThrow(
      /granted remote control but no clipboard access.*xdg-desktop-portal 1\.18 or newer/s,
    );
    await provider.dispose();
  });

  it("says the clipboard holds no text rather than returning an empty string", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { session } = clipboardFor(portal);
    const provider = new PortalSelectionClipboardProvider(session, () => session.dispose(), {
      readFd: () => Promise.reject(new Error("no text/plain on the clipboard")),
      writeFd: () => Promise.resolve(),
    });

    await expect(provider.read()).rejects.toThrow(
      /clipboard holds nothing Synara can read as text.*Copy text rather than an image/s,
    );
    await provider.dispose();
  });

  /**
   * A paste target that never writes must not hang `computer_read_clipboard`
   * forever — the bus timeout covers only the descriptor handout, so the read
   * carries a deadline of its own.
   */
  it("abandons a stalled transfer with a structured error instead of waiting forever", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { session } = clipboardFor(portal);
    const provider = new PortalSelectionClipboardProvider(session, () => session.dispose(), {
      // A descriptor whose writer never closes: the real shape of a stalled
      // transfer, short-circuited at the seam so the test measures the
      // deadline rather than the pipe.
      readFd: () => new Promise<Buffer>(() => undefined),
      writeFd: () => Promise.resolve(),
      transferTimeoutMs: 50,
    });
    const startedAt = Date.now();

    await expect(provider.read()).rejects.toThrow(
      /clipboard transfer but sent nothing within 50 ms/,
    );
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await provider.dispose();
  });

  it("propagates a structured read failure instead of negotiating mime types over it", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { session } = clipboardFor(portal);
    const provider = new PortalSelectionClipboardProvider(session, () => session.dispose(), {
      readFd: () =>
        Promise.reject(new ComputerBackendError("the transfer timed out", { retryable: true })),
      writeFd: () => Promise.resolve(),
    });

    // Retrying under the next mime name would stall the same way again.
    await expect(provider.read()).rejects.toThrow(/transfer timed out/);
    await provider.dispose();
  });
});

describe("the GNOME backend's consent projection", () => {
  function backendFor(portal: FakePortalService) {
    const probe = gnomeProbe();
    return createPortalComputerBackend(probe, {
      // Pinned to this probe: the factory's defaults would re-probe the real
      // desktop and install the real helper, and a capture provider found that
      // way would make consent look like the only thing missing.
      recomputeProbe: () => Promise.resolve(probe),
      resolveHelper: () => Promise.resolve({}),
      providerOptions: {
        createSession: (sessionOptions) =>
          new PortalSession({
            ...sessionOptions,
            connect: () => Promise.resolve(portal),
            restoreTokens: inMemoryRestoreTokenStore(),
            startTimeoutMs: 1_000,
          }),
        // A seat nobody is sitting at, so consent is the only thing these tests
        // can be held up by. Without the seam the arbiter would reach for the
        // real `org.gnome.Mutter.IdleMonitor` on the session bus.
        createSeatIdleSource: () => ({
          sample: () => Promise.resolve({ state: "quiet", idleMs: 60_000 }),
        }),
      },
    });
  }

  it("starts at not-requested with no dialog raised", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const backend = backendFor(portal);

    expect(backend.consentState()).toEqual({ state: "not-requested" });
    expect(portal.calls).toEqual([]);
    // Unavailable because GNOME has no capture provider yet, not because consent
    // is outstanding: an unasked grant must never look like a broken backend.
    expect(backend.health().status).toBe("unavailable");
    await backend.dispose();
  });

  it("reports awaiting-consent while the dialog is up, and stays available", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5, stall: ["Start"] });
    const backend = backendFor(portal);

    const click = backend.click({ x: 10, y: 10 }).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));

    expect(backend.consentState().state).toBe("awaiting");
    expect(backend.health().status).toBe("awaiting-consent");
    // A grant that has not been answered is not a broken desktop: availability
    // reports the missing capture provider, never the outstanding dialog.
    await expect(backend.availability()).resolves.toMatchObject({ kind: "backend-unavailable" });
    await backend.dispose();
    await click;
  });

  it("latches a dismissed dialog into the backend's denied state", async () => {
    const portal = new FakePortalService({
      screenCastVersion: 5,
      startResponse: PORTAL_RESPONSE_CANCELLED,
    });
    const backend = backendFor(portal);

    await expect(backend.click({ x: 10, y: 10 })).rejects.toThrow(
      /dismissed the desktop's screen-sharing dialog/,
    );

    expect(backend.consentState()).toEqual({
      state: "denied",
      reason: expect.stringMatching(/Ask for permission again/),
    });
    expect(backend.health().status).toBe("consent-denied");
    await backend.dispose();
  });

  it("names Synara's unwritten PipeWire receiver, not the desktop, when GNOME capture is asked for", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const backend = backendFor(portal);

    await expect(
      backend.captureScreenshot({
        kind: "region",
        region: { x: 0, y: 0, width: 100, height: 100 },
      }),
    ).rejects.toThrow(/delivers frames over PipeWire.*cannot receive PipeWire streams yet/s);
    await backend.dispose();
  });

  it("names the Shell extension, not a missing feature, when GNOME windows are asked for", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const backend = backendFor(portal);

    await expect(backend.listWindows()).rejects.toThrow(
      /GNOME exposes no client-visible window list.*synara-computer-use@synara\.dev Shell extension/s,
    );
    await backend.dispose();
  });
});
