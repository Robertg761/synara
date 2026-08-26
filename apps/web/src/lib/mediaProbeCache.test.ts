// FILE: mediaProbeCache.test.ts
// Purpose: Verifies that a probe cache forgets negative outcomes across a change of media
//          credential and keeps positive ones — the difference between "this site has no favicon"
//          and "this client had no credential yet when it asked".
// Layer: Web utility tests
// Depends on: mocked ~/mediaAuthToken

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMediaProbeCache } from "./mediaProbeCache";

let mediaToken: string | null = null;
vi.mock("../mediaAuthToken", () => ({
  readMediaAuthToken: () => mediaToken,
}));

beforeEach(() => {
  mediaToken = null;
});

describe("createMediaProbeCache", () => {
  it("drops a negative outcome once the credential that produced it is gone", () => {
    const cache = createMediaProbeCache<"ok" | "fail">((status) => status === "fail");

    // The pre-credential probe: a 401 the mobile shell reads as "no favicon".
    cache.set("example.com", "fail");
    expect(cache.get("example.com")).toBe("fail");

    mediaToken = "media-token-1";
    expect(cache.get("example.com")).toBeUndefined();
    // The entry is gone rather than merely hidden, so nothing revives it later.
    mediaToken = null;
    expect(cache.get("example.com")).toBeUndefined();
  });

  it("keeps a positive outcome across every rotation", () => {
    const cache = createMediaProbeCache<boolean>((present) => present === false);

    mediaToken = "media-token-1";
    cache.set("/repo", true);

    mediaToken = "media-token-2";
    expect(cache.get("/repo")).toBe(true);
    mediaToken = null;
    expect(cache.get("/repo")).toBe(true);
  });

  it("files an outcome under the credential the probe actually ran with", () => {
    const cache = createMediaProbeCache<"ok" | "fail">((status) => status === "fail");

    // A probe that started under token 1 and landed after the rotation to token 2 must not be
    // recorded as token 2's verdict — the next render, still holding token 2, would trust it.
    mediaToken = "media-token-2";
    cache.set("example.com", "fail", "media-token-1");
    expect(cache.get("example.com")).toBeUndefined();

    cache.set("example.com", "fail", "media-token-2");
    expect(cache.get("example.com")).toBe("fail");
  });

  it("forgets everything on clear", () => {
    const cache = createMediaProbeCache<"ok" | "fail">((status) => status === "fail");

    cache.set("example.com", "ok");
    cache.clear();
    expect(cache.get("example.com")).toBeUndefined();
  });
});
