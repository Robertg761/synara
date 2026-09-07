// FILE: authenticatedFetch.ts
// Purpose: The one way to make an authenticated HTTP request to the Synara server from the web
//          app. Browsers authenticate with their session cookie; native shells (the mobile
//          WebView, the desktop window against a remote server) are served from an origin the
//          server never set a cookie for and must attach their bearer session as a header
//          instead. Every caller went through its own copy of that rule before, which is how the
//          upload routes ended up cookie-only and 401ing on mobile.
// Layer: Web auth support
// Depends on: ~/env (isMobileShell), ~/shellAuthSession (the bearer), ~/shellSessionExit (the one
//             revocation path), ./serverEndpoint
// Exports: authenticatedServerFetch, AuthenticatedFetchOptions

import { isMobileShell } from "../env";
import { acquireShellBearerToken, invalidateShellBearerToken } from "../shellAuthSession";
import { handleShellSessionRevoked } from "../shellSessionExit";
import { resolveWsHttpUrl } from "./serverEndpoint";

export interface AuthenticatedFetchOptions {
  readonly method?: "GET" | "POST";
  /**
   * Defaults to `same-origin`, which is what a browser needs and what a native shell (whose
   * bearer does the work) does not care about. Routes the desktop window calls cross-origin with
   * a cookie pass `include`.
   */
  readonly credentials?: RequestCredentials;
  readonly headers?: Record<string, string>;
  readonly body?: BodyInit;
  readonly cache?: RequestCache;
  readonly signal?: AbortSignal;
}

/**
 * Fetch `path` on the server this client is paired with, carrying whatever credential this
 * runtime actually has.
 *
 * In a plain browser `acquireShellBearerToken` returns null and this is an ordinary same-origin
 * fetch with no `Authorization` header and no extra `headers` object — byte-identical to what the
 * callers did before, deliberately, because the cookie flow is the one that is already working.
 *
 * The 401 handling is the part worth sharing. A desktop shell can re-bootstrap from its launch
 * credential, so an answered 401 buys exactly one silent retry with a fresh session. A mobile
 * shell cannot: its bearer *is* the pairing, so retrying would replay the token the server just
 * repudiated — that verdict goes to `handleShellSessionRevoked`, the single place that drops the
 * pairing and sends the device to the connect screen, once, however many 401s arrive together.
 *
 * Returns the `Response` rather than a parsed body: callers disagree about what a failure means
 * (an upload throws, a favicon shrugs) and that judgement belongs to them.
 */
export async function authenticatedServerFetch(
  path: string,
  options: AuthenticatedFetchOptions = {},
): Promise<Response> {
  const url = resolveWsHttpUrl(path);
  const attempt = (bearerToken: string | null) => {
    const headers = {
      ...(options.headers ?? {}),
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    };
    return fetch(url, {
      method: options.method ?? "GET",
      credentials: options.credentials ?? "same-origin",
      ...(options.cache ? { cache: options.cache } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(options.body === undefined ? {} : { body: options.body }),
    });
  };

  let bearerToken = await acquireShellBearerToken();
  let response = await attempt(bearerToken);
  if (response.status === 401 && bearerToken && !isMobileShell) {
    invalidateShellBearerToken();
    bearerToken = await acquireShellBearerToken();
    response = await attempt(bearerToken);
  }
  if (response.status === 401 && bearerToken && isMobileShell) {
    await handleShellSessionRevoked();
  }
  return response;
}
