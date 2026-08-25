// FILE: wsAuthTicket.test.ts
// Purpose: Verifies the mobile upgrade-ticket mint: the off-mobile no-op, reuse of an unconsumed
//          ticket across dials, the unreachable-vs-revoked split, the signed-out redirect (once
//          per pairing, but re-armed by re-pairing), and the rate-limit cooldown.
// Layer: Web auth support tests
// Depends on: mocked ~/env, ~/shellAuthSession, ~/shellSession and ~/appHistoryMode (the history
//             mode is irrelevant here — only the href it would build for the connect route).
//             ~/shellSessionExit runs for real: the revocation latch is what is under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetShellSessionExitStateForTests } from "./shellSessionExit";
import {
  acquireWsTicket,
  authenticateSocketUrl,
  noteWsTicketConsumed,
  resetWsAuthTicketStateForTests,
  WS_AUTH_TICKET_PATH,
} from "./wsAuthTicket";

// Live binding read through a getter so one test file can exercise both shells: the module under
// test reads `isMobileShell` off the namespace on every access.
let mobileShell = false;

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

const bearerToken = vi.fn<() => Promise<string | null>>(() => Promise.resolve("owner-token"));
vi.mock("./shellAuthSession", () => ({
  acquireShellBearerToken: () => bearerToken(),
  invalidateShellBearerToken: () => undefined,
}));

const clearSession = vi.fn<() => Promise<void>>(() => Promise.resolve());
// Only a successful pairing advances this; `clearShellSession` deliberately does not, so the
// revocation latch holds until the device really pairs again.
let pairingGeneration = 0;
vi.mock("./shellSession", () => ({
  clearShellSession: () => clearSession(),
  getShellPairingGeneration: () => pairingGeneration,
}));

vi.mock("./appHistoryMode", () => ({
  appRouteDocumentHref: (path: string, searchParams?: URLSearchParams) =>
    `#${path}${searchParams ? `?${searchParams.toString()}` : ""}`,
}));

vi.mock("./lib/serverEndpoint", () => ({
  resolveWsHttpUrl: (path: string) => `http://192.168.1.5:3773${path}`,
}));

const assign = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  mobileShell = true;
  pairingGeneration = 1;
  bearerToken.mockResolvedValue("owner-token");
  clearSession.mockResolvedValue(undefined);
  vi.stubGlobal("window", { location: { assign } });
});

afterEach(() => {
  resetWsAuthTicketStateForTests();
  resetShellSessionExitStateForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("acquireWsTicket", () => {
  it("mints with the owner bearer token", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(200, { token: "ticket-1", expiresAt: "2026-01-01" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(acquireWsTicket()).resolves.toBe("ticket-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://192.168.1.5:3773${WS_AUTH_TICKET_PATH}`);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer owner-token" });
    // Bounded: the socket cannot be dialed until this settles.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reuses the unconsumed ticket across dials that never opened a socket", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { token: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse(200, { token: "ticket-2" }));
    vi.stubGlobal("fetch", fetchMock);

    // A failed dial leaves the ticket outstanding server-side. Minting per attempt would exhaust
    // the session's ticket budget within one reconnect storm.
    await expect(acquireWsTicket()).resolves.toBe("ticket-1");
    await expect(acquireWsTicket()).resolves.toBe("ticket-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The server consumes the ticket at the upgrade, so the next dial has to mint its own.
    noteWsTicketConsumed();
    await expect(acquireWsTicket()).resolves.toBe("ticket-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("mints again once the reuse window lapses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { token: "ticket-1" }))
      .mockResolvedValueOnce(jsonResponse(200, { token: "ticket-2" }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(acquireWsTicket()).resolves.toBe("ticket-1");
      vi.advanceTimersByTime(14_000);
      await expect(acquireWsTicket()).resolves.toBe("ticket-1");
      // Well inside the server's ticket TTL, so a stale reuse can never be the reason a dial is
      // refused for long.
      vi.advanceTimersByTime(1_000);
      await expect(acquireWsTicket()).resolves.toBe("ticket-2");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never offers a ticket minted for a different bearer", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { token: "ticket-old" }))
      .mockResolvedValueOnce(jsonResponse(200, { token: "ticket-new" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(acquireWsTicket()).resolves.toBe("ticket-old");

    // Re-paired (or signed out and back in): the cached ticket belongs to a session this device
    // no longer holds.
    bearerToken.mockResolvedValue("owner-token-2");
    await expect(acquireWsTicket()).resolves.toBe("ticket-new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null without touching the network off the mobile shell", async () => {
    mobileShell = false;
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(acquireWsTicket()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null without a stored bearer token", async () => {
    bearerToken.mockResolvedValue(null);
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(acquireWsTicket()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the pairing when the server is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    await expect(acquireWsTicket()).resolves.toBeNull();
    expect(clearSession).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("keeps the pairing for a non-401 rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(500, { error: "boom" }))),
    );

    await expect(acquireWsTicket()).resolves.toBeNull();
    expect(clearSession).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("treats a 2xx without a usable token as no ticket", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, { token: "" }))),
    );

    await expect(acquireWsTicket()).resolves.toBeNull();
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("clears the pairing and returns to connect once for concurrent 401s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(401, { error: "Unauthorized request." }))),
    );

    const results = await Promise.all([acquireWsTicket(), acquireWsTicket(), acquireWsTicket()]);

    expect(results).toEqual([null, null, null]);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("#/connect?reason=signed-out");
  });

  it("still leaves the connect screen reachable when secure storage refuses the clear", async () => {
    clearSession.mockRejectedValue(new Error("storage locked"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(401, {}))),
    );

    // The mint must not reject either: the transport runs it inside Effect.promise.
    await expect(acquireWsTicket()).resolves.toBeNull();
    expect(assign).toHaveBeenCalledWith("#/connect?reason=signed-out");
  });

  it("re-arms the redirect for a pairing that is revoked before its first successful mint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(401, {}))),
    );

    await expect(acquireWsTicket()).resolves.toBeNull();
    expect(assign).toHaveBeenCalledTimes(1);

    // Re-paired against a server that immediately refuses this device (link already revoked
    // server-side). Nothing minted successfully in between, so a latch re-armed only by an
    // accepted mint would leave this device stranded on a signed-out app.
    pairingGeneration += 1;
    await expect(acquireWsTicket()).resolves.toBeNull();

    expect(clearSession).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenLastCalledWith("#/connect?reason=signed-out");
  });

  it("keeps the pairing when the mint is rate limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(429, { error: "Too many ticket requests." }))),
    );

    // Load shedding, not revocation: the pairing is still good.
    await expect(acquireWsTicket()).resolves.toBeNull();
    expect(clearSession).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("stops minting for a cooldown window after a rate-limited mint", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(429, { error: "Too many ticket requests." }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(acquireWsTicket()).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // A WS-blocked network retries acquisition every few seconds forever. Minting each time
      // would keep the server's outstanding-ticket budget exhausted, wedging the other sockets on
      // this session, so retries inside the window skip the network and dial unauthenticated.
      vi.advanceTimersByTime(59_000);
      await expect(authenticateSocketUrl("ws://192.168.1.5:3773/ws?a=1")).resolves.toBe(
        "ws://192.168.1.5:3773/ws?a=1",
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_000);
      fetchMock.mockResolvedValue(jsonResponse(200, { token: "ticket-after-cooldown" }));
      await expect(acquireWsTicket()).resolves.toBe("ticket-after-cooldown");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The accepted mint retires that cooldown rather than leaving a stale deadline behind: a
      // later 429 has to arm a fresh window measured from when the server shed load again.
      noteWsTicketConsumed();
      vi.advanceTimersByTime(120_000);
      fetchMock.mockResolvedValue(jsonResponse(429, { error: "Too many ticket requests." }));
      await expect(acquireWsTicket()).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);

      vi.advanceTimersByTime(59_000);
      await expect(acquireWsTicket()).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("authenticateSocketUrl", () => {
  it("appends the ticket to the upgrade URL on mobile", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, { token: "ticket-1" }))),
    );

    await expect(authenticateSocketUrl("ws://192.168.1.5:3773/ws?a=1")).resolves.toBe(
      "ws://192.168.1.5:3773/ws?a=1&wsToken=ticket-1",
    );
  });

  it("dials unauthenticated when no ticket could be minted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    await expect(authenticateSocketUrl("ws://192.168.1.5:3773/ws?a=1")).resolves.toBe(
      "ws://192.168.1.5:3773/ws?a=1",
    );
  });

  it("returns the URL byte-identical off the mobile shell", async () => {
    mobileShell = false;
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const url =
      "ws://localhost:3020/ws?x-synara-client-build=0.0.0&x-synara-server-instance=server-1";
    await expect(authenticateSocketUrl(url)).resolves.toBe(url);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
