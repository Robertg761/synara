import { resolveSynaraDesktopFlavor, synaraDesktopIdentity } from "@synara/shared/desktopIdentity";

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

/**
 * Short product label for this window. Desktop flavors that run side by side
 * (canary, development) name themselves so the sidebar identifies which build
 * you are looking at; production and plain browser tabs keep the product name.
 * Resolved at module load because the preload bridge is installed before any
 * app code runs, so the sidebar never paints the wrong name first.
 */
export const appBrandName: string = synaraDesktopIdentity(
  resolveSynaraDesktopFlavor({
    isDevelopment: false,
    requestedFlavor:
      (typeof window !== "undefined" ? window.desktopBridge?.getFlavor?.() : null) ?? undefined,
  }),
).shortDisplayName;

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
