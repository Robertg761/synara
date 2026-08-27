// FILE: authSignedOut.ts
// Purpose: Replaces authenticated application state after the current browser session logs out.

import type { BootstrapLocation } from "./lib/bootstrapLocation";
import { SIGNED_OUT_SCREEN } from "./lib/signedOutScreenCopy";

/**
 * The app route a revoked session lands on. It is reachable two ways, and both must render the
 * same screen (see lib/signedOutScreenCopy.ts):
 *
 * - Browser history: `appRouteDocumentHref` resolves it to `/signed-out`, a real navigation the
 *   server answers with its index.html SPA fallback, so the static renderer below paints it
 *   before ./main is ever imported.
 * - Hash history: it resolves to `#/signed-out`, a move inside the loaded document — a native
 *   shell's file-backed origin has no `/signed-out` document to serve — so the in-app route
 *   (routes/signed-out.tsx) renders it, and a later reload lands back on the static screen
 *   because readBootstrapLocation reads the route out of the fragment.
 */
export const AUTH_SIGNED_OUT_PATH = "/signed-out";

function renderSignedOutScreen(): void {
  const root = document.getElementById("root");
  if (!root) return;

  document.title = SIGNED_OUT_SCREEN.documentTitle;
  root.innerHTML = `
    <main aria-labelledby="${SIGNED_OUT_SCREEN.headingId}" style="min-height:100vh;box-sizing:border-box;display:grid;place-items:center;padding:32px;background:#10110f;color:#f3f0e8;font-family:'DM Sans Variable','DM Sans',sans-serif">
      <section style="position:relative;width:min(100%,560px);overflow:hidden;border:1px solid #373a34;background:#171915;padding:clamp(30px,6vw,56px);box-shadow:12px 12px 0 #080907">
        <div aria-hidden="true" style="position:absolute;inset:0 0 auto auto;width:128px;height:8px;background:#d6ff55"></div>
        <p style="margin:0 0 22px;color:#d6ff55;font:600 12px/1.2 'JetBrains Mono Variable','JetBrains Mono',monospace;letter-spacing:.16em;text-transform:uppercase">${SIGNED_OUT_SCREEN.eyebrow}</p>
        <h1 id="${SIGNED_OUT_SCREEN.headingId}" tabindex="-1" style="max-width:470px;margin:0;color:#fffdf7;font-size:clamp(36px,7vw,58px);font-weight:600;line-height:.96;letter-spacing:-.05em">${SIGNED_OUT_SCREEN.heading}</h1>
        <p style="max-width:440px;margin:26px 0 0;color:#b8bbb2;font-size:16px;line-height:1.65">${SIGNED_OUT_SCREEN.body}</p>
      </section>
    </main>`;
  root.querySelector<HTMLElement>("h1")?.focus();
}

export function bootstrapSignedOutScreen(input: {
  readonly location: BootstrapLocation;
  readonly render?: () => void;
}): boolean {
  if (input.location.pathname !== AUTH_SIGNED_OUT_PATH) return false;
  (input.render ?? renderSignedOutScreen)();
  return true;
}
