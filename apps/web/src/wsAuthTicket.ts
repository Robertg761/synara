// FILE: wsAuthTicket.ts
// Purpose: Mints the single-use ticket the mobile shell must present on every WebSocket upgrade.
//          The Capacitor WebView serves the app from its own origin, so the upgrade carries no
//          session cookie, and no browser lets a WebSocket send an Authorization header. The
//          server therefore accepts a short-lived ticket in the upgrade query instead — minted
//          here over HTTP, where the owner bearer token *can* be sent as a header.
// Layer: Web auth support
// Depends on: ~/env (isMobileShell), ~/shellAuthSession (owner bearer token, for cache keying),
//             ./lib/authenticatedFetch (the bearer header and the one revocation path)
// Exports: WS_AUTH_TICKET_PATH, acquireWsTicket, noteWsTicketConsumed, authenticateSocketUrl,
//          resetWsAuthTicketStateForTests

import { AUTH_WEBSOCKET_TOKEN_QUERY_PARAM } from "@synara/contracts";

import { isMobileShell } from "./env";
import { authenticatedServerFetch } from "./lib/authenticatedFetch";
import { acquireShellBearerToken } from "./shellAuthSession";

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

/**
 * How long a minted ticket may be re-offered to a dial. The server consumes a ticket at the
 * upgrade and the transport says so (`noteWsTicketConsumed`), so in practice this only covers
 * dials that never opened a socket — the reconnect storm this window exists for, where minting
 * per attempt would exhaust the session's small outstanding-ticket budget within seconds. Far
 * inside the server's 5-minute ticket TTL, and short enough that a ticket consumed by an upgrade
 * the transport did not report costs a bounded number of failed dials rather than wedging.
 */
const TICKET_REUSE_MILLIS = 15_000;

// Epoch millis before which minting is pointless (the server answered 429). Zero means no cooldown.
let mintCooldownUntil = 0;

// The last minted ticket no socket has opened with yet. Keyed by the bearer it was minted for, so
// a cleared or re-paired session can never be handed the previous pairing's ticket.
let unconsumedTicket: {
  readonly token: string;
  readonly bearerToken: string;
  readonly reusableUntil: number;
} | null = null;

/**
 * A single-use upgrade ticket, or null when this client does not need one (desktop and plain
 * browsers authenticate the upgrade with their cookie or the desktop bridge's local token) or
 * could not get one right now.
 *
 * Reused, not re-minted, until a socket actually opens with it or its reuse window lapses: the
 * URL is resolved per socket acquire, and the acquires the transport does not drive itself (the
 * RPC protocol's retry loop, each reconnect) would otherwise burn one mint per failed dial.
 *
 * The null-vs-signed-out distinction is the whole point of the error handling here. A request
 * that never got an answer means the server is unreachable, which is exactly the condition the
 * transport's reconnect backoff exists for, so the pairing stays untouched. Only an answered 401
 * proves the session itself is gone; a 429 is load shedding, which keeps the pairing too.
 */
export async function acquireWsTicket(): Promise<string | null> {
  if (!isMobileShell) return null;
  const bearerToken = await acquireShellBearerToken();
  if (!bearerToken) return null;
  // Ahead of the cooldown check: a ticket already in hand costs the server nothing to reuse, and
  // load shedding is a reason to stop minting, not a reason to dial unauthenticated.
  const cached = unconsumedTicket;
  if (cached && cached.bearerToken === bearerToken && Date.now() < cached.reusableUntil) {
    return cached.token;
  }
  if (Date.now() < mintCooldownUntil) return null;

  let response: Response;
  try {
    // Shared helper: it attaches the bearer and, on an answered 401, routes the verdict through
    // the single revocation path — the same treatment every other authenticated HTTP call gets.
    response = await authenticatedServerFetch(WS_AUTH_TICKET_PATH, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(WS_AUTH_TICKET_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  if (response.status === 401) {
    unconsumedTicket = null;
    return null;
  }
  if (response.status === 429) {
    // Not a revocation: the pairing is fine, the server just has no ticket slots left. Back off
    // instead of hammering, so the slots this client is burning free up for its other sockets.
    mintCooldownUntil = Date.now() + MINT_COOLDOWN_MILLIS;
    return null;
  }
  if (!response.ok) return null;

  // The server has slots again, so the cooldown has served its purpose. Left standing it would be
  // process-wide and permanent: nothing else ever lowers it.
  mintCooldownUntil = 0;

  const payload = (await response.json().catch(() => null)) as {
    readonly token?: unknown;
  } | null;
  const token =
    typeof payload?.token === "string" && payload.token.length > 0 ? payload.token : null;
  if (!token) return null;
  unconsumedTicket = { token, bearerToken, reusableUntil: Date.now() + TICKET_REUSE_MILLIS };
  return token;
}

/**
 * Called by the transport once a dial has opened its socket: the server consumed the ticket at the
 * upgrade, so the next dial has to mint its own. Total and cheap — a no-op when nothing is cached,
 * which is every non-mobile client.
 */
export function noteWsTicketConsumed(): void {
  unconsumedTicket = null;
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
  mintCooldownUntil = 0;
  unconsumedTicket = null;
}
