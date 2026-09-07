import { describe, expect, it } from "vitest";

import {
  appRouteHref,
  readBootstrapLocation,
  type BootstrapHistoryMode,
  type BootstrapLocationInput,
} from "./bootstrapLocation";

interface RouteCase {
  readonly name: string;
  readonly location: BootstrapLocationInput;
  readonly nativeShell?: boolean;
  readonly mode: BootstrapHistoryMode;
  readonly pathname: string;
  readonly search?: Record<string, string>;
  readonly hash?: Record<string, string>;
}

// The URLs a browser actually reports for each entry point, per history mode.
const ROUTE_CASES: ReadonlyArray<RouteCase> = [
  {
    // makePairingUrl against a path-history origin: https://host/pair#token=abc
    name: "browser-history pairing link",
    location: { pathname: "/pair", search: "", hash: "#token=abc" },
    mode: "path",
    pathname: "/pair",
    hash: { token: "abc" },
  },
  {
    // The same link against a hash-history origin: https://host/#/pair#token=abc — the browser
    // keeps everything after the first "#" in location.hash.
    name: "hash-history pairing link",
    location: { pathname: "/", search: "", hash: "#/pair#token=abc" },
    mode: "hash",
    pathname: "/pair",
    hash: { token: "abc" },
  },
  {
    // Fragment-scoped query is credential-safe under hash history: it never reaches the server.
    name: "hash-history pairing link with a fragment query",
    location: { pathname: "/index.html", search: "", hash: "#/pair?token=abc" },
    mode: "hash",
    pathname: "/pair",
    search: { token: "abc" },
  },
  {
    name: "browser-history signed-out route",
    location: { pathname: "/signed-out", search: "", hash: "" },
    mode: "path",
    pathname: "/signed-out",
  },
  {
    name: "hash-history signed-out route",
    location: { pathname: "/", search: "", hash: "#/signed-out" },
    mode: "hash",
    pathname: "/signed-out",
  },
  {
    name: "browser-history root",
    location: { pathname: "/", search: "", hash: "" },
    mode: "path",
    pathname: "/",
  },
  {
    name: "hash-history root",
    location: { pathname: "/", search: "", hash: "#/" },
    mode: "hash",
    pathname: "/",
  },
  {
    // Electron's very first paint: the router has not written a route into the fragment yet.
    name: "native shell before the router writes a hash route",
    location: { pathname: "/index.html", search: "?boot=1", hash: "" },
    nativeShell: true,
    mode: "hash",
    pathname: "/",
  },
  {
    name: "browser-history route with query and anchor",
    location: { pathname: "/settings/", search: "?section=advanced", hash: "#token=abc" },
    mode: "path",
    pathname: "/settings",
    search: { section: "advanced" },
    hash: { token: "abc" },
  },
  {
    name: "hash-history route with query and nested fragment",
    location: {
      pathname: "/",
      search: "?ignored=1",
      hash: "#/settings?section=advanced#token=abc",
    },
    mode: "hash",
    pathname: "/settings",
    search: { section: "advanced" },
    hash: { token: "abc" },
  },
];

describe("readBootstrapLocation", () => {
  it.each(ROUTE_CASES)("resolves the $name", (routeCase) => {
    const resolved = readBootstrapLocation(routeCase.location, {
      nativeShell: routeCase.nativeShell,
    });

    expect(resolved.mode).toBe(routeCase.mode);
    expect(resolved.pathname).toBe(routeCase.pathname);
    expect(Object.fromEntries(resolved.searchParams)).toEqual(routeCase.search ?? {});
    expect(Object.fromEntries(resolved.hashParams)).toEqual(routeCase.hash ?? {});
  });

  it("never reads the document pathname as a route in hash mode", () => {
    const resolved = readBootstrapLocation(
      { pathname: "/signed-out", search: "", hash: "#/" },
      { nativeShell: true },
    );

    expect(resolved.pathname).toBe("/");
  });
});

describe("appRouteHref", () => {
  it("addresses routes by path under browser history", () => {
    expect(appRouteHref("path", "/signed-out")).toBe("/signed-out");
    expect(appRouteHref("path", "/pair", new URLSearchParams({ next: "/" }))).toBe(
      "/pair?next=%2F",
    );
  });

  it("keeps routes inside the fragment under hash history", () => {
    expect(appRouteHref("hash", "/signed-out")).toBe("#/signed-out");
    expect(appRouteHref("hash", "/")).toBe("#/");
    expect(appRouteHref("hash", "/pair", new URLSearchParams())).toBe("#/pair");
  });
});
