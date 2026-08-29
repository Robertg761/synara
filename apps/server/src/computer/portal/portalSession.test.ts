import { describe, expect, it } from "vitest";

import type { PortalBus } from "./portalBus.ts";
import {
  callPortalRequest,
  PORTAL_RESPONSE_CANCELLED,
  PORTAL_RESPONSE_ENDED,
  PORTAL_RESPONSE_SUCCESS,
} from "./portalRequest.ts";
import { FakePortalService } from "./fakePortalService.ts";
import {
  PortalSession,
  resolveStreamPoint,
  type PortalSessionConsent,
  type PortalSessionOptions,
} from "./portalSession.ts";
import { inMemoryRestoreTokenStore, type PortalRestoreTokenStore } from "./restoreTokenStore.ts";
import { EVDEV_BUTTON_CODES } from "../evdevInput.ts";

function sessionFor(
  portal: FakePortalService,
  overrides: PortalSessionOptions = {},
): { session: PortalSession; consent: { state: PortalSessionConsent; reason?: string }[] } {
  const consent: { state: PortalSessionConsent; reason?: string }[] = [];
  const session = new PortalSession({
    connect: () => Promise.resolve(portal),
    remoteDesktopVersion: 2,
    restoreTokens: inMemoryRestoreTokenStore(),
    onConsentChanged: (state, reason) =>
      consent.push(reason === undefined ? { state } : { state, reason }),
    startTimeoutMs: 1_000,
    ...overrides,
  });
  return { session, consent };
}

describe("PortalSession", () => {
  it("joins RemoteDesktop and ScreenCast on one session handle so absolute motion has a coordinate space", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { session } = sessionFor(portal);

    const state = await session.ensureOpen();

    expect(portal.calls).toEqual([
      "org.freedesktop.portal.RemoteDesktop.CreateSession",
      "org.freedesktop.portal.RemoteDesktop.SelectDevices",
      "org.freedesktop.portal.ScreenCast.SelectSources",
      "org.freedesktop.portal.Clipboard.RequestClipboard",
      "org.freedesktop.portal.RemoteDesktop.Start",
    ]);
    expect(state.sessionHandle).toBe(portal.currentSessionHandle());
    expect(state.streams).toEqual([
      { nodeId: 42, rect: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]);
    await session.dispose();
  });

  it("opens nothing until an action needs it, so no dialog appears at construction", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { session, consent } = sessionFor(portal);

    expect(portal.calls).toEqual([]);
    expect(consent).toEqual([]);

    await session.key(30, true);
    expect(portal.startCount()).toBe(1);
    await session.dispose();
  });

  it("shares one grant between concurrent callers rather than raising two dialogs", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { session } = sessionFor(portal);

    await Promise.all([session.ensureOpen(), session.ensureOpen(), session.ensureOpen()]);

    expect(portal.startCount()).toBe(1);
    await session.dispose();
  });

  it("reports awaiting while the dialog is up and granted once it is answered", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { session, consent } = sessionFor(portal);

    await session.ensureOpen();

    expect(consent.map((entry) => entry.state)).toEqual(["awaiting", "granted"]);
    await session.dispose();
  });

  it("latches a dismissed dialog so the user is never asked twice for the same refusal", async () => {
    const portal = new FakePortalService({
      screenCastVersion: 5,
      startResponse: PORTAL_RESPONSE_CANCELLED,
    });
    const { session, consent } = sessionFor(portal);

    await expect(session.ensureOpen()).rejects.toThrow(
      /dismissed the desktop's screen-sharing dialog/,
    );
    await expect(session.ensureOpen()).rejects.toThrow(
      /dismissed the desktop's screen-sharing dialog/,
    );
    await expect(session.key(30, true)).rejects.toThrow(/dismissed/);

    expect(portal.startCount()).toBe(1);
    expect(consent.at(-1)?.state).toBe("denied");
    expect(session.consentState().state).toBe("denied");
    await session.dispose();
  });

  it("refuses a denied session without retrying, because a retry is another dialog", async () => {
    const portal = new FakePortalService({
      screenCastVersion: 5,
      startResponse: PORTAL_RESPONSE_ENDED,
    });
    const { session } = sessionFor(portal);

    await expect(session.ensureOpen()).rejects.toMatchObject({ retryable: false });
    await session.dispose();
  });

  it("forgets a restore token that produced a denial instead of replaying it", async () => {
    const restoreTokens = inMemoryRestoreTokenStore();
    const granting = new FakePortalService({ screenCastVersion: 5, restoreToken: "token-1" });
    const first = sessionFor(granting, { restoreTokens }).session;
    await first.ensureOpen();
    await first.dispose();

    const denying = new FakePortalService({
      screenCastVersion: 5,
      startResponse: PORTAL_RESPONSE_CANCELLED,
    });
    const second = sessionFor(denying, { restoreTokens }).session;
    expect(denying.optionsByMember.get("SelectDevices")).toBeUndefined();
    await expect(second.ensureOpen()).rejects.toThrow();
    expect(denying.optionsByMember.get("SelectDevices")?.restore_token).toEqual({
      signature: "s",
      value: "token-1",
    });

    const third = sessionFor(new FakePortalService({ screenCastVersion: 5 }), {
      restoreTokens,
    }).session;
    await third.ensureOpen();
    await second.dispose();
    await third.dispose();
  });

  it("asks the portal to remember the grant so a restart is not a second dialog", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5, restoreToken: "token-9" });
    const restoreTokens = inMemoryRestoreTokenStore();
    const { session } = sessionFor(portal, { restoreTokens });

    await session.ensureOpen();

    expect(portal.optionsByMember.get("SelectDevices")?.persist_mode).toEqual({
      signature: "u",
      value: 2,
    });
    await session.dispose();

    const replay = new FakePortalService({ screenCastVersion: 5 });
    const second = sessionFor(replay, { restoreTokens }).session;
    await second.ensureOpen();
    expect(replay.optionsByMember.get("SelectDevices")?.restore_token).toEqual({
      signature: "s",
      value: "token-9",
    });
    await second.dispose();
  });

  it("survives a Response that arrives before the method reply", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5, respondBeforeReply: true });
    const { session } = sessionFor(portal);

    await expect(session.ensureOpen()).resolves.toMatchObject({ devices: 3 });
    await session.dispose();
  });

  it("sends evdev keycodes and stream-relative coordinates", async () => {
    const portal = new FakePortalService({
      screenCastVersion: 5,
      streams: [
        { nodeId: 1, rect: { x: 0, y: 0, width: 1920, height: 1080 } },
        { nodeId: 2, rect: { x: 1920, y: 0, width: 1280, height: 1024 } },
      ],
    });
    const { session } = sessionFor(portal);

    await session.movePointerTo({ x: 2000, y: 40 });
    await session.pointerButton(EVDEV_BUTTON_CODES.left, true);
    await session.key(30, false);
    await session.scroll(0, -150);

    expect(portal.notifications).toEqual([
      { member: "NotifyPointerMotionAbsolute", body: [expect.any(String), {}, 2, 80, 40] },
      {
        member: "NotifyPointerButton",
        body: [expect.any(String), {}, EVDEV_BUTTON_CODES.left, 1],
      },
      { member: "NotifyKeyboardKeycode", body: [expect.any(String), {}, 30, 0] },
      // 150 logical px at 50 px per notch: the portal wire speaks whole wheel
      // notches, so one scroll means the same thing here as on kwin/wlroots.
      { member: "NotifyPointerAxisDiscrete", body: [expect.any(String), {}, 0, -3] },
    ]);
    await session.dispose();
  });

  it("converts scroll pixels to notches, carrying the sub-notch remainder", async () => {
    const portal = new FakePortalService({
      screenCastVersion: 5,
      streams: [{ nodeId: 1, rect: { x: 0, y: 0, width: 1920, height: 1080 } }],
    });
    const { session } = sessionFor(portal);

    // 30 px is under one 50 px notch: nothing goes on the wire, nothing is lost.
    await session.scroll(0, 30);
    expect(portal.notifications).toEqual([]);

    // The carried 30 px plus 30 px crosses the notch; 10 px stays owed.
    await session.scroll(0, 30);
    expect(portal.notifications).toEqual([
      { member: "NotifyPointerAxisDiscrete", body: [expect.any(String), {}, 0, 1] },
    ]);

    // Each axis carries its own remainder: 60 px horizontal is 1 notch + 10 px,
    // unaffected by the vertical axis's 10 px debt.
    await session.scroll(60, 0);
    expect(portal.notifications.at(-1)).toEqual({
      member: "NotifyPointerAxisDiscrete",
      body: [expect.any(String), {}, 1, 1],
    });
    await session.dispose();
  });

  it("reports the union of the granted streams as the workspace", async () => {
    const portal = new FakePortalService({
      screenCastVersion: 5,
      streams: [
        { nodeId: 1, rect: { x: 0, y: 120, width: 1920, height: 1080 } },
        { nodeId: 2, rect: { x: 1920, y: 0, width: 1280, height: 1024 } },
      ],
    });
    const { session } = sessionFor(portal);

    await expect(session.workspaceRect()).resolves.toEqual({
      x: 0,
      y: 0,
      width: 3200,
      height: 1200,
    });
    await session.dispose();
  });

  it("refuses to guess coordinates when the portal reports no monitor position", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5, streams: [{ nodeId: 7 }] });
    const { session } = sessionFor(portal);

    await expect(session.workspaceRect()).rejects.toThrow(
      /did not say where on the desktop it is.*xdg-desktop-portal 1\.16 or newer/s,
    );
    await session.dispose();
  });

  it("stops input the moment the desktop revokes the session mid-action", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { session, consent } = sessionFor(portal);
    const closed: string[] = [];
    session.onClosed((reason) => closed.push(reason));

    await session.ensureOpen();
    portal.revokeSession();

    expect(session.isOpen()).toBe(false);
    expect(closed).toEqual(["The desktop ended the remote-control session."]);
    expect(consent.at(-1)?.state).toBe("not-requested");
    await expect(session.key(30, true)).rejects.toThrow(
      /desktop ended the remote-control session\. The action did not happen.*screen lock.*ask for permission again/s,
    );
    await session.dispose();
  });

  it("lets a revoked session be re-granted, because a screen lock is not a refusal", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { session } = sessionFor(portal);

    await session.ensureOpen();
    portal.revokeSession();
    await expect(session.key(30, true)).rejects.toThrow();
    await session.ensureOpen();

    expect(portal.startCount()).toBe(2);
    expect(session.consentState().state).toBe("granted");
    await session.dispose();
  });

  it("treats a dropped D-Bus connection as the kill switch it is", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { session } = sessionFor(portal);
    const closed: string[] = [];
    session.onClosed((reason) => closed.push(reason));

    await session.ensureOpen();
    portal.dropConnection("the session bus went away");

    expect(closed).toEqual(["The portal D-Bus connection dropped: the session bus went away"]);
    expect(session.isOpen()).toBe(false);
    await session.dispose();
  });

  it("has no clipboard on a RemoteDesktop v1 portal", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5, remoteDesktopVersion: 1 });
    const { session } = sessionFor(portal, { remoteDesktopVersion: 1 });

    await expect(session.clipboardEnabled()).resolves.toBe(false);
    expect(portal.calls).not.toContain("org.freedesktop.portal.Clipboard.RequestClipboard");
    await session.dispose();
  });

  it("has no clipboard when a v2 portal has no Clipboard implementation", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5, clipboardSupported: false });
    const { session } = sessionFor(portal);

    await expect(session.clipboardEnabled()).resolves.toBe(false);
    await session.dispose();
  });

  it("does not join a ScreenCast session on a portal that has none", async () => {
    const portal = new FakePortalService({});
    const { session } = sessionFor(portal, { withScreenCast: false });

    await session.ensureOpen();

    expect(portal.calls).not.toContain("org.freedesktop.portal.ScreenCast.SelectSources");
    await session.dispose();
  });

  it("does not cache a session the desktop ended while the grant was still being written down", async () => {
    // The narrow window between `Start` being answered and the state being
    // published. A screen that locks the instant the user clicks Share lands
    // exactly here: `handleClosed` tears the session down, and the tail of
    // `open()` used to put it straight back — `ensureOpen` returns a cached
    // `state` without ever consulting `revoked`, so the dead handle would be
    // served forever while every notify on it failed.
    const portal = new FakePortalService({ screenCastVersion: 5, restoreToken: "token-race" });
    const store = inMemoryRestoreTokenStore();
    let revoked = false;
    const restoreTokens: PortalRestoreTokenStore = {
      read: (key) => store.read(key),
      write: async (key, token) => {
        if (!revoked) {
          revoked = true;
          portal.revokeSession();
        }
        await store.write(key, token);
      },
      clear: (key) => store.clear(key),
    };
    const { session } = sessionFor(portal, { restoreTokens });

    await expect(session.ensureOpen()).rejects.toMatchObject({ retryable: true });
    expect(session.isOpen()).toBe(false);
    expect(session.consentState().state).not.toBe("granted");
    // One refusal, not two: the revocation is spent by the action that hit it,
    // and the next one asks the user again rather than refusing on a latch.
    await expect(session.ensureOpen()).resolves.toMatchObject({ devices: 3 });
    expect(portal.startCount()).toBe(2);
    await session.dispose();
  });

  it("hands out the libei descriptor the GNOME live spike is owed, and owns none of it", async () => {
    // The one native seam kept past the dead-scaffolding cull, because the
    // Tier 2 plan and the GNOME live checklist both pin it as what the pending
    // live spike times libei against. The contract it is kept under is that the
    // caller owns the fd: nothing here tracks it and dispose() does not close
    // it, so a caller that drops one leaks it.
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { session } = sessionFor(portal);

    await expect(session.connectToEIS()).resolves.toEqual(expect.any(Number));
    expect(portal.calls).toContain("org.freedesktop.portal.RemoteDesktop.ConnectToEIS");
    await session.dispose();
  });

  it("closes the session on disposal so the grant does not outlive the backend", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5 });
    const { session } = sessionFor(portal);

    await session.ensureOpen();
    await session.dispose();

    expect(portal.calls).toContain("org.freedesktop.portal.Session.Close");
    await expect(session.ensureOpen()).rejects.toThrow(/has been shut down/);
  });
});

describe("resolveStreamPoint", () => {
  const streams = [
    { nodeId: 1, rect: { x: 0, y: 0, width: 100, height: 100 } },
    { nodeId: 2, rect: { x: 100, y: 0, width: 100, height: 100 } },
  ];

  it("addresses the monitor a point sits on", () => {
    expect(resolveStreamPoint(streams, { x: 150, y: 20 })).toEqual({ nodeId: 2, x: 50, y: 20 });
  });

  it("clamps a point outside every monitor into the nearest one", () => {
    expect(resolveStreamPoint(streams, { x: 260, y: 20 })).toEqual({ nodeId: 2, x: 99, y: 20 });
  });

  it("has no answer when no stream reports a position", () => {
    expect(resolveStreamPoint([{ nodeId: 3 }], { x: 0, y: 0 })).toBeUndefined();
  });
});

describe("portal Request/Response convention", () => {
  it("closes a request it gave up on rather than leaving a live dialog behind", async () => {
    // A `Start` nobody answers is the ordinary shape of a dialog left on screen,
    // so the give-up path has to take the request down with it.
    const portal = new FakePortalService({ screenCastVersion: 5, stall: ["Start"] });
    const { session } = sessionFor(portal, { startTimeoutMs: 20 });

    await expect(session.ensureOpen()).rejects.toThrow(/did not answer .*\.Start within 20 ms/);
    expect(portal.calls).toContain("org.freedesktop.portal.Request.Close");
    await session.dispose();
  });

  it("reports a portal that ignores handle_token instead of waiting on a signal nothing will send", async () => {
    const portal = new FakePortalService({ screenCastVersion: 5, misdirect: ["CreateSession"] });
    const { session } = sessionFor(portal);

    await expect(session.ensureOpen()).rejects.toThrow(/does not honour handle_token/);
    await session.dispose();
  });

  it("observes its own rejection when the bus is already dead, rather than taking the server with it", async () => {
    // `onDisconnected` calls back synchronously on a connection that has
    // already failed, which rejects the response promise before anything is
    // waiting on it; `bus.call` then throws on the same failure, so the
    // `await` that would have observed the rejection is never reached. An
    // unobserved rejection is a process-level `unhandledRejection`, i.e. the
    // whole server going down because a desktop bus dropped.
    const dropped = new Error("the session bus went away");
    const dead: PortalBus = {
      uniqueName: ":1.9",
      call: () =>
        Promise.reject(new Error(`The portal D-Bus connection is gone: ${dropped.message}`)),
      subscribe: () => Promise.resolve(() => undefined),
      onDisconnected: (listener) => {
        listener(dropped);
        return () => undefined;
      },
      close: () => Promise.resolve(),
    };

    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      await expect(
        callPortalRequest(dead, {
          interface: "org.freedesktop.portal.RemoteDesktop",
          member: "CreateSession",
        }),
      ).rejects.toThrow(/connection is gone|went away/);
      // Node reports an unobserved rejection a tick after it happened.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", record);
    }

    expect(unhandled).toEqual([]);
  });

  it("keeps the response codes distinct, because 1 latches and 0 does not", () => {
    expect(PORTAL_RESPONSE_SUCCESS).toBe(0);
    expect(PORTAL_RESPONSE_CANCELLED).toBe(1);
    expect(PORTAL_RESPONSE_ENDED).toBe(2);
  });
});
