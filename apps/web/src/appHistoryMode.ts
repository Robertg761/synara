// FILE: appHistoryMode.ts
// Purpose: The app's history mode and the document-level hrefs derived from it. Split out of
//          appNavigation.ts so modules that only need to build a route href (the transport's
//          auth path, for one) do not pull in React and instantiate a router history as a
//          module-load side effect.
// Layer: Web app routing utility
// Depends on: ~/env (isNativeShell), ./lib/bootstrapLocation (pure href builder)
// Exports: appHistoryMode, appRouteDocumentHref

import { isNativeShell } from "./env";
import { appRouteHref, type BootstrapHistoryMode } from "./lib/bootstrapLocation";

// Native shells (Electron, the Capacitor mobile shell) load the app from a
// file-backed origin, so hash history avoids path resolution issues. Single
// source for the choice: the history instance and every document-level href
// that has to address an app route must agree.
export const appHistoryMode: BootstrapHistoryMode = isNativeShell ? "hash" : "path";

/**
 * Href for an app route path that is safe to hand to `window.location.assign/replace`.
 * Under hash history it stays a fragment, so the shell's file-backed origin is never asked
 * for a document it cannot serve (which 404s instead of rendering the route). `searchParams`
 * lands on the app route's query in either mode (`/connect?x=1`, `#/connect?x=1`), which is
 * where the router reads it from — appending it to the document URL would not reach the route.
 */
export function appRouteDocumentHref(path: string, searchParams?: URLSearchParams): string {
  return appRouteHref(appHistoryMode, path, searchParams);
}
