import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appListeners: new Map<string, (event: any) => void>(),
  notificationListeners: new Map<string, (event: any) => void>(),
  remove: vi.fn().mockResolvedValue(undefined),
  minimize: vi.fn().mockResolvedValue(undefined),
  launch: vi.fn().mockResolvedValue(undefined),
  goBack: vi.fn(),
  canGoBack: false,
  refresh: vi.fn().mockResolvedValue("granted"),
}));
vi.mock("@capacitor/app", () => ({ App: {
  addListener: vi.fn(async (name, handler) => {
    mocks.appListeners.set(name, handler);
    return { remove: mocks.remove };
  }),
  getLaunchUrl: mocks.launch,
  minimizeApp: mocks.minimize,
} }));
vi.mock("@capacitor/local-notifications", () => ({ LocalNotifications: {
  addListener: vi.fn(async (name, handler) => {
    mocks.notificationListeners.set(name, handler);
    return { remove: mocks.remove };
  }),
} }));
vi.mock("./env", () => ({ isMobileShell: true }));
vi.mock("./appNavigation", () => ({
  goBackInAppHistory: mocks.goBack,
  resolveAppNavigationState: () => ({ canGoBack: mocks.canGoBack }),
}));
vi.mock("./shellBridge", () => ({ consumeMobileLaunchUrl: mocks.launch }));
vi.mock("./shellSession", () => ({ getShellServerWsUrl: () => "wss://current.example" }));
vi.mock("./mobileDownloads", () => ({ clearExpiredMobileExports: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./mobileNotifications", () => ({ refreshMobileNotificationPermission: mocks.refresh }));

import { registerBackDismissable, resetMobileBackStackForTests } from "./lib/mobileBackStack";
import { consumeMobilePairingIntent } from "./mobilePairingIntent";
import { startMobileRuntime } from "./mobileRuntime";

let stop: (() => void) | undefined;
const navigate = vi.fn().mockResolvedValue(undefined);
const start = () => {
  stop = startMobileRuntime({ navigate } as unknown as Parameters<typeof startMobileRuntime>[0]);
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appListeners.clear();
  mocks.notificationListeners.clear();
  mocks.canGoBack = false;
  mocks.launch.mockResolvedValue(undefined);
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  stop?.();
  stop = undefined;
  resetMobileBackStackForTests();
  consumeMobilePairingIntent();
  vi.unstubAllGlobals();
});

describe("Android lifecycle integration", () => {
  it("dismisses overlays before navigating, then backgrounds at the root", async () => {
    start();
    const back = () => mocks.appListeners.get("backButton")!({});
    const unregister = registerBackDismissable(() => true);
    back();
    expect(mocks.minimize).not.toHaveBeenCalled();
    unregister();
    mocks.canGoBack = true;
    back();
    expect(mocks.goBack).toHaveBeenCalledOnce();
    mocks.canGoBack = false;
    back();
    expect(mocks.minimize).toHaveBeenCalledOnce();
  });

  it("wakes the shared connection on foreground without starting another client", () => {
    start();
    const wake = vi.fn();
    window.addEventListener("online", wake);
    mocks.appListeners.get("appStateChange")!({ isActive: false });
    expect(wake).not.toHaveBeenCalled();
    mocks.appListeners.get("appStateChange")!({ isActive: true });
    expect(wake).toHaveBeenCalledOnce();
  });

  it("opens only notifications belonging to the current server", () => {
    start();
    const open = mocks.notificationListeners.get("localNotificationActionPerformed")!;
    open({ notification: { extra: { threadId: "thread-1", server: "wss://old.example" } } });
    expect(navigate).not.toHaveBeenCalled();
    open({ notification: { extra: { threadId: "thread-1", server: "wss://current.example" } } });
    expect(navigate).toHaveBeenCalledWith({
      to: "/$threadId", params: { threadId: "thread-1" }, search: {},
    });
  });

  it("consumes pairing links natively and keeps credentials out of history", async () => {
    mocks.launch.mockResolvedValueOnce("synara://pair?server=https://new.example&token=new-secret");
    start();
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: "/connect" });
    expect(consumeMobilePairingIntent()).toEqual({
      serverUrl: "https://new.example", credential: "new-secret",
    });
    mocks.launch.mockResolvedValueOnce(null);
    mocks.appListeners.get("appUrlOpen")!({
      url: "synara://pair?server=https://new.example&token=new-secret",
    });
    await Promise.resolve();
    expect(mocks.launch).toHaveBeenLastCalledWith(
      "synara://pair?server=https://new.example&token=new-secret",
    );
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("removes listeners even when registration resolves after disposal", async () => {
    start();
    stop!();
    stop = undefined;
    await Promise.resolve();
    expect(mocks.remove).toHaveBeenCalledTimes(4);
  });
});
