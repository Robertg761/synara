/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.nativeApi via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 */
export const isElectron =
  typeof window !== "undefined" &&
  (window.desktopBridge !== undefined || window.nativeApi !== undefined);

/**
 * True when running inside the Capacitor mobile shell (Android/iOS WebView).
 * Capacitor injects its global before any web-app code executes, so this is
 * reliable at module load time. The mobile shell must never inject
 * window.nativeApi or window.desktopBridge — those flip isElectron and switch
 * the app onto the injected desktop transport.
 */
export const isMobileShell =
  typeof window !== "undefined" &&
  (
    window as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor?.isNativePlatform?.() === true;

/**
 * True when the app runs inside any native shell (Electron or the Capacitor
 * mobile shell) rather than a plain browser tab. Use this only for decisions
 * shared by every shell (hash history); Electron chrome and bridge capability
 * checks stay on isElectron, mobile platform behavior stays on isMobileShell.
 */
export const isNativeShell = isElectron || isMobileShell;

export type AppRuntime = "electron" | "mobile" | "browser";

/**
 * The shell the app is running in, as a single discriminant. Mirrors the
 * data-runtime attribute written on the document root at startup.
 */
export const appRuntime: AppRuntime = isElectron
  ? "electron"
  : isMobileShell
    ? "mobile"
    : "browser";
