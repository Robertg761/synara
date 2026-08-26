// FILE: connectRouteSearch.test.ts
// Purpose: Verifies the connect screen only ever sees a reason it knows how to explain.
// Layer: Route state utility tests

import { describe, expect, it } from "vitest";

import { connectRouteSearchParams, parseConnectRouteSearch } from "./connectRouteSearch";

describe("parseConnectRouteSearch", () => {
  it("keeps the signed-out reason", () => {
    expect(parseConnectRouteSearch({ reason: "signed-out" })).toEqual({ reason: "signed-out" });
  });

  it("drops absent, unknown and non-string reasons", () => {
    expect(parseConnectRouteSearch({})).toEqual({});
    expect(parseConnectRouteSearch({ reason: "whatever" })).toEqual({});
    expect(parseConnectRouteSearch({ reason: 1 })).toEqual({});
  });
});

describe("connectRouteSearchParams", () => {
  it("round-trips through a query string", () => {
    const params = connectRouteSearchParams("signed-out");
    expect(params.toString()).toBe("reason=signed-out");
    expect(parseConnectRouteSearch(Object.fromEntries(params))).toEqual({ reason: "signed-out" });
  });
});
