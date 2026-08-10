// FILE: bearerBootstrap.ts
// Purpose: One implementation of the POST /api/auth/bootstrap/bearer exchange (pairing credential
//          -> owner session token), shared by the desktop shell's lazy token mint and the mobile
//          connect screen's pairing flow.
// Layer: Web auth support
// Exports: BEARER_BOOTSTRAP_PATH, BearerBootstrapFailureReason, BearerBootstrapResult,
//          requestBearerSession
// Depends on: nothing — `fetch` is injectable so callers and tests can supply their own.

export const BEARER_BOOTSTRAP_PATH = "/api/auth/bootstrap/bearer";

/**
 * Why the exchange did not produce a session. The connect screen shows a different message for
 * each: "unreachable" is the address/network, the other two are the server's answer.
 */
export type BearerBootstrapFailureReason =
  /** The request never got an HTTP response (wrong address, server down, blocked). */
  | "unreachable"
  /** The server answered, and refused (expired, already used, or unknown credential). */
  | "rejected"
  /** The server answered 2xx without a usable session token. */
  | "noSessionToken";

export type BearerBootstrapResult =
  | { readonly ok: true; readonly sessionToken: string }
  | { readonly ok: false; readonly reason: BearerBootstrapFailureReason };

/**
 * Exchange a pairing credential for an owner bearer session at `endpointUrl` (an absolute URL
 * ending in BEARER_BOOTSTRAP_PATH). Never throws, and never puts the credential anywhere but the
 * request body — no logging, no URL, no error message.
 */
export async function requestBearerSession(
  endpointUrl: string,
  credential: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<BearerBootstrapResult> {
  let response: Response;
  try {
    response = await fetchImpl(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) return { ok: false, reason: "rejected" };
  const payload = (await response.json().catch(() => null)) as {
    readonly sessionToken?: unknown;
  } | null;
  return typeof payload?.sessionToken === "string" && payload.sessionToken.length > 0
    ? { ok: true, sessionToken: payload.sessionToken }
    : { ok: false, reason: "noSessionToken" };
}
