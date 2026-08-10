// FILE: shellSessionExit.test.ts
// Purpose: Verifies the one exit path for a repudiated session: where a signed-out client belongs,
//          the best-effort clear, and the once-per-pairing redirect to the connect screen.
// Layer: Web auth support tests
// Depends on: mocked ~/env, ~/shellSession and ~/appHistoryMode (only the href it would build for
//             the connect route matters here, not the history mode itself).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_SIGNED_OUT_PATH } from "./authSignedOut";
import {
  forgetShellSession,
  handleShellSessionRevoked,
  resetShellSessionExitStateForTests,
  signedOutRoutePath,
} from "./shellSessionExit";

// Live binding read through a getter so one test file can exercise both shells.
let mobileShell = false;

vi.mock("./env", () => ({
  get isMobileShell() {
    return mobileShell;
  },
  get isNativeShell() {
    return mobileShell;
  },
  isElectron: false,
  appRuntime: "browser",
}));

const clearSession = vi.fn<() => Promise<void>>(() => Promise.resolve());
let pairingGeneration = 0;
vi.mock("./shellSession", () => ({
  clearShellSession: () => clearSession(),
  getShellPairingGeneration: () => pairingGeneration,
}));

vi.mock("./appHistoryMode", () => ({
  appRouteDocumentHref: (path: string, searchParams?: URLSearchParams) =>
    `#${path}${searchParams ? `?${searchParams.toString()}` : ""}`,
}));

const assign = vi.fn();

beforeEach(() => {
  mobileShell = true;
  pairingGeneration = 1;
  clearSession.mockResolvedValue(undefined);
  vi.stubGlobal("window", { location: { assign } });
});

afterEach(() => {
  resetShellSessionExitStateForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("signedOutRoutePath", () => {
  it("sends the mobile shell to pairing and every other runtime to the signed-out screen", () => {
    expect(signedOutRoutePath(AUTH_SIGNED_OUT_PATH)).toBe("/connect");
    mobileShell = false;
    expect(signedOutRoutePath(AUTH_SIGNED_OUT_PATH)).toBe(AUTH_SIGNED_OUT_PATH);
  });
});

describe("forgetShellSession", () => {
  it("drops the stored pairing on the mobile shell", async () => {
    await forgetShellSession();
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it("touches nothing off the mobile shell", async () => {
    mobileShell = false;
    await forgetShellSession();
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("resolves even when secure storage refuses the delete", async () => {
    // The session is already unusable in memory by then, and every caller has a user-facing job
    // to finish — a sign-out must not fail because the keystore is locked.
    clearSession.mockRejectedValue(new Error("keystore locked"));
    await expect(forgetShellSession()).resolves.toBeUndefined();
  });
});

describe("handleShellSessionRevoked", () => {
  it("clears the pairing and lands on connect exactly once per pairing", async () => {
    await Promise.all([
      handleShellSessionRevoked(),
      handleShellSessionRevoked(),
      handleShellSessionRevoked(),
    ]);

    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("#/connect?reason=signed-out");
  });

  it("re-arms once this device pairs again", async () => {
    await handleShellSessionRevoked();
    pairingGeneration += 1;
    await handleShellSessionRevoked();

    expect(assign).toHaveBeenCalledTimes(2);
  });

  it("still reaches the connect screen when the clear fails", async () => {
    clearSession.mockRejectedValue(new Error("keystore locked"));

    await expect(handleShellSessionRevoked()).resolves.toBeUndefined();
    expect(assign).toHaveBeenCalledWith("#/connect?reason=signed-out");
  });

  it("does nothing off the mobile shell", async () => {
    // Browsers and the desktop shell have their own signed-out handling; there is no pairing here
    // to forget and no connect screen to send them to.
    mobileShell = false;
    await handleShellSessionRevoked();

    expect(clearSession).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
