// FILE: mediaAuthToken.test.ts
// Purpose: Verifies the media credential's lifecycle: minted only where it is needed, once for a
//          screenful of icons, refreshed ahead of expiry, dropped when the pairing changes, and
//          never re-requested in a tight loop after a failure.
// Layer: Web auth support tests
// Depends on: mocked ~/env, ~/shellSession and ./lib/authenticatedFetch

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureMediaAuthToken,
  MEDIA_AUTH_TOKEN_PATH,
  readMediaAuthToken,
  resetMediaAuthTokenStateForTests,
  subscribeMediaAuthToken,
} from "./mediaAuthToken";

let mobileShell = true;
vi.mock("./env", () => ({
  get isMobileShell() {
    return mobileShell;
  },
  get isNativeShell() {
    return mobileShell;
  },
  isElectron: false,
  appRuntime: "browser",
}));

let pairingGeneration = 1;
vi.mock("./shellSession", () => ({
  getShellPairingGeneration: () => pairingGeneration,
}));

const authenticatedServerFetch = vi.fn<(path: string, options?: unknown) => Promise<Response>>();
vi.mock("./lib/authenticatedFetch", () => ({
  authenticatedServerFetch: (path: string, options?: unknown) =>
    authenticatedServerFetch(path, options),
}));

function tokenResponse(token: string, ttlMillis = 15 * 60_000): Response {
  return new Response(
    JSON.stringify({ token, expiresAt: new Date(Date.now() + ttlMillis).toISOString() }),
    { status: 200 },
  );
}

beforeEach(() => {
  mobileShell = true;
  pairingGeneration = 1;
  authenticatedServerFetch.mockReset();
});

afterEach(() => {
  resetMediaAuthTokenStateForTests();
});

describe("ensureMediaAuthToken", () => {
  it("mints once and reuses the credential", async () => {
    authenticatedServerFetch.mockResolvedValue(tokenResponse("media-1"));

    await expect(ensureMediaAuthToken()).resolves.toBe("media-1");
    await expect(ensureMediaAuthToken()).resolves.toBe("media-1");

    expect(authenticatedServerFetch).toHaveBeenCalledTimes(1);
    const [path, options] = authenticatedServerFetch.mock.calls[0]!;
    expect(path).toBe(MEDIA_AUTH_TOKEN_PATH);
    expect(options).toMatchObject({ method: "POST", cache: "no-store" });
  });

  it("shares one request across concurrent callers", async () => {
    authenticatedServerFetch.mockResolvedValue(tokenResponse("media-1"));

    // A sidebar full of project icons resolves its URLs in one render pass.
    await Promise.all([ensureMediaAuthToken(), ensureMediaAuthToken(), ensureMediaAuthToken()]);

    expect(authenticatedServerFetch).toHaveBeenCalledTimes(1);
  });

  it("never touches the network off the mobile shell", async () => {
    mobileShell = false;

    await expect(ensureMediaAuthToken()).resolves.toBeNull();
    expect(readMediaAuthToken()).toBeNull();
    expect(authenticatedServerFetch).not.toHaveBeenCalled();
  });

  it("keeps quiet for a cooldown after a failed mint", async () => {
    vi.useFakeTimers();
    authenticatedServerFetch.mockRejectedValue(new Error("network down"));
    try {
      await expect(ensureMediaAuthToken()).resolves.toBeNull();
      await expect(ensureMediaAuthToken()).resolves.toBeNull();
      // Called from render, so an unreachable server must not cost one POST per painted icon.
      expect(authenticatedServerFetch).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(10_000);
      authenticatedServerFetch.mockResolvedValue(tokenResponse("media-1"));
      await expect(ensureMediaAuthToken()).resolves.toBe("media-1");
      expect(authenticatedServerFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a 2xx without a usable payload", async () => {
    authenticatedServerFetch.mockResolvedValue(
      new Response(JSON.stringify({ token: "", expiresAt: "nope" }), { status: 200 }),
    );

    await expect(ensureMediaAuthToken()).resolves.toBeNull();
    expect(readMediaAuthToken()).toBeNull();
  });
});

describe("readMediaAuthToken", () => {
  it("answers null before the first mint and starts one", async () => {
    authenticatedServerFetch.mockResolvedValue(tokenResponse("media-1"));

    expect(readMediaAuthToken()).toBeNull();
    await vi.waitFor(() => expect(readMediaAuthToken()).toBe("media-1"));
  });

  it("tells subscribers when the credential arrives so rendered URLs get rebuilt", async () => {
    authenticatedServerFetch.mockResolvedValue(tokenResponse("media-1"));
    const listener = vi.fn();
    const unsubscribe = subscribeMediaAuthToken(listener);

    await ensureMediaAuthToken();

    expect(listener).toHaveBeenCalledWith("media-1");
    unsubscribe();
  });

  it("re-mints ahead of expiry rather than handing out a nearly dead credential", async () => {
    vi.useFakeTimers();
    try {
      // Inside the refresh margin the moment it is minted: still usable, but due for renewal.
      authenticatedServerFetch.mockResolvedValue(tokenResponse("media-1", 60_000));
      await expect(ensureMediaAuthToken()).resolves.toBe("media-1");

      authenticatedServerFetch.mockResolvedValue(tokenResponse("media-2"));
      // A URL built now still gets the live credential — a broken image is worse than a short one.
      expect(readMediaAuthToken()).toBe("media-1");
      await vi.waitFor(() => expect(readMediaAuthToken()).toBe("media-2"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a credential minted for a previous pairing", async () => {
    authenticatedServerFetch.mockResolvedValue(tokenResponse("media-1"));
    await expect(ensureMediaAuthToken()).resolves.toBe("media-1");

    pairingGeneration += 1;
    authenticatedServerFetch.mockResolvedValue(tokenResponse("media-2"));

    expect(readMediaAuthToken()).toBeNull();
    await expect(ensureMediaAuthToken()).resolves.toBe("media-2");
  });
});
