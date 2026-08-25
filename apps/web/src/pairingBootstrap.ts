// FILE: pairingBootstrap.ts
// Purpose: Exchanges one-time remote pairing links before the application opens a WebSocket.

import { appRouteHref, type BootstrapLocation } from "./lib/bootstrapLocation";

const PAIRING_PATH = "/pair";
const PAIRING_CREDENTIAL_PARAM = "token";
const APP_ROOT_PATH = "/";

interface PairingHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

interface PairingBootstrapDependencies {
  /** App route resolved once by bootstrap.ts, so both history modes are already normalized. */
  readonly location: BootstrapLocation;
  /** Document-level replace (`window.location.replace`), used only under browser history. */
  readonly replace?: (url: string) => void;
  readonly history?: PairingHistory;
  readonly fetch?: typeof globalThis.fetch;
  readonly renderFailure?: () => void;
}

export type PairingBootstrapResult =
  | "not-pairing"
  /** Paired in place (hash history): the caller continues booting the app at the app root. */
  | "paired"
  /** Paired with a document navigation in flight (browser history): the caller stops. */
  | "redirecting"
  | "failed";

function renderPairingFailure(): void {
  const root = document.getElementById("root");
  if (!root) return;

  document.title = "Pairing failed · Synara";
  root.innerHTML = `
    <main role="alert" aria-live="assertive" style="min-height:100vh;box-sizing:border-box;display:grid;place-items:center;padding:32px;background:#10110f;color:#f3f0e8;font-family:'DM Sans Variable','DM Sans',sans-serif">
      <section style="width:min(100%,520px);border:1px solid #373a34;background:#171915;padding:clamp(28px,6vw,52px);box-shadow:12px 12px 0 #080907">
        <p style="margin:0 0 22px;color:#d6ff55;font:600 12px/1.2 'Geist Mono Variable','Geist Mono',monospace;letter-spacing:.16em;text-transform:uppercase">Secure pairing interrupted</p>
        <h1 tabindex="-1" style="margin:0;color:#fffdf7;font-size:clamp(32px,7vw,52px);font-weight:600;line-height:.98;letter-spacing:-.045em">This pairing link could not be used.</h1>
        <p style="margin:24px 0 0;color:#b8bbb2;font-size:16px;line-height:1.6">The link may be incomplete, expired, or already used. Generate a new pairing link from the Synara server and try again.</p>
      </section>
    </main>`;
  root.querySelector<HTMLElement>("h1")?.focus();
}

/**
 * The credential always travels in a fragment the server never sees. Under browser history that
 * is `/pair#token=…`; under hash history the app route itself lives in the fragment, so the
 * credential is either the nested fragment (`#/pair#token=…`) or the fragment-scoped query
 * (`#/pair?token=…`) — both stay client-side, unlike a real query string.
 */
function readCredential(location: BootstrapLocation): string | null {
  const fromFragment = location.hashParams.get(PAIRING_CREDENTIAL_PARAM);
  if (fromFragment) return fromFragment;
  return location.mode === "hash" ? location.searchParams.get(PAIRING_CREDENTIAL_PARAM) : null;
}

function credentialFreeSearchParams(location: BootstrapLocation): URLSearchParams {
  const searchParams = new URLSearchParams(location.searchParams);
  searchParams.delete(PAIRING_CREDENTIAL_PARAM);
  return searchParams;
}

export async function bootstrapPairingSession(
  dependencies: PairingBootstrapDependencies,
): Promise<PairingBootstrapResult> {
  const { location } = dependencies;
  if (location.pathname !== PAIRING_PATH) {
    return "not-pairing";
  }

  const history = dependencies.history ?? window.history;
  const renderFailure = dependencies.renderFailure ?? renderPairingFailure;
  const credential = readCredential(location);
  // Scrub before anything can await: the credential must not survive in the visible URL or in
  // the history entry, in either history mode.
  history.replaceState(
    null,
    "",
    appRouteHref(location.mode, PAIRING_PATH, credentialFreeSearchParams(location)),
  );

  if (!credential) {
    renderFailure();
    return "failed";
  }

  try {
    const response = await (dependencies.fetch ?? globalThis.fetch)("/api/auth/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    if (!response.ok) {
      renderFailure();
      return "failed";
    }
  } catch {
    renderFailure();
    return "failed";
  }

  if (location.mode === "hash") {
    // Fragment-only move: there is no document to fetch (the shell origin is file-backed) and no
    // reason to re-run bootstrap, so rewrite the route to the app root and let the caller boot
    // the app in place.
    history.replaceState(null, "", appRouteHref("hash", APP_ROOT_PATH));
    return "paired";
  }

  (dependencies.replace ?? ((url: string) => window.location.replace(url)))(APP_ROOT_PATH);
  return "redirecting";
}
