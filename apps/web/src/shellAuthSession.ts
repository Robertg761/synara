// FILE: shellAuthSession.ts
// Purpose: Supplies the owner bearer token a native shell needs to call /api/auth/* cross-origin.
//          The desktop shell exchanges its per-launch bootstrap credential for a session; the
//          mobile shell already holds a session token from pairing and just hands it over.
// Layer: Web auth support
// Depends on: ~/env (isMobileShell), ~/shellSession (paired mobile token), ./lib/serverEndpoint,
//             ./lib/bearerBootstrap (the exchange itself, shared with the mobile connect screen)
// Exports: acquireShellBearerToken, invalidateShellBearerToken

import { isMobileShell } from "./env";
import { BEARER_BOOTSTRAP_PATH, requestBearerSession } from "./lib/bearerBootstrap";
import { resolveWsHttpUrl } from "./lib/serverEndpoint";
import { getShellSessionToken } from "./shellSession";

let bearerToken: string | null = null;
let exchangeInFlight: Promise<string | null> | null = null;

function readBootstrapCredential(): string | null {
  try {
    return window.desktopBridge?.remoteAccess?.getAuthBootstrapCredential() ?? null;
  } catch {
    return null;
  }
}

// The desktop shell only cares whether it got a token: every failure mode ends in the same
// unauthenticated retry, so the reason is collapsed here rather than surfaced.
async function exchangeBootstrapCredential(credential: string): Promise<string | null> {
  const result = await requestBearerSession(resolveWsHttpUrl(BEARER_BOOTSTRAP_PATH), credential);
  return result.ok ? result.sessionToken : null;
}

/**
 * Bearer token for the shell window's owner session. On mobile it is the token stored at pairing
 * time (null until `hydrateShellSession` has run, or when the device is unpaired). On desktop it
 * is minted lazily from the shell's per-launch bootstrap credential. Returns null in browsers
 * (they keep the cookie flow) and when the backend runs loopback-only (remote access disabled —
 * the credential is only seeded while enabled).
 */
export async function acquireShellBearerToken(): Promise<string | null> {
  if (isMobileShell) return getShellSessionToken();
  if (bearerToken) return bearerToken;
  const credential = readBootstrapCredential();
  if (!credential) return null;
  // Single-flight so parallel 401 retries don't mint duplicate sessions.
  exchangeInFlight ??= exchangeBootstrapCredential(credential)
    .catch(() => null)
    .then((token) => {
      bearerToken = token;
      exchangeInFlight = null;
      return token;
    });
  return exchangeInFlight;
}

/**
 * Drops the cached token so the next request re-bootstraps (session revoked/expired). Desktop only
 * — the mobile token comes from pairing and cannot be re-minted here, so callers must not retry
 * with it. Mobile revocation runs through `shellSessionExit.ts` instead: an answered 401 (from the
 * ws-ticket mint or any auth route) clears the stored session and sends the device to the connect
 * screen once.
 */
export function invalidateShellBearerToken(): void {
  bearerToken = null;
}
