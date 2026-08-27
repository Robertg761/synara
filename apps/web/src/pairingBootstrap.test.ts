import { describe, expect, it, vi } from "vitest";

import { readBootstrapLocation } from "./lib/bootstrapLocation";
import { bootstrapPairingSession } from "./pairingBootstrap";

function makeDependencies(input: {
  readonly pathname?: string;
  readonly search?: string;
  readonly hash?: string;
  readonly nativeShell?: boolean;
  readonly responseOk?: boolean;
}) {
  const events: Array<string> = [];
  const replace = vi.fn((url: string) => events.push(`navigate:${url}`));
  const replaceState = vi.fn((_data: unknown, _unused: string, url?: string | URL | null) =>
    events.push(`scrub:${String(url)}`),
  );
  const fetch = vi.fn(async () => {
    events.push("fetch");
    return { ok: input.responseOk ?? true } as Response;
  });
  const renderFailure = vi.fn(() => events.push("failure"));

  return {
    dependencies: {
      location: readBootstrapLocation(
        {
          pathname: input.pathname ?? "/pair",
          search: input.search ?? "",
          hash: input.hash ?? "#token=PAIRING-SECRET",
        },
        { nativeShell: input.nativeShell },
      ),
      replace,
      history: { replaceState },
      fetch: fetch as typeof globalThis.fetch,
      renderFailure,
    },
    events,
    fetch,
    replace,
    replaceState,
    renderFailure,
  };
}

const EXPECTED_EXCHANGE_REQUEST = [
  "/api/auth/bootstrap",
  {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential: "PAIRING-SECRET" }),
  },
] as const;

describe("bootstrapPairingSession", () => {
  it("ignores every route except the dedicated pairing route", async () => {
    const test = makeDependencies({ pathname: "/" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("not-pairing");
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.replaceState).not.toHaveBeenCalled();
  });

  it("ignores non-pairing routes under hash history", async () => {
    const test = makeDependencies({ pathname: "/", hash: "#/" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("not-pairing");
    expect(test.fetch).not.toHaveBeenCalled();
    expect(test.replaceState).not.toHaveBeenCalled();
  });

  it("scrubs the fragment before exchanging it and redirects after success", async () => {
    const test = makeDependencies({});

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("redirecting");

    expect(test.events).toEqual(["scrub:/pair", "fetch", "navigate:/"]);
    expect(test.fetch).toHaveBeenCalledWith(...EXPECTED_EXCHANGE_REQUEST);
  });

  it("pairs in place under hash history without a document navigation", async () => {
    // https://host/#/pair#token=… — the browser keeps the whole route in location.hash.
    const test = makeDependencies({ pathname: "/", hash: "#/pair#token=PAIRING-SECRET" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("paired");

    expect(test.events).toEqual(["scrub:#/pair", "fetch", "scrub:#/"]);
    expect(test.fetch).toHaveBeenCalledWith(...EXPECTED_EXCHANGE_REQUEST);
    // A fragment-only origin cannot serve "/" as a document, so nothing may navigate.
    expect(test.replace).not.toHaveBeenCalled();
  });

  it("accepts a fragment-scoped credential query under hash history and scrubs it", async () => {
    const test = makeDependencies({
      pathname: "/index.html",
      hash: "#/pair?token=PAIRING-SECRET&next=%2F",
    });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("paired");

    expect(test.events).toEqual(["scrub:#/pair?next=%2F", "fetch", "scrub:#/"]);
    expect(test.fetch).toHaveBeenCalledWith(...EXPECTED_EXCHANGE_REQUEST);
  });

  it("renders a token-free failure state when the exchange is rejected", async () => {
    const test = makeDependencies({ responseOk: false });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("failed");

    expect(test.events).toEqual(["scrub:/pair", "fetch", "failure"]);
    expect(test.replace).not.toHaveBeenCalled();
    expect(test.renderFailure).toHaveBeenCalledOnce();
  });

  it("fails without making a request when the fragment has no credential", async () => {
    const test = makeDependencies({ hash: "" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("failed");
    expect(test.events).toEqual(["scrub:/pair", "failure"]);
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it("fails without making a request when a hash-history link has no credential", async () => {
    const test = makeDependencies({ pathname: "/", hash: "#/pair" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("failed");
    expect(test.events).toEqual(["scrub:#/pair", "failure"]);
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it("never treats a real query string as a credential under browser history", async () => {
    // A query would reach the server (logs, proxies), so it is not a pairing channel.
    const test = makeDependencies({ search: "?token=PAIRING-SECRET", hash: "" });

    await expect(bootstrapPairingSession(test.dependencies)).resolves.toBe("failed");
    expect(test.events).toEqual(["scrub:/pair", "failure"]);
    expect(test.fetch).not.toHaveBeenCalled();
  });
});
