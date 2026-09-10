import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  getSession: vi.fn(),
  setSession: vi.fn(),
  clearSession: vi.fn(),
  consumeLaunchUrl: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({ registerPlugin: () => native }));
vi.mock("./env", () => ({ isMobileShell: true }));
import { getMobileBridge } from "./shellBridge";

beforeEach(() => vi.resetAllMocks());

describe("native secure session bridge", () => {
  it("consumes native launch links and treats an empty native result as already consumed", async () => {
    const bridge = getMobileBridge()!;
    const url = "synara://pair?server=https://box.example&token=secret";
    native.consumeLaunchUrl.mockResolvedValueOnce({ url }).mockResolvedValueOnce({});
    expect(await bridge.consumeLaunchUrl()).toBe(url);
    expect(native.consumeLaunchUrl).toHaveBeenLastCalledWith({});
    expect(await bridge.consumeLaunchUrl(url)).toBeNull();
    expect(native.consumeLaunchUrl).toHaveBeenLastCalledWith({ expectedUrl: url });
  });

  it("distinguishes an empty store from a malformed or unavailable store", async () => {
    const bridge = getMobileBridge()!;
    native.getSession.mockResolvedValue({});
    expect(await bridge.session.get()).toBeNull();
    native.getSession.mockResolvedValue({ serverUrl: "https://box.example" });
    await expect(bridge.session.get()).rejects.toThrow("invalid saved connection");
    native.getSession.mockRejectedValue(new Error("keystore unavailable"));
    await expect(bridge.session.get()).rejects.toThrow("keystore unavailable");
  });

  it("propagates failed native writes instead of reporting successful pairing", async () => {
    const session = { serverUrl: "https://box.example", sessionToken: "secret" };
    native.setSession.mockRejectedValue(new Error("disk full"));
    await expect(getMobileBridge()!.session.set(session)).rejects.toThrow("disk full");
    expect(native.setSession).toHaveBeenCalledWith(session);
    native.clearSession.mockRejectedValue(new Error("storage unavailable"));
    await expect(getMobileBridge()!.session.clear()).rejects.toThrow("storage unavailable");
  });
});
