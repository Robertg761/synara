// FILE: wsNativeApi.lifecycle.test.ts
// Purpose: Verifies that a transport being retired takes its window wake listeners with it, and
//          that logging out drops the mobile pairing. The 401/revocation rules these paths lean on
//          are owned and tested by lib/authenticatedFetch.
// Layer: Web transport tests
// Depends on: mocked ./wsTransport, ./lib/authenticatedFetch, ./shellSessionExit. Kept apart from
//             wsNativeApi.test.ts, whose mocks describe the default (plain browser) adapter.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWsNativeApi, resetWsNativeApiForTest } from "./wsNativeApi";

const disposeMock = vi.fn(() => Promise.resolve());
let transportState: "open" | "disposed" = "open";
let transportsCreated = 0;

vi.mock("./wsTransport", () => ({
  WsTransport: class MockWsTransport {
    constructor() {
      transportsCreated += 1;
    }
    request = vi.fn(() => Promise.resolve(undefined));
    subscribe = vi.fn(() => () => undefined);
    onStateChange() {
      return () => undefined;
    }
    onCompatibilityIssue() {
      return () => undefined;
    }
    onThreadStreamFailure() {
      return () => undefined;
    }
    getLatestPush() {
      return null;
    }
    getState() {
      return transportState;
    }
    dispose = disposeMock;
  },
}));

// A fresh Response per call: a body can only be read once, so a shared instance would turn any
// unexpected second call into a misleading parse failure rather than a call-count failure.
const authenticatedServerFetch = vi.fn(() =>
  Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "text/json" } })),
);
vi.mock("./lib/authenticatedFetch", () => ({
  authenticatedServerFetch: () => authenticatedServerFetch(),
}));

const forgetShellSession = vi.fn(() => Promise.resolve());
vi.mock("./shellSessionExit", () => ({
  forgetShellSession: () => forgetShellSession(),
  handleShellSessionRevoked: () => Promise.resolve(),
}));

const windowAddEventListener = vi.fn();
const windowRemoveEventListener = vi.fn();
const documentAddEventListener = vi.fn();
const documentRemoveEventListener = vi.fn();

beforeEach(async () => {
  transportState = "open";
  vi.stubGlobal("window", {
    addEventListener: windowAddEventListener,
    removeEventListener: windowRemoveEventListener,
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: documentAddEventListener,
    removeEventListener: documentRemoveEventListener,
  });
  // Retire the adapter singleton rather than re-importing the module: this graph pulls in
  // contracts and shared, and paying that per test is what makes a suite time out under load.
  await resetWsNativeApiForTest();
  transportsCreated = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transport lifecycle", () => {
  it("detaches the wake listeners and forgets the pairing on logout", async () => {
    await createWsNativeApi().server.logoutAuthSession();

    expect(windowRemoveEventListener).toHaveBeenCalledWith("online", expect.any(Function));
    expect(documentRemoveEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    // The server has just revoked this session; the token the mobile shell stored must not survive.
    expect(forgetShellSession).toHaveBeenCalledTimes(1);
    // The listeners self-detach only on their next signal, so they must come off before the
    // transport they would wake is gone.
    expect(windowRemoveEventListener.mock.invocationCallOrder[0]).toBeLessThan(
      disposeMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("detaches the discarded instance's listeners when it replaces a disposed transport", () => {
    createWsNativeApi();
    expect(windowRemoveEventListener).not.toHaveBeenCalled();

    transportState = "disposed";
    createWsNativeApi();

    expect(transportsCreated).toBe(2);
    expect(windowRemoveEventListener).toHaveBeenCalledTimes(1);
    expect(documentRemoveEventListener).toHaveBeenCalledTimes(1);
    expect(windowAddEventListener).toHaveBeenCalledTimes(2);
  });

  it("keeps the live instance and its listeners when nothing was disposed", () => {
    const first = createWsNativeApi();

    expect(createWsNativeApi()).toBe(first);
    expect(transportsCreated).toBe(1);
    expect(windowRemoveEventListener).not.toHaveBeenCalled();
  });
});
