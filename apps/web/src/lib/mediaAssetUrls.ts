// FILE: mediaAssetUrls.ts
// Purpose: Builds URLs for the server's read-only media routes (attachments, favicons, local
//          images, editor icons, thread exports). Same host resolution as any other server URL,
//          plus the short-lived media credential when this runtime has no other way to
//          authenticate an `<img>`/`<a download>` — which is every one of these routes on the
//          mobile shell.
// Layer: Web utility
// Depends on: ./serverEndpoint (host resolution), ~/mediaAuthToken (the credential)
// Exports: resolveMediaHttpUrl, withCurrentMediaCredential, mediaUrlIdentity,
//          toAttachmentPreviewUrl
//
// Deliberately separate from serverEndpoint.ts, which every auth module resolves its own URLs
// through: pulling the credential in there would make the endpoint resolver depend on the thing
// that depends on it.

import { AUTH_MEDIA_TOKEN_QUERY_PARAM } from "@synara/contracts";

import { readMediaAuthToken } from "../mediaAuthToken";
import { resolveWsHttpUrl } from "./serverEndpoint";

/**
 * The URL to actually request for a media route. Identical to {@link resolveWsHttpUrl} wherever
 * the request can authenticate itself — browsers send their session cookie, the desktop window
 * forwards its startup token — so those clients' URLs (and therefore their HTTP cache entries)
 * are unchanged, byte for byte.
 *
 * On the mobile shell neither is available, so the minted read-only credential is appended. It
 * rotates every few minutes, which does cost the browser cache the entries it had keyed on the
 * previous one; that is the price of putting a credential in a URL at all, and the reason its
 * lifetime is measured in minutes and its scope in GETs.
 */
export function resolveMediaHttpUrl(rawPath: string): string {
  const resolved = resolveWsHttpUrl(rawPath);
  const mediaToken = readMediaAuthToken();
  if (!mediaToken) return resolved;
  try {
    const url = new URL(resolved);
    url.searchParams.set(AUTH_MEDIA_TOKEN_QUERY_PARAM, mediaToken);
    return url.toString();
  } catch {
    // A relative path only survives here when there is no page origin to resolve against, which
    // means nothing is going to fetch it anyway. Better an unauthenticated URL than a throw from
    // a render.
    return resolved;
  }
}

/**
 * Re-stamps an already-built media URL with the credential that is current *now*.
 *
 * For URLs that outlive the render that built them — an attachment preview kept in store state, a
 * lightbox src — the credential that was current when the URL was assembled may since have
 * rotated. Anything that is about to hand such a URL to the network passes it through here first.
 * A no-op wherever no credential is held (browser, desktop), and on anything that is not a URL on
 * our server: a `blob:`/`data:` composer preview or a third party's image is not ours to stamp.
 */
export function withCurrentMediaCredential(url: string): string {
  if (url.startsWith("/")) return resolveMediaHttpUrl(url);
  const mediaToken = readMediaAuthToken();
  if (mediaToken === null) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    if (parsed.origin !== new URL(resolveWsHttpUrl("/")).origin) return url;
    parsed.searchParams.set(AUTH_MEDIA_TOKEN_QUERY_PARAM, mediaToken);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * What a media URL points at, with the credential taken back out. The credential rotates; the
 * asset does not — so anything that remembers a per-URL outcome (a load/failure cache, an
 * in-flight de-dupe, a React key) must remember it against this, or it will forget everything it
 * knew every few minutes and re-probe the whole screen.
 */
export function mediaUrlIdentity(url: string): string {
  const separator = url.indexOf("?");
  if (separator < 0) return url;
  try {
    const parsed = new URL(url, "http://media.invalid");
    parsed.searchParams.delete(AUTH_MEDIA_TOKEN_QUERY_PARAM);
    // Rebuild by hand: `URL` would resolve a server-relative path against the dummy base.
    const query = parsed.searchParams.toString();
    return query.length > 0 ? `${url.slice(0, separator)}?${query}` : url.slice(0, separator);
  } catch {
    return url;
  }
}

/**
 * Attachment preview URLs arrive from the server as either a server-relative path or an absolute
 * URL to somewhere else entirely; only the former is ours to resolve against the server host.
 *
 * Deliberately *without* the media credential: the result is kept in store state and compared for
 * identity there, so a credential baked in would go stale in place and churn every attachment
 * object each time it rotated. The credential is stamped on at render, by
 * {@link withCurrentMediaCredential}.
 */
export function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return resolveWsHttpUrl(rawUrl);
  }
  return rawUrl;
}
