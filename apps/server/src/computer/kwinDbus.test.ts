import { describe, expect, it, vi } from "vitest";

import {
  invokeKWinDbusMethod,
  KWIN_DBUS_CAPTURE_TIMEOUT_MS,
  KWIN_DBUS_DEFAULT_TIMEOUT_MS,
  KWinDbusTimeoutError,
  readStringArray,
} from "./kwinDbus.ts";

describe("KWin D-Bus calls", () => {
  it("times out ordinary and capture calls at their separate limits", async () => {
    vi.useFakeTimers();
    try {
      let ordinarySettled = false;
      const ordinary = invokeKWinDbusMethod(
        { stateJson: () => new Promise(() => undefined) },
        "stateJson",
      );
      ordinary.then(
        () => {
          ordinarySettled = true;
        },
        () => {
          ordinarySettled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(KWIN_DBUS_DEFAULT_TIMEOUT_MS - 1);
      expect(ordinarySettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(ordinary).rejects.toBeInstanceOf(KWinDbusTimeoutError);

      let captureSettled = false;
      const capture = invokeKWinDbusMethod(
        { captureWindow: () => new Promise(() => undefined) },
        "captureWindow",
      );
      capture.then(
        () => {
          captureSettled = true;
        },
        () => {
          captureSettled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(KWIN_DBUS_CAPTURE_TIMEOUT_MS - 1);
      expect(captureSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(capture).rejects.toBeInstanceOf(KWinDbusTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout when a call settles", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        invokeKWinDbusMethod({ stateJson: () => Promise.resolve("ok") }, "stateJson"),
      ).resolves.toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a one-element loaded plugin array as an array", () => {
    expect(readStringArray(["onlyPlugin"])).toEqual(["onlyPlugin"]);
    expect(readStringArray({ signature: "as", value: ["onlyPlugin"] })).toEqual(["onlyPlugin"]);
  });
});
