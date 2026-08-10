// FILE: shellSession.ts
// Purpose: Hydrate-once in-memory view of the mobile shell's paired server session. The bridge's
// secure storage is async, but the endpoint chain and the auth header path need the server URL and
// bearer token synchronously, so the session is read once at startup and cached here.
// Layer: Web shell integration
// Depends on: ~/shellBridge (MobileBridge adapter), @synara/contracts (MobileShellSession)
// Exports: toShellServerWsBase, ShellHydrationResult, hydrateShellSession, isShellPaired,
//          getShellSessionToken, getShellServerWsUrl, getShellPairingGeneration,
//          pairFromCredential, clearShellSession, resetShellSessionForTests

import type { MobileBridge, MobileShellSession } from "@synara/contracts";

import { getMobileBridge } from "~/shellBridge";

/** What the connect screen persists once it has exchanged a pairing credential for a session. */
export type ShellPairingInput = MobileShellSession;

/**
 * What a hydration attempt learned. `unavailable` exists so callers can tell "secure storage says
 * this device has never paired" apart from "secure storage did not answer" (the bridge has not
 * attached yet, the keystore is still locked after a reboot). Treating the second as the first
 * throws away a working pairing.
 */
export type ShellHydrationResult = "paired" | "unpaired" | "unavailable";

/**
 * A read can fail transiently for as long as the shell is still coming up, so a hydrate retries
 * before it reports `unavailable`. Bounded and short: route loads await this.
 */
const HYDRATION_READ_ATTEMPTS = 3;
const HYDRATION_RETRY_DELAYS_MS = [100, 250] as const;

let session: MobileShellSession | null = null;
let serverWsBase: string | null = null;
let hydration: Promise<ShellHydrationResult> | null = null;
// Bumped by every explicit write. An in-flight hydrate that resolves after a pair/clear must not
// resurrect the value it read before that write.
let writeGeneration = 0;
// Bumped only by a successful pairing. Identifies which pairing is in effect for state that has to
// re-arm when this device pairs again without the document reloading (the sign-out redirect is a
// hash navigation on the mobile shell, so module state outlives re-pairing).
let pairingGeneration = 0;

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

function delay(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

async function readStoredSession(bridge: MobileBridge): Promise<ShellHydrationResult> {
  for (let attempt = 0; attempt < HYDRATION_READ_ATTEMPTS; attempt += 1) {
    const startedAt = writeGeneration;
    try {
      const stored = await bridge.session.get();
      // An explicit pair/clear landed while this read was in flight. It is newer than what storage
      // held when the read started, so memory wins and the value read here is dropped.
      if (startedAt === writeGeneration) remember(stored);
      return session ? "paired" : "unpaired";
    } catch {
      const retryDelay = HYDRATION_RETRY_DELAYS_MS[attempt];
      if (retryDelay !== undefined) await delay(retryDelay);
    }
  }
  return "unavailable";
}

/**
 * Read the paired session out of the shell's secure storage into memory. Single-flight:
 * concurrent and repeat callers share one read. A read that never answered is not cached, so a
 * later call retries it.
 *
 * A missing bridge reports `unavailable`, not `unpaired`: off the mobile shell nobody asks, and
 * on it a null bridge means the plugin has not attached yet — which is not evidence about what is
 * stored on the device.
 */
export function hydrateShellSession(
  bridge: MobileBridge | null = getMobileBridge(),
): Promise<ShellHydrationResult> {
  if (!bridge) return Promise.resolve("unavailable");
  hydration ??= readStoredSession(bridge).then((result) => {
    if (result === "unavailable") hydration = null;
    return result;
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
 * Opaque counter identifying the current pairing. Only a successful `pairFromCredential` advances
 * it — clearing does not, so state latched against a revoked session stays latched until this
 * device actually pairs again.
 */
export function getShellPairingGeneration(): number {
  return pairingGeneration;
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
  pairingGeneration += 1;
  // Storage is now the source of truth; a later hydrate would be a no-op read of what we just wrote.
  hydration = Promise.resolve("paired");
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
  hydration = Promise.resolve("unpaired");
  await bridge?.session.clear();
}

export function resetShellSessionForTests(): void {
  session = null;
  serverWsBase = null;
  hydration = null;
  writeGeneration = 0;
  pairingGeneration = 0;
}
