// FILE: wsUpgradeOrigin.ts
// Purpose: One origin gate for every WebSocket upgrade route (browser RPC, mobile).
// Layer: Server HTTP/security utility
// Exports: trustedWebSocketRequestUrl

import { HttpServerRequest } from "effect/unstable/http";

import type { ServerConfigShape } from "./config";
import { shouldRejectUntrustedRequestOrigin } from "./trustedOrigins";

/**
 * Returns the request URL only when the handshake's `Origin` is trusted (or
 * absent, as for native clients). A `null` result is a 403: never continue the
 * upgrade with an unvalidated origin.
 */
export function trustedWebSocketRequestUrl(
  request: HttpServerRequest.HttpServerRequest,
  config: ServerConfigShape,
): URL | null {
  const url = HttpServerRequest.toURL(request);
  return url &&
    !shouldRejectUntrustedRequestOrigin({
      rawOrigin: request.headers.origin,
      requestOrigin: url.origin,
      config,
    })
    ? url
    : null;
}
