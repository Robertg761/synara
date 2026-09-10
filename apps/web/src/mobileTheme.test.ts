import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ setStyle: vi.fn(), setBackground: vi.fn(), mobile: true }));
vi.mock("@capacitor/core", () => ({
  SystemBars: { setStyle: native.setStyle },
  SystemBarsStyle: { Dark: "DARK", Light: "LIGHT" },
}));
vi.mock("./shellBridge", () => ({ setMobileBackgroundColor: native.setBackground }));
vi.mock("./env", () => ({ get isMobileShell() { return native.mobile; } }));

describe("mobile system bar theme", () => {
  beforeEach(() => {
    vi.resetModules();
    native.mobile = true;
    native.setStyle.mockReset().mockResolvedValue(undefined);
    native.setBackground.mockReset().mockResolvedValue(undefined);
  });

  it("maps resolved dark and light themes to matching native icon contrast", async () => {
    const { syncMobileTheme } = await import("./mobileTheme");
    syncMobileTheme("dark", "#121212");
    syncMobileTheme("dark", "#121212");
    syncMobileTheme("light", "#fafafa");
    await vi.waitFor(() => expect(native.setBackground).toHaveBeenCalledTimes(2));
    expect(native.setBackground.mock.calls).toEqual([["#121212"], ["#fafafa"]]);
    expect(native.setStyle.mock.calls).toEqual([[{ style: "DARK" }], [{ style: "LIGHT" }]]);
  });

  it("does not invoke native bars in desktop or browser renderers", async () => {
    native.mobile = false;
    const { syncMobileTheme } = await import("./mobileTheme");
    syncMobileTheme("dark", "#121212");
    syncMobileTheme("light", "#fafafa");
    expect(native.setStyle).not.toHaveBeenCalled();
  });

  it("updates native background when a custom pack changes within the same variant", async () => {
    const { syncMobileTheme } = await import("./mobileTheme");
    syncMobileTheme("dark", "#121212");
    syncMobileTheme("dark", "#202030");
    await vi.waitFor(() => expect(native.setBackground.mock.calls).toEqual([["#121212"], ["#202030"]]));
  });

  it("retries a failed projection when the same theme is applied again", async () => {
    native.setStyle.mockRejectedValueOnce(new Error("Bridge unavailable"));
    const { syncMobileTheme } = await import("./mobileTheme");
    syncMobileTheme("dark", "#121212");
    await vi.waitFor(() => expect(native.setStyle).toHaveBeenCalledTimes(1));
    syncMobileTheme("dark", "#121212");
    await vi.waitFor(() => expect(native.setStyle).toHaveBeenCalledTimes(2));
  });

  it("retries when the native background projection fails", async () => {
    native.setBackground.mockRejectedValueOnce(new Error("Background unavailable"));
    const { syncMobileTheme } = await import("./mobileTheme");
    syncMobileTheme("light", "#fafafa");
    await vi.waitFor(() => expect(native.setBackground).toHaveBeenCalledTimes(1));
    syncMobileTheme("light", "#fafafa");
    await vi.waitFor(() => expect(native.setBackground).toHaveBeenCalledTimes(2));
  });

  it("does not let an older failed request invalidate a newer theme", async () => {
    let rejectOld!: (error: Error) => void;
    native.setStyle.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectOld = reject; }));
    const { syncMobileTheme } = await import("./mobileTheme");
    syncMobileTheme("dark", "#121212");
    syncMobileTheme("light", "#fafafa");
    await vi.waitFor(() => expect(native.setStyle).toHaveBeenCalledTimes(1));
    rejectOld(new Error("Old request failed"));
    await Promise.resolve();
    syncMobileTheme("light", "#fafafa");
    await vi.waitFor(() => expect(native.setStyle).toHaveBeenCalledTimes(2));
  });
});
