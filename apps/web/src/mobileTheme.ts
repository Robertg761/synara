import { SystemBars, SystemBarsStyle } from "@capacitor/core";

import { isMobileShell } from "./env";
import type { ThemeVariant } from "./theme/theme.logic";

let lastRequestedTheme: ThemeVariant | null = null;
let requestRevision = 0;

/** Match native status and gesture icons to the shared renderer, including explicit overrides. */
export function syncMobileTheme(theme: ThemeVariant): void {
  if (!isMobileShell || lastRequestedTheme === theme) return;

  lastRequestedTheme = theme;
  const revision = ++requestRevision;
  // Capacitor calls light icons on a dark background DARK (not LIGHT).
  void SystemBars.setStyle({
    style: theme === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
  }).catch(() => {
    // Allow the next theme projection to retry, without invalidating a newer request.
    if (requestRevision === revision) lastRequestedTheme = null;
  });
}
