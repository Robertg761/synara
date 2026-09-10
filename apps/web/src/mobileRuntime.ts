// The Android shell delegates feature work to the shared renderer. This module connects
// OS navigation/lifecycle events to the same routing and reconnect paths desktop uses.
import { App } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { ThreadId } from "@synara/contracts";

import { goBackInAppHistory, resolveAppNavigationState } from "./appNavigation";
import { isMobileShell } from "./env";
import { dismissMobileOverlay } from "./lib/mobileOverlayBack";
import { registerBackDismissable, handleMobileBack } from "./lib/mobileBackStack";
import { parseMobilePairingIntent, receiveMobilePairingIntent } from "./mobilePairingIntent";
import { clearExpiredMobileExports } from "./mobileDownloads";
import { refreshMobileNotificationPermission } from "./mobileNotifications";
import type { getRouter } from "./router";
import { consumeMobileLaunchUrl } from "./shellBridge";
import { getShellServerWsUrl } from "./shellSession";

export function startMobileRuntime(router: ReturnType<typeof getRouter>): () => void {
  if (!isMobileShell) return () => {};
  let disposed = false;
  const stopOverlayBack = registerBackDismissable(() =>
    typeof document !== "undefined" && dismissMobileOverlay(document),
  );
  const handles: PluginListenerHandle[] = [];
  const report = () => {
    // Native payloads can contain credentials: do not log the error or the event.
    console.warn("A mobile device integration could not be initialized.");
  };
  const listen = (pending: Promise<PluginListenerHandle>) => {
    void pending.then((handle) => {
      if (disposed) void handle.remove();
      else handles.push(handle);
    }).catch(report);
  };
  const openUrl = (value: string) => {
    const intent = parseMobilePairingIntent(value);
    if (!intent || disposed) return;
    receiveMobilePairingIntent(intent);
    void router.navigate({ to: "/connect" }).catch(report);
  };

  const consumeUrl = (expectedUrl?: string) => {
    void consumeMobileLaunchUrl(expectedUrl).then((url) => {
      if (url) openUrl(url);
    }).catch(report);
  };
  listen(App.addListener("appUrlOpen", ({ url }) => consumeUrl(url)));
  consumeUrl();

  listen(App.addListener("backButton", () => {
    if (disposed) return;
    const outcome = handleMobileBack({
      canGoBack: () => resolveAppNavigationState().canGoBack,
      goBack: () => goBackInAppHistory(),
    });
    if (outcome === "exit") void App.minimizeApp().catch(report);
  }));
  listen(App.addListener("appStateChange", ({ isActive }) => {
    if (!isActive || disposed) return;
    // Uses the transport's existing throttled wake probe, not a second reconnect loop.
    window.dispatchEvent(new Event("online"));
    void refreshMobileNotificationPermission().catch(report);
  }));
  listen(LocalNotifications.addListener("localNotificationActionPerformed", ({ notification }) => {
    if (disposed) return;
    const extra: unknown = notification.extra;
    if (!extra || typeof extra !== "object") return;
    const { threadId, server } = extra as { threadId?: unknown; server?: unknown };
    // Old notifications from a previous pairing must not open another server's thread.
    if (server !== getShellServerWsUrl() || typeof threadId !== "string" || !threadId.trim()) return;
    void router.navigate({
      to: "/$threadId",
      params: { threadId: ThreadId.makeUnsafe(threadId) },
      search: {},
    }).catch(report);
  }));
  void refreshMobileNotificationPermission().catch(report);
  void clearExpiredMobileExports().catch(report);

  return () => {
    disposed = true;
    stopOverlayBack();
    for (const handle of handles.splice(0)) void handle.remove().catch(report);
  };
}
