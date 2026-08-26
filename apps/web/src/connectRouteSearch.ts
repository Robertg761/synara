// FILE: connectRouteSearch.ts
// Purpose: URL search state of the mobile connect screen. Shared so the code that *sends* a
//          device back to pairing and the screen that *explains why* agree on one vocabulary.
// Layer: Route state utility
// Exports: CONNECT_ROUTE_PATH, ConnectRouteReason, ConnectRouteSearch, parseConnectRouteSearch,
//          connectRouteSearchParams

export const CONNECT_ROUTE_PATH = "/connect";

/**
 * Why the app navigated to the connect screen on its own. `signed-out` means the server
 * repudiated this device's session (revoked or expired) — distinct from the server merely being
 * unreachable, which is a transient condition the transport keeps retrying.
 */
export type ConnectRouteReason = "signed-out";

export interface ConnectRouteSearch {
  readonly reason?: ConnectRouteReason | undefined;
}

/** Unknown or absent reasons normalize away, so a hand-edited URL can only ever under-explain. */
export function parseConnectRouteSearch(search: Record<string, unknown>): ConnectRouteSearch {
  return search.reason === "signed-out" ? { reason: "signed-out" } : {};
}

export function connectRouteSearchParams(reason: ConnectRouteReason): URLSearchParams {
  return new URLSearchParams([["reason", reason]]);
}
