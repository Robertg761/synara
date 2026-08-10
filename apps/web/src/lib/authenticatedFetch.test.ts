// FILE: authenticatedFetch.test.ts
// Purpose: Verifies the one authenticated-HTTP path: a browser request stays exactly as it was
//          (cookie only, no headers object), a native shell attaches its bearer, and an answered
//          401 means "re-bootstrap once" on desktop but "this device is repudiated" on mobile.
// Layer: Web auth support tests
// Depends on: mocked ~/env, ~/shellAuthSession, ~/shellSessionExit and ./serverEndpoint

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authenticatedServerFetch } from "./authenticatedFetch";

let mobileShell = false;
vi.mock("../env", () => ({
  get isMobileShell() {
    return mobileShell;
  },
  get isNativeShell() {
    return mobileShell;
  },
  isElectron: false,
  appRuntime: "browser",
}));

let bearerToken: string | null = null;
const invalidateShellBearerToken = vi.fn(() => {
  bearerToken = "rebootstrapped-bearer";
});
vi.mock("../shellAuthSession", () => ({
  acquireShellBearerToken: () => Promise.resolve(bearerToken),
  invalidateShellBearerToken: () => invalidateShellBearerToken(),
}));

const handleShellSessionRevoked = vi.fn(() => Promise.resolve());
vi.mock("../shellSessionExit", () => ({
  forgetShellSession: () => Promise.resolve(),
  handleShellSessionRevoked: () => handleShellSessionRevoked(),
}));

vi.mock("./serverEndpoint", () => ({
  resolveWsHttpUrl: (path: string) => `http://192.168.1.5:3773${path}`,
}));

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  mobileShell = false;
  bearerToken = null;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authenticatedServerFetch", () => {
  it("sends a plain same-origin request in a browser", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    await authenticatedServerFetch("/api/attachments/upload?type=image", {
      method: "POST",
      credentials: "include",
      body: "bytes",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://192.168.1.5:3773/api/attachments/upload?type=image");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    // No credential to attach, so no headers object at all: the cookie flow keeps working
    // untouched, and a bare POST never trips a CORS preflight it did not trip before.
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBe("bytes");
  });

  it("attaches the shell's bearer alongside caller headers", async () => {
    bearerToken = "owner-bearer";
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    await authenticatedServerFetch("/api/attachments/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(fetchMock.mock.calls[0]![1]?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer owner-bearer",
    });
  });

  it("re-bootstraps once on a 401 off the mobile shell", async () => {
    bearerToken = "stale-bearer";
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const response = await authenticatedServerFetch("/api/auth/clients");

    expect(response.status).toBe(200);
    expect(invalidateShellBearerToken).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]![1]?.headers).toEqual({
      Authorization: "Bearer rebootstrapped-bearer",
    });
    expect(handleShellSessionRevoked).not.toHaveBeenCalled();
  });

  it("treats a 401 on the mobile shell as revocation instead of retrying", async () => {
    mobileShell = true;
    bearerToken = "paired-bearer";
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(401));
    vi.stubGlobal("fetch", fetchMock);

    const response = await authenticatedServerFetch("/api/auth/media-token", { method: "POST" });

    expect(response.status).toBe(401);
    // Retrying would replay the very token the server just refused; the pairing is the session.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invalidateShellBearerToken).not.toHaveBeenCalled();
    expect(handleShellSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it("leaves a browser 401 alone — there is no bearer to blame", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse(401));
    vi.stubGlobal("fetch", fetchMock);

    await authenticatedServerFetch("/api/auth/clients");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handleShellSessionRevoked).not.toHaveBeenCalled();
  });
});
