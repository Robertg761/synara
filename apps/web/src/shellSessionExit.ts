// FILE: shellSessionExit.ts
// Purpose: The single way out of the authenticated app when this device's session is gone. Every
//          path that learns the server no longer honours the paired bearer — a 401 from the
//          upgrade-ticket mint, a 401 from an /api/auth route, an explicit sign-out — routes
//          through here, so the credential is dropped and the destination is decided once.
// Layer: Web auth support
// Depends on: ~/env (isMobileShell), ~/shellSession (the stored pairing), ./appHistoryMode,
//             ./connectRouteSearch
// Exports: signedOutRoutePath, forgetShellSession, handleShellSessionRevoked,
//          resetShellSessionExitStateForTests

// Not ./appNavigation: this module is reachable from under the transport, and importing the
// navigation module would pull in React and construct a router history just to build one href.
import { appRouteDocumentHref } from "./appHistoryMode";
import { CONNECT_ROUTE_PATH, connectRouteSearchParams } from "./connectRouteSearch";
import { isMobileShell } from "./env";
import { clearShellSession, getShellPairingGeneration } from "./shellSession";

/**
 * Where a client that just lost its session belongs. On the mobile shell the session *is* the
 * pairing and it lives on this device, so the only way back in is the connect screen; every other
 * runtime keeps the in-app signed-out screen it asked for.
 */
export function signedOutRoutePath(fallbackPath: string): string {
  return isMobileShell ? CONNECT_ROUTE_PATH : fallbackPath;
}

/**
 * Drop the pairing this device stores, best effort. A no-op off the mobile shell, and never
 * rejecting: `clearShellSession` drops the session from memory before it touches storage, so a
 * keystore that refuses the delete still leaves the repudiated token unusable in this process,
 * and every caller has a user-facing job to finish either way.
 */
export async function forgetShellSession(): Promise<void> {
  if (!isMobileShell) return;
  await clearShellSession().catch(() => undefined);
}

// A revoked session fails every request and every socket at once, and the redirect below is a
// one-way trip out of the authenticated app, so it must happen exactly once per pairing no matter
// how many 401s arrive together. Keyed by pairing generation rather than latched for the process:
// the redirect is a hash navigation on mobile, so this module outlives re-pairing, and the next
// pairing has to be revocable too — including when it is revoked before its first success.
let handledRevocationPairing: number | null = null;

/**
 * Forget the pairing and send this device back to the connect screen, saying why. Clearing comes
 * first and unconditionally: a token the server has repudiated must not survive on the device
 * even if the navigation is somehow blocked.
 */
export async function handleShellSessionRevoked(): Promise<void> {
  if (!isMobileShell) return;
  const pairing = getShellPairingGeneration();
  if (handledRevocationPairing === pairing) return;
  handledRevocationPairing = pairing;
  await forgetShellSession();
  window.location.assign(
    appRouteDocumentHref(CONNECT_ROUTE_PATH, connectRouteSearchParams("signed-out")),
  );
}

export function resetShellSessionExitStateForTests(): void {
  handledRevocationPairing = null;
}
