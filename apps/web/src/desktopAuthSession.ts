// FILE: desktopAuthSession.ts
// Purpose: Exchanges the desktop shell's per-launch bootstrap credential for an
//          owner bearer session so the window can call /api/auth/* cross-origin.
// Layer: Web auth support
// Exports: acquireDesktopBearerToken, invalidateDesktopBearerToken

import { resolveWsHttpUrl } from "./lib/wsHttpUrl";

let bearerToken: string | null = null;
let exchangeInFlight: Promise<string | null> | null = null;

function readBootstrapCredential(): string | null {
  try {
    return window.desktopBridge?.remoteAccess?.getAuthBootstrapCredential() ?? null;
  } catch {
    return null;
  }
}

async function exchangeBootstrapCredential(credential: string): Promise<string | null> {
  const response = await fetch(resolveWsHttpUrl("/api/auth/bootstrap/bearer"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    readonly sessionToken?: unknown;
  } | null;
  return typeof payload?.sessionToken === "string" && payload.sessionToken.length > 0
    ? payload.sessionToken
    : null;
}

/**
 * Bearer token for the desktop window's owner session, minted lazily from the
 * shell's per-launch bootstrap credential. Returns null outside the desktop app
 * (browsers keep the cookie flow) and when the backend runs loopback-only
 * (remote access disabled — the credential is only seeded while enabled).
 */
export async function acquireDesktopBearerToken(): Promise<string | null> {
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

/** Drops the cached token so the next request re-bootstraps (session revoked/expired). */
export function invalidateDesktopBearerToken(): void {
  bearerToken = null;
}
