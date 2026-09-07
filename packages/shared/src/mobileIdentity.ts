// FILE: mobileIdentity.ts
// Purpose: Defines the canonical mobile application identity shared by the
//          Capacitor shell, the web bundle it serves, and server trust checks.
// Layer: Shared identity constants
// Exports: SYNARA_MOBILE_APP_ID, SYNARA_MOBILE_APP_HOSTNAME,
//          SYNARA_MOBILE_APP_ORIGIN, SYNARA_MOBILE_CLIENT_BUILD_PREFIX,
//          mobileClientBuild

/**
 * Kept byte-identical to the previous native Android application ID so an
 * in-place upgrade keeps its Keystore entries and SharedPreferences.
 */
export const SYNARA_MOBILE_APP_ID = "com.synara.android";

export const SYNARA_MOBILE_APP_HOSTNAME = "app.synara.local";

/**
 * The Capacitor shell serves the bundle from this origin (https scheme via
 * `androidScheme: "https"`). Changing it orphans every localStorage key the
 * app has written, so treat it as a permanent commitment.
 */
export const SYNARA_MOBILE_APP_ORIGIN = `https://${SYNARA_MOBILE_APP_HOSTNAME}`;

export const SYNARA_MOBILE_CLIENT_BUILD_PREFIX = "mobile-android";

/** Client build identifier reported by the mobile shell during WS negotiation. */
export function mobileClientBuild(version: string): string {
  return `${SYNARA_MOBILE_CLIENT_BUILD_PREFIX}-${version}`;
}
