// FILE: appRelaunch.ts
// Purpose: Restart the app at its root as a fresh document, for changes no in-place navigation can
//          carry: pairing repoints every resolved endpoint at a different server, and singletons
//          built against the old one (the transport, its open sockets) must not survive it.
// Layer: Web app routing utility
// Depends on: ./appHistoryMode
// Exports: relaunchAppAtRoot

import { appHistoryMode, appRouteDocumentHref } from "./appHistoryMode";

const APP_ROOT_PATH = "/";

/**
 * Load the app root as a new document, replacing the current history entry so the screen being
 * left cannot be reached with Back.
 *
 * Under hash history (the native shells) the route lives in the fragment, so the address has to be
 * rewritten first and then reloaded: a fragment assignment on its own never fetches a document.
 * Under browser history the replace *is* the document navigation, and adding a reload on top of it
 * would race the one already in flight.
 */
export function relaunchAppAtRoot(): void {
  window.location.replace(appRouteDocumentHref(APP_ROOT_PATH));
  if (appHistoryMode === "hash") window.location.reload();
}
