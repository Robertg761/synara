import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ setStyle: vi.fn(), mobile: true }));
vi.mock("@capacitor/core", () => ({
  SystemBars: { setStyle: native.setStyle },
  SystemBarsStyle: { Dark: "DARK", Light: "LIGHT" },
}));
vi.mock("./env", () => ({ get isMobileShell() { return native.mobile; } }));

describe("mobile system bar theme", () => {
  beforeEach(() => {
    vi.resetModules();
    native.mobile = true;
    native.setStyle.mockReset().mockResolvedValue(undefined);
  });

  it("maps resolved dark and light themes to matching native icon contrast", async () => {
    const { syncMobileTheme } = await import("./mobileTheme");
    syncMobileTheme("dark");
    syncMobileTheme("dark");
    syncMobileTheme("light");
    expect(native.setStyle.mock.calls).toEqual([[{ style: "DARK" }], [{ style: "LIGHT" }]]);
  });

  it("does not invoke native bars in desktop or browser renderers", async () => {
    native.mobile = false;
    const { syncMobileTheme } = await import("./mobileTheme");
    syncMobileTheme("dark");
    syncMobileTheme("light");
    expect(native.setStyle).not.toHaveBeenCalled();
  });

  it("retries a failed projection when the same theme is applied again", async () => {
    native.setStyle.mockRejectedValueOnce(new Error("Bridge unavailable"));
    const { syncMobileTheme } = await import("./mobileTheme");
    syncMobileTheme("dark");
    await Promise.resolve();
    syncMobileTheme("dark");
    expect(native.setStyle).toHaveBeenCalledTimes(2);
  });

  it("does not let an older failed request invalidate a newer theme", async () => {
    let rejectOld!: (error: Error) => void;
    native.setStyle.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectOld = reject; }));
    const { syncMobileTheme } = await import("./mobileTheme");
    syncMobileTheme("dark");
    syncMobileTheme("light");
    rejectOld(new Error("Old request failed"));
    await Promise.resolve();
    syncMobileTheme("light");
    expect(native.setStyle).toHaveBeenCalledTimes(2);
  });
});
