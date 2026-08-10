// FILE: wsAuthTicket.ts
// Purpose: Mints the single-use ticket the mobile shell must present on every WebSocket upgrade.
//          The Capacitor WebView serves the app from its own origin, so the upgrade carries no
//          session cookie, and no browser lets a WebSocket send an Authorization header. The
//          server therefore accepts a short-lived ticket in the upgrade query instead — minted
//          here over HTTP, where the owner bearer token *can* be sent as a header.
// Layer: Web auth support
// Depends on: ~/env (isMobileShell), ~/shellAuthSession (owner bearer token), ~/shellSession
//             (forgetting a repudiated pairing), ./lib/serverEndpoint, ./appHistoryMode,
//             ./connectRouteSearch
// Exports: WS_AUTH_TICKET_PATH, acquireWsTicket, authenticateSocketUrl,
//          resetWsAuthTicketStateForTests

import { AUTH_WEBSOCKET_TOKEN_QUERY_PARAM } from "@synara/contracts";

// Not ./appNavigation: this module sits under the transport, and importing the navigation module
// would pull in React and construct a router history just to build one href.
import { appRouteDocumentHref } from "./appHistoryMode";
import { CONNECT_ROUTE_PATH, connectRouteSearchParams } from "./connectRouteSearch";
import { isMobileShell } from "./env";
import { resolveWsHttpUrl } from "./lib/serverEndpoint";
import { acquireShellBearerToken } from "./shellAuthSession";
import { clearShellSession } from "./shellSession";

export const WS_AUTH_TICKET_PATH = "/api/auth/ws-token";

/**
 * The socket cannot be dialed until this request settles, and browsers apply no default fetch
 * timeout. A connection that accepts and then stalls — the WAN/tunnel case — would otherwise
 * leave the transport waiting forever with no connect attempt to fail and no backoff to run.
 */
const WS_AUTH_TICKET_TIMEOUT_MS = 5_000;

/**
 * How long to stop minting after the server sheds load. The transport retries acquisition
 * forever at a ~5s cap, so a network that passes HTTP but never completes the WebSocket upgrade
 * (a proxy stripping `Upgrade`) would otherwise POST every few seconds indefinitely and keep the
 * server's small outstanding-ticket budget exhausted for every other socket on this session.
 */
const MINT_COOLDOWN_MILLIS = 60_000;

// A revoked session fails every socket the transport has open at once. The redirect below is a
// one-way trip out of the authenticated app, so it must happen exactly once per sign-out no
// matter how many tickets were in flight when the server said no. Re-armed by the next accepted
// mint: the redirect is a hash navigation on mobile, so this process outlives re-pairing.
let signedOutHandled = false;

// Epoch millis before which minting is pointless (the server answered 429). Zero means no cooldown.
let mintCooldownUntil = 0;

/**
 * Forget the pairing and send this device back to the connect screen, saying why. Clearing comes
 * first and unconditionally: a token the server has repudiated must not survive on the device
 * even if the navigation is somehow blocked.
 */
async function handleSessionRevoked(): Promise<void> {
  if (signedOutHandled) return;
  signedOutHandled = true;
  try {
    await clearShellSession();
  } catch {
    // Secure storage refused the delete. `clearShellSession` drops the session from memory before
    // it touches storage, so the repudiated token is unusable in this process either way, and the
    // connect screen is the one place that can replace what is still on disk. The navigation is
    // the user-facing half of this and must happen regardless.
  }
  window.location.assign(
    appRouteDocumentHref(CONNECT_ROUTE_PATH, connectRouteSearchParams("signed-out")),
  );
}

/**
 * A fresh single-use upgrade ticket, or null when this client does not need one (desktop and
 * plain browsers authenticate the upgrade with their cookie or the desktop bridge's local token)
 * or could not get one right now.
 *
 * Never cached: the server consumes a ticket the moment it verifies one, so every socket open —
 * including every reconnect — has to mint its own.
 *
 * The null-vs-signed-out distinction is the whole point of the error handling here. A request
 * that never got an answer means the server is unreachable, which is exactly the condition the
 * transport's reconnect backoff exists for, so the pairing stays untouched. Only an answered 401
 * proves the session itself is gone; a 429 is load shedding, which keeps the pairing too.
 */
export async function acquireWsTicket(): Promise<string | null> {
  if (!isMobileShell) return null;
  if (Date.now() < mintCooldownUntil) return null;
  const bearerToken = await acquireShellBearerToken();
  if (!bearerToken) return null;

  let response: Response;
  try {
    response = await fetch(resolveWsHttpUrl(WS_AUTH_TICKET_PATH), {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(WS_AUTH_TICKET_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  if (response.status === 401) {
    await handleSessionRevoked();
    return null;
  }
  if (response.status === 429) {
    // Not a revocation: the pairing is fine, the server just has no ticket slots left. Back off
    // instead of hammering, so the slots this client is burning free up for its other sockets.
    mintCooldownUntil = Date.now() + MINT_COOLDOWN_MILLIS;
    return null;
  }
  if (!response.ok) return null;

  // An accepted mint proves this device is authenticated again, so a later revocation has to be
  // handled afresh. Without this the latch would survive re-pairing (a hash navigation never
  // reloads the document) and a second sign-out would 401 every socket forever, silently.
  signedOutHandled = false;

  const payload = (await response.json().catch(() => null)) as {
    readonly token?: unknown;
  } | null;
  return typeof payload?.token === "string" && payload.token.length > 0 ? payload.token : null;
}

/**
 * The URL to actually dial for an authenticated WebSocket endpoint. Off the mobile shell this is
 * the input string, byte for byte: desktop and browser upgrades must keep authenticating exactly
 * as they do today. A mobile client that could not mint a ticket still dials — the server refuses
 * the upgrade and the transport's existing retry path takes over, which is the same shape as any
 * other failed connect.
 *
 * Total on purpose: the transport calls this inside `Effect.promise`, where a rejection becomes an
 * unrecoverable defect in the socket layer instead of a failed dial. Anything unexpected (a bridge
 * or secure-storage error out of the token lookup) degrades to the unauthenticated URL.
 */
export async function authenticateSocketUrl(socketUrl: string): Promise<string> {
  if (!isMobileShell) return socketUrl;
  try {
    const ticket = await acquireWsTicket();
    if (!ticket) return socketUrl;
    const url = new URL(socketUrl);
    url.searchParams.set(AUTH_WEBSOCKET_TOKEN_QUERY_PARAM, ticket);
    return url.toString();
  } catch {
    return socketUrl;
  }
}

export function resetWsAuthTicketStateForTests(): void {
  signedOutHandled = false;
  mintCooldownUntil = 0;
}
