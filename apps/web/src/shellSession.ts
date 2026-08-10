// FILE: shellSession.ts
// Purpose: Hydrate-once in-memory view of the mobile shell's paired server session. The bridge's
// secure storage is async, but the endpoint chain and the auth header path need the server URL and
// bearer token synchronously, so the session is read once at startup and cached here.
// Layer: Web shell integration
// Depends on: ~/shellBridge (MobileBridge adapter), @synara/contracts (MobileShellSession)
// Exports: toShellServerWsBase, hydrateShellSession, isShellPaired, getShellSessionToken,
//          getShellServerWsUrl, pairFromCredential, clearShellSession, resetShellSessionForTests

import type { MobileBridge, MobileShellSession } from "@synara/contracts";

import { getMobileBridge } from "~/shellBridge";

/** What the connect screen persists once it has exchanged a pairing credential for a session. */
export type ShellPairingInput = MobileShellSession;

let session: MobileShellSession | null = null;
let serverWsBase: string | null = null;
let hydration: Promise<void> | null = null;
// Bumped by every explicit write. An in-flight hydrate that resolves after a pair/clear must not
// resurrect the value it read before that write.
let writeGeneration = 0;

/**
 * Convert a stored `http(s)://host[:port]` server URL into the `ws(s)://host[:port]` base the
 * transport connects to. Pure and total: returns null for anything that is not an absolute
 * http/https/ws/wss URL, so a malformed pairing can never be mistaken for a configured endpoint.
 *
 * Only the origin survives: `resolveRpcUrl` in wsTransport overwrites the pathname anyway, and
 * `resolveWsHttpUrl` only mirrors the host, so path prefixes are unsupported repo-wide.
 */
export function toShellServerWsBase(serverUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl.trim());
  } catch {
    return null;
  }
  const protocol =
    parsed.protocol === "https:" || parsed.protocol === "wss:"
      ? "wss:"
      : parsed.protocol === "http:" || parsed.protocol === "ws:"
        ? "ws:"
        : null;
  if (!protocol || parsed.host.length === 0) return null;
  return `${protocol}//${parsed.host}`;
}

function remember(next: MobileShellSession | null): void {
  const wsBase = next ? toShellServerWsBase(next.serverUrl) : null;
  // A session whose URL cannot be turned into an endpoint is unusable; treat it as unpaired
  // rather than half-paired so callers only ever see a consistent pair of values.
  session = wsBase ? next : null;
  serverWsBase = wsBase;
}

/**
 * Read the paired session out of the shell's secure storage into memory. No-op off the mobile
 * shell (the bridge is null) and single-flight: concurrent and repeat callers share one read.
 * A failed read is not cached, so a later call retries.
 */
export function hydrateShellSession(
  bridge: MobileBridge | null = getMobileBridge(),
): Promise<void> {
  if (!bridge) return Promise.resolve();
  const startedAt = writeGeneration;
  hydration ??= bridge.session
    .get()
    .then((stored) => {
      if (startedAt === writeGeneration) remember(stored);
    })
    .catch(() => {
      hydration = null;
    });
  return hydration;
}

/** True once a usable server URL + session token pair is in memory. */
export function isShellPaired(): boolean {
  return session !== null;
}

/** Owner bearer token for the paired server, or null when unpaired / not yet hydrated. */
export function getShellSessionToken(): string | null {
  return session?.sessionToken ?? null;
}

/** ws(s) base URL for the paired server, or null when unpaired / not yet hydrated. */
export function getShellServerWsUrl(): string | null {
  return serverWsBase;
}

/**
 * Persist a freshly paired server (called by the connect screen after it exchanges a pairing
 * credential for an owner session) and make it visible to the synchronous accessors immediately.
 * Rejects — without persisting — when `serverUrl` is not an absolute http(s)/ws(s) URL.
 */
export async function pairFromCredential(
  input: ShellPairingInput,
  bridge: MobileBridge | null = getMobileBridge(),
): Promise<void> {
  if (!toShellServerWsBase(input.serverUrl)) {
    throw new Error(`Cannot pair with an unusable server URL: ${input.serverUrl}`);
  }
  // Refuse to mutate in-memory state without a persisting bridge: off the mobile shell this
  // module must stay inert, or a stray pairing would repoint the desktop/browser endpoint
  // chain (getShellServerWsUrl sits ahead of the desktop bridge in the precedence order).
  if (!bridge) {
    throw new Error("Pairing requires the mobile shell's secure session storage.");
  }
  writeGeneration += 1;
  try {
    await bridge.session.set(input);
  } catch (error) {
    // The write failed, so storage still holds whatever was there before. Drop the settled
    // hydration so the next hydrate re-reads storage instead of trusting memory; the
    // generation bump above already stopped any in-flight read from landing stale data.
    hydration = null;
    throw error;
  }
  remember(input);
  // Storage is now the source of truth; a later hydrate would be a no-op read of what we just wrote.
  hydration = Promise.resolve();
}

/**
 * Forget the paired server everywhere (logout, or the server reporting the session revoked).
 * The invariant is asymmetric with `pairFromCredential` on purpose: a repudiated token never
 * survives in memory, while removal from storage is best-effort. Memory is dropped first, so a
 * bridge that refuses the delete rejects to the caller with the token already unusable here.
 */
export async function clearShellSession(
  bridge: MobileBridge | null = getMobileBridge(),
): Promise<void> {
  writeGeneration += 1;
  remember(null);
  // Settled rather than null: if the clear below fails, storage still holds the repudiated token,
  // and a later hydrate in this process must not read it back. Only a fresh launch can, which is
  // unavoidable — the connect screen is what replaces what is on disk.
  hydration = Promise.resolve();
  await bridge?.session.clear();
}

export function resetShellSessionForTests(): void {
  session = null;
  serverWsBase = null;
  hydration = null;
  writeGeneration = 0;
}
