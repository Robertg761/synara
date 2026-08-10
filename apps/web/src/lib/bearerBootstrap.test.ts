// FILE: bearerBootstrap.test.ts
// Purpose: Covers the pairing-credential -> bearer-session exchange, especially the failure
//          split the connect screen shows different messages for.

import { describe, expect, it, vi } from "vitest";

import { BEARER_BOOTSTRAP_PATH, requestBearerSession } from "./bearerBootstrap";

const ENDPOINT = `http://192.168.1.5:3773${BEARER_BOOTSTRAP_PATH}`;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("requestBearerSession", () => {
  it("posts the credential in the body and returns the session token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ sessionToken: "SESSION-1" }));

    await expect(requestBearerSession(ENDPOINT, "CREDENTIAL-1", fetchImpl)).resolves.toEqual({
      ok: true,
      sessionToken: "SESSION-1",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ credential: "CREDENTIAL-1" }));
    // The credential must never travel anywhere but the body.
    expect(url).not.toContain("CREDENTIAL-1");
  });

  it("reports an unreachable server when the request never gets a response", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(requestBearerSession(ENDPOINT, "CREDENTIAL-1", fetchImpl)).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("reports a rejection when the server answers with an error status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "expired" }, { status: 401 }));

    await expect(requestBearerSession(ENDPOINT, "CREDENTIAL-1", fetchImpl)).resolves.toEqual({
      ok: false,
      reason: "rejected",
    });
  });

  it("reports a missing token when the server answers 2xx without one", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ sessionToken: "" }));

    await expect(requestBearerSession(ENDPOINT, "CREDENTIAL-1", fetchImpl)).resolves.toEqual({
      ok: false,
      reason: "noSessionToken",
    });
  });

  it("reports a missing token when the body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));

    await expect(requestBearerSession(ENDPOINT, "CREDENTIAL-1", fetchImpl)).resolves.toEqual({
      ok: false,
      reason: "noSessionToken",
    });
  });
});
