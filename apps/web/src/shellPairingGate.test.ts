// FILE: shellPairingGate.test.ts
// Purpose: Verifies the gate's three answers and, above all, that a device whose secure storage
//          refused does not stay in a permanently disconnected app.
// Layer: Web app routing tests
// Depends on: mocked ./shellSession and ./appRelaunch

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetShellPairingGateForTests, resolveShellPairingEntry } from "./shellPairingGate";

const hydrateShellSession = vi.fn<() => Promise<"paired" | "unpaired" | "unavailable">>();
vi.mock("./shellSession", () => ({
  hydrateShellSession: () => hydrateShellSession(),
}));

const relaunchAppAtRoot = vi.fn();
vi.mock("./appRelaunch", () => ({
  relaunchAppAtRoot: () => relaunchAppAtRoot(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetShellPairingGateForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  // Discards any recovery timer still pending, so a loop armed here cannot outlive its test.
  vi.useRealTimers();
});

describe("resolveShellPairingEntry", () => {
  it("enters without arming a recovery when the pairing reads back", async () => {
    hydrateShellSession.mockResolvedValue("paired");

    await expect(resolveShellPairingEntry()).resolves.toBe("enter");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(hydrateShellSession).toHaveBeenCalledTimes(1);
    expect(relaunchAppAtRoot).not.toHaveBeenCalled();
  });

  it("sends a device with nothing stored to the connect screen", async () => {
    hydrateShellSession.mockResolvedValue("unpaired");

    await expect(resolveShellPairingEntry()).resolves.toBe("connect");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(relaunchAppAtRoot).not.toHaveBeenCalled();
  });

  it("enters on unreadable storage and relaunches once the read finally succeeds", async () => {
    hydrateShellSession
      .mockResolvedValueOnce("unavailable")
      .mockResolvedValueOnce("unavailable")
      .mockResolvedValue("paired");

    // Never "connect": a keystore that did not answer is not evidence this device is unpaired.
    await expect(resolveShellPairingEntry()).resolves.toBe("enter");
    expect(relaunchAppAtRoot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);

    expect(hydrateShellSession).toHaveBeenCalledTimes(3);
    // The app was loaded with no endpoint and no bearer; only a fresh document rebuilds the
    // endpoint chain and the transport against the server that just became readable.
    expect(relaunchAppAtRoot).toHaveBeenCalledTimes(1);
  });

  it("relaunches on a late unpaired answer so the gate decides on a fresh document", async () => {
    hydrateShellSession.mockResolvedValueOnce("unavailable").mockResolvedValue("unpaired");

    await expect(resolveShellPairingEntry()).resolves.toBe("enter");
    await vi.advanceTimersByTimeAsync(500);

    expect(relaunchAppAtRoot).toHaveBeenCalledTimes(1);
  });

  it("treats a read that throws as storage not answering, in the gate and in the recovery", async () => {
    hydrateShellSession
      .mockRejectedValueOnce(new Error("bridge detached"))
      .mockRejectedValueOnce(new Error("bridge detached"))
      .mockResolvedValue("paired");

    // Never rethrown: this runs in `beforeLoad`, where an error is a route error boundary rather
    // than a decision, and the device is recoverable.
    await expect(resolveShellPairingEntry()).resolves.toBe("enter");
    await vi.advanceTimersByTimeAsync(1_500);

    expect(relaunchAppAtRoot).toHaveBeenCalledTimes(1);
  });

  it("arms one recovery loop however many navigations hit the gate", async () => {
    hydrateShellSession.mockResolvedValue("unavailable");

    await Promise.all([
      resolveShellPairingEntry(),
      resolveShellPairingEntry(),
      resolveShellPairingEntry(),
    ]);
    expect(hydrateShellSession).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(500);

    // One retry, not three: storage is already struggling.
    expect(hydrateShellSession).toHaveBeenCalledTimes(4);
  });

  it("retries on a backoff that caps instead of growing without bound", async () => {
    hydrateShellSession.mockResolvedValue("unavailable");
    await resolveShellPairingEntry();

    // 500, 1000, 2000, 5000, 10000 — five retries in the first 18.5s.
    await vi.advanceTimersByTimeAsync(18_500);
    expect(hydrateShellSession).toHaveBeenCalledTimes(6);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(hydrateShellSession).toHaveBeenCalledTimes(6);

    await vi.advanceTimersByTimeAsync(1);
    expect(hydrateShellSession).toHaveBeenCalledTimes(7);
    expect(relaunchAppAtRoot).not.toHaveBeenCalled();
  });
});
