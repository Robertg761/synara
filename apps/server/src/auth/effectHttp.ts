import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { AuthError, AuthRequest } from "./Services/ServerAuth";

export function makeEffectAuthRequest(request: HttpServerRequest.HttpServerRequest): AuthRequest {
  const url = HttpServerRequest.toURL(request);
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return {
    headers,
    cookies: request.cookies,
    ...(url ? { url } : {}),
  };
}

/**
 * `headers` carries the route's trusted-origin CORS headers where it has any. An off-origin
 * caller (the mobile WebView, the desktop shell against a remote server) that gets a bare 401
 * sees an opaque network error instead of a status, which means a client cannot tell "your
 * session is gone" from "the network blipped" — and the revoked device keeps its pairing.
 */
export function authErrorResponse(error: AuthError, headers?: Record<string, string>) {
  return HttpServerResponse.jsonUnsafe(
    { error: error.message },
    {
      status: error.status ?? 500,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    },
  );
}
