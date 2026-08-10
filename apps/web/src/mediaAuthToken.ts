// FILE: mediaAuthToken.ts
// Purpose: Holds the short-lived, read-only credential the media GET routes accept in their query
//          string. `<img src>`, `<a download>` and the PDF viewer cannot set an Authorization
//          header, and the mobile shell's WebView is served from an origin the server never set a
//          cookie for — so on mobile the URL is the only channel a credential can travel, and the
//          server mints one whose scope is exactly those reads.
// Layer: Web auth support
// Depends on: ~/env (isMobileShell), ~/shellSession (pairing generation), ./lib/authenticatedFetch
//             (bearer + the single revocation path)
// Exports: MEDIA_AUTH_TOKEN_PATH, readMediaAuthToken, ensureMediaAuthToken,
//          subscribeMediaAuthToken, resetMediaAuthTokenStateForTests

import { isMobileShell } from "./env";
import { authenticatedServerFetch } from "./lib/authenticatedFetch";
import { getShellPairingGeneration } from "./shellSession";

export const MEDIA_AUTH_TOKEN_PATH = "/api/auth/media-token";

/**
 * Re-mint this far ahead of expiry. A rendered `<img src>` outlives the render that built it — a
 * retry, an HTTP range request for a PDF, a scroll back up — so a credential must not be handed
 * out with only seconds left on it.
 */
const REFRESH_MARGIN_MILLIS = 3 * 60_000;

/**
 * How long to stop minting after a failed attempt. The read path is called from render, so
 * without this a server that is down (or a device whose pairing is being torn down) would drive
 * one POST per painted icon.
 */
const MINT_COOLDOWN_MILLIS = 10_000;

/** The mint request cannot outlive the usefulness of its answer; browsers time out nothing. */
const MINT_TIMEOUT_MILLIS = 5_000;

type CachedToken = {
  readonly token: string;
  readonly expiresAtMillis: number;
  readonly pairingGeneration: number;
};

let cached: CachedToken | null = null;
let mintInFlight: Promise<string | null> | null = null;
let mintCooldownUntil = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(token: string | null) => void>();

function clearRefreshTimer(): void {
  if (refreshTimer === null) return;
  clearTimeout(refreshTimer);
  refreshTimer = null;
}

function publish(next: CachedToken | null): void {
  const previous = cached?.token ?? null;
  cached = next;
  if ((next?.token ?? null) === previous) return;
  for (const listener of listeners) {
    try {
      listener(next?.token ?? null);
    } catch {
      // A subscriber that throws is its own problem; the rest still need telling.
    }
  }
}

/**
 * Keep a fresh credential in hand without anyone having to ask. Rendered URLs are built from the
 * synchronous read below, so a session that goes quiet for longer than a token's life would
 * otherwise paint one round of broken images before the lazy path caught up.
 */
function scheduleRefresh(expiresAtMillis: number): void {
  clearRefreshTimer();
  const delay = Math.max(expiresAtMillis - REFRESH_MARGIN_MILLIS - Date.now(), 1_000);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void ensureMediaAuthToken();
  }, delay);
  // Never hold the process open for a credential refresh (jsdom/node runtimes).
  (refreshTimer as unknown as { unref?: () => void }).unref?.();
}

function isUsable(entry: CachedToken | null, atMillis: number): entry is CachedToken {
  return (
    entry !== null &&
    entry.pairingGeneration === getShellPairingGeneration() &&
    entry.expiresAtMillis > atMillis
  );
}

async function mint(): Promise<string | null> {
  const pairingGeneration = getShellPairingGeneration();
  let response: Response;
  try {
    response = await authenticatedServerFetch(MEDIA_AUTH_TOKEN_PATH, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(MINT_TIMEOUT_MILLIS),
    });
  } catch {
    // Unreachable server, not a repudiated device: keep the pairing, back off, let the next read
    // try again. (An answered 401 never lands here — `authenticatedServerFetch` has already
    // routed it through the one revocation path.)
    mintCooldownUntil = Date.now() + MINT_COOLDOWN_MILLIS;
    return null;
  }
  if (!response.ok) {
    mintCooldownUntil = Date.now() + MINT_COOLDOWN_MILLIS;
    if (response.status === 401) publish(null);
    return null;
  }
  mintCooldownUntil = 0;

  const payload = (await response.json().catch(() => null)) as {
    readonly token?: unknown;
    readonly expiresAt?: unknown;
  } | null;
  const token =
    typeof payload?.token === "string" && payload.token.length > 0 ? payload.token : null;
  const expiresAtMillis =
    typeof payload?.expiresAt === "string" ? Date.parse(payload.expiresAt) : Number.NaN;
  if (!token || !Number.isFinite(expiresAtMillis)) return null;

  publish({ token, expiresAtMillis, pairingGeneration });
  scheduleRefresh(expiresAtMillis);
  return token;
}

/**
 * The credential to hang on a media URL right now, or null when this client does not need one
 * (every runtime but the mobile shell authenticates these routes with a cookie or the desktop
 * bridge's local token) or does not have one yet.
 *
 * Synchronous because it is called while building a `src`, and it starts a mint in the background
 * when the cache is empty or close to expiry — single-flight, so a screen full of icons costs one
 * request. Subscribers are told when a token arrives, which is how the URLs built before it did
 * get rebuilt.
 */
export function readMediaAuthToken(): string | null {
  if (!isMobileShell) return null;
  const now = Date.now();
  const current = cached;
  const usable = isUsable(current, now);
  if (!usable || current.expiresAtMillis - REFRESH_MARGIN_MILLIS <= now) {
    void ensureMediaAuthToken();
  }
  return usable ? current.token : null;
}

/**
 * Mint a credential if one is not already in hand, and answer with it. Called at startup once the
 * pairing has hydrated so the first render already has a token, and by the refresh timer.
 */
export function ensureMediaAuthToken(): Promise<string | null> {
  if (!isMobileShell) return Promise.resolve(null);
  const now = Date.now();
  if (isUsable(cached, now) && cached.expiresAtMillis - REFRESH_MARGIN_MILLIS > now) {
    return Promise.resolve(cached.token);
  }
  if (mintInFlight) return mintInFlight;
  if (now < mintCooldownUntil) return Promise.resolve(null);
  mintInFlight = mint()
    .catch(() => null)
    .then((token) => {
      mintInFlight = null;
      return token;
    });
  return mintInFlight;
}

/** Notified whenever the current credential changes, so render-time URLs can be rebuilt. */
export function subscribeMediaAuthToken(listener: (token: string | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetMediaAuthTokenStateForTests(): void {
  clearRefreshTimer();
  cached = null;
  mintInFlight = null;
  mintCooldownUntil = 0;
  listeners.clear();
}
