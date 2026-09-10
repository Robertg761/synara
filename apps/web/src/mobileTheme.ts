import { SystemBars, SystemBarsStyle } from "@capacitor/core";

import { isMobileShell } from "./env";
import { setMobileBackgroundColor } from "./shellBridge";
import type { ThemeVariant } from "./theme/theme.logic";

let lastRequestedTheme: string | null = null;
let pending = Promise.resolve();
let requestRevision = 0;

/** Match native status and gesture icons to the shared renderer, including explicit overrides. */
export function syncMobileTheme(theme: ThemeVariant, backgroundColor: string): void {
  const key = `${theme}:${backgroundColor}`;
  if (!isMobileShell || lastRequestedTheme === key) return;

  lastRequestedTheme = key;
  const revision = ++requestRevision;
  // Capacitor calls light icons on a dark background DARK (not LIGHT).
  // Serialize projections: SystemBars also resets the native decor background.
  pending = pending.then(async () => {
    await SystemBars.setStyle({
      style: theme === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
    });
    await setMobileBackgroundColor(backgroundColor);
  }).catch(() => {
    // Allow the next theme projection to retry, without invalidating a newer request.
    if (requestRevision === revision) lastRequestedTheme = null;
  });
}
