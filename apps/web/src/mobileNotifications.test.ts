import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  createChannel: vi.fn().mockResolvedValue(undefined),
  schedule: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@capacitor/local-notifications", () => ({ LocalNotifications: native }));
vi.mock("./shellSession", () => ({ getShellServerWsUrl: () => "wss://fixture.example" }));

import {
  readMobileNotificationPermission,
  refreshMobileNotificationPermission,
  requestMobileNotificationPermission,
  showMobileNotification,
} from "./mobileNotifications";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

describe("Android notification presentation", () => {
  it("refreshes cached permission and tells settings when the OS permission changes", async () => {
    const changed = vi.fn();
    window.addEventListener("synara:notification-permission", changed);
    native.checkPermissions.mockResolvedValue({ display: "denied" });
    expect(await refreshMobileNotificationPermission()).toBe("denied");
    expect(readMobileNotificationPermission()).toBe("denied");
    native.requestPermissions.mockResolvedValue({ display: "granted" });
    expect(await requestMobileNotificationPermission()).toBe("granted");
    expect(readMobileNotificationPermission()).toBe("granted");
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("does not schedule an alert after permission is revoked", async () => {
    native.checkPermissions.mockResolvedValue({ display: "denied" });
    expect(await showMobileNotification({ title: "Done", body: "Task finished" })).toBe(false);
    expect(native.schedule).not.toHaveBeenCalled();
  });

  it("ties immediate notification taps to their thread and server without exact alarms", async () => {
    native.checkPermissions.mockResolvedValue({ display: "granted" });
    const input = { title: "Done", body: "Task finished", threadId: "thread-1" };
    expect(await showMobileNotification(input)).toBe(true);
    await showMobileNotification(input);
    const alert = native.schedule.mock.calls[0]![0].notifications[0];
    expect(alert).toMatchObject({
      title: input.title,
      body: input.body,
      isExactNotification: false,
      extra: { threadId: input.threadId, server: "wss://fixture.example" },
    });
    expect(alert.id).toBeGreaterThan(0);
    expect(alert.schedule).toBeUndefined();
    expect(native.schedule.mock.calls[1]![0].notifications[0].id).toBe(alert.id);
  });

  it("propagates native delivery failures instead of reporting success", async () => {
    native.checkPermissions.mockResolvedValue({ display: "granted" });
    native.schedule.mockRejectedValueOnce(new Error("OS notification failure"));
    await expect(showMobileNotification({ title: "Done", body: "Task finished" }))
      .rejects.toThrow("OS notification failure");
  });
});
