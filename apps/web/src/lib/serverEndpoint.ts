// FILE: serverEndpoint.ts
// Purpose: Single source of truth for resolving which server the app talks to. The WebSocket
// transport and every HTTP request that must reach the same server (<img>, fetch, downloads,
// auth routes) resolve through the one precedence chain below so they cannot disagree.
// Layer: Web utility
// Depends on: ../shellSession (mobile shell's paired server, hydrated before first use)
// Exports: resolveServerWsBase, resolveWsHttpUrl
// Note: this module is a leaf on purpose — the auth modules resolve their URLs through it, so it
// must not reach back for a credential. Media URLs (which do carry one) are built in
// ./mediaAssetUrls.

import { getShellServerWsUrl } from "../shellSession";

// Precedence: mobile shell → desktop bridge → VITE_WS_URL → null (callers fall back to the
// page origin). This function is the only place the chain may exist.
function configuredServerWsUrl(): string | null {
  const shellUrl = getShellServerWsUrl();
  if (shellUrl) return shellUrl;
  const bridgeUrl = window.desktopBridge?.getWsUrl?.();
  if (typeof bridgeUrl === "string" && bridgeUrl.length > 0) return bridgeUrl;
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (typeof envUrl === "string" && envUrl.length > 0) return envUrl;
  return null;
}

/**
 * The ws(s):// base URL the transport should connect to. An explicit URL (tests,
 * tooling) wins outright; otherwise the configured chain, then the page origin.
 */
export function resolveServerWsBase(explicitUrl: string | null = null): string {
  if (explicitUrl) return explicitUrl;
  return (
    configuredServerWsUrl() ??
    `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`
  );
}

// Build a fully-qualified HTTP URL for `rawPath` against the same server the WS connection uses.
// On desktop the page is served from a custom protocol scheme, so <img>/<a download> with a
// relative path never reaches the server. We mirror the WS host and forward the legacy token
// query param so authenticated GET routes (attachments, local-image, …) can authorize the
// request without touching cookies.
export function resolveWsHttpUrl(rawPath: string): string {
  if (typeof window === "undefined") return rawPath;
  const wsCandidate = configuredServerWsUrl();
  const pageOrigin = window.location?.origin;
  if (!wsCandidate) return pageOrigin ? new URL(rawPath, pageOrigin).toString() : rawPath;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    const httpUrl = new URL(rawPath, `${protocol}//${wsUrl.host}`);
    const legacyToken = wsUrl.searchParams.get("token");
    if (legacyToken && !httpUrl.searchParams.has("token")) {
      httpUrl.searchParams.set("token", legacyToken);
    }
    return httpUrl.toString();
  } catch {
    return pageOrigin ? new URL(rawPath, pageOrigin).toString() : rawPath;
  }
}
