// FILE: bootstrapLocation.ts
// Purpose: Resolves the app-level route (path, query, fragment params) out of a Location under
//          both history modes, and builds hrefs that address app routes in the active mode.
// Layer: Web utility
// Exports: BootstrapHistoryMode, BootstrapLocationInput, BootstrapLocation,
//          readBootstrapLocation, appRouteHref
// Depends on: nothing — this module runs on the pre-React bootstrap path and must stay
//             dependency-free and pure so it can be evaluated before any app module loads.

/**
 * Plain browsers address app routes with the real pathname (`/pair`). Native shells
 * (Electron, the Capacitor mobile shell) load the app from a file-backed origin where a
 * path-addressed document does not exist, so the whole app route lives in the fragment
 * (`#/pair`) — see `createAppHistory` in appNavigation.ts.
 */
export type BootstrapHistoryMode = "path" | "hash";

/** The `window.location` fields this module reads. */
export interface BootstrapLocationInput {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

/** An app route, normalized so callers never care which history mode produced it. */
export interface BootstrapLocation {
  readonly mode: BootstrapHistoryMode;
  /** App route path, always leading-slashed and without a trailing slash (`/`, `/pair`). */
  readonly pathname: string;
  /** Query params of the app route (path mode: `?a=1`; hash mode: `#/pair?a=1`). */
  readonly searchParams: URLSearchParams;
  /** Fragment params carried past the app route (path mode: `#token=…`; hash mode: `#/pair#token=…`). */
  readonly hashParams: URLSearchParams;
}

function normalizePathname(pathname: string): string {
  if (pathname.length === 0) return "/";
  const rooted = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return rooted.length > 1 && rooted.endsWith("/") ? rooted.slice(0, -1) : rooted;
}

function splitOnce(value: string, separator: string): readonly [string, string] {
  const index = value.indexOf(separator);
  return index === -1
    ? [value, ""]
    : [value.slice(0, index), value.slice(index + separator.length)];
}

/**
 * Reads the app route out of a Location under either history mode.
 *
 * Under hash history the browser keeps everything after the first `#` in `location.hash`, so a
 * pairing link built for a hash-history origin (`https://host/#/pair#token=abc`) arrives as
 * pathname `/` + hash `#/pair#token=abc`: the route is the first fragment and the credential is
 * the nested one. Under browser history the same link is pathname `/pair` + hash `#token=abc`.
 * Both shapes normalize to `{ pathname: "/pair", hashParams: { token } }`.
 *
 * `nativeShell` is the authoritative mode hint (it is what appNavigation.ts keys hash history
 * on). It matters on the very first paint inside a shell, before the router has written a route
 * into the fragment: without it a bare `file:///…/index.html` would look like path history and
 * callers would build hrefs the shell origin cannot serve.
 */
export function readBootstrapLocation(
  input: BootstrapLocationInput,
  options: { readonly nativeShell?: boolean | undefined } = {},
): BootstrapLocation {
  const fragment = input.hash.startsWith("#") ? input.hash.slice(1) : input.hash;
  const hasHashRoute = fragment.startsWith("/");

  if (!hasHashRoute && options.nativeShell !== true) {
    return {
      mode: "path",
      pathname: normalizePathname(input.pathname),
      searchParams: new URLSearchParams(input.search),
      hashParams: new URLSearchParams(fragment),
    };
  }

  // Hash mode: the pathname is the shell's document (`/`, `/index.html`) and carries no route,
  // so an empty or route-less fragment means the app root.
  const [route, nestedFragment] = hasHashRoute ? splitOnce(fragment, "#") : ["/", fragment];
  const [routePath, routeQuery] = splitOnce(route, "?");
  return {
    mode: "hash",
    pathname: normalizePathname(routePath),
    searchParams: new URLSearchParams(routeQuery),
    hashParams: new URLSearchParams(nestedFragment),
  };
}

/**
 * Href that addresses an app route in the given history mode. Under hash history this is a
 * fragment-only href on purpose: assigning it never leaves the loaded document, so a native
 * shell never asks its file-backed origin for a path it cannot serve (a 404 screen).
 */
export function appRouteHref(
  mode: BootstrapHistoryMode,
  path: string,
  searchParams?: URLSearchParams,
): string {
  const query = searchParams?.toString() ?? "";
  const route = `${path}${query.length > 0 ? `?${query}` : ""}`;
  return mode === "hash" ? `#${route}` : route;
}
