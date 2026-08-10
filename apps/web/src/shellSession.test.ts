// FILE: shellSession.test.ts
// Purpose: Verifies the mobile shell's hydrate-once session cache: URL conversion, single-flight
// hydration and how it reports a storage read that never answered, the off-mobile no-op, and the
// pair/clear write paths.
// Layer: Web shell integration tests
// Depends on: an injected fake MobileBridge (no Capacitor global involved).

import type { MobileBridge, MobileShellSession } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearShellSession,
  getShellPairingGeneration,
  getShellServerWsUrl,
  getShellSessionToken,
  hydrateShellSession,
  isShellPaired,
  pairFromCredential,
  resetShellSessionForTests,
  toShellServerWsBase,
} from "./shellSession";

function makeBridge(stored: MobileShellSession | null): {
  readonly bridge: MobileBridge;
  readonly get: ReturnType<typeof vi.fn>;
  readonly set: ReturnType<typeof vi.fn>;
  readonly clear: ReturnType<typeof vi.fn>;
} {
  let current = stored;
  const get = vi.fn(() => Promise.resolve(current));
  const set = vi.fn((session: MobileShellSession) => {
    current = session;
    return Promise.resolve();
  });
  const clear = vi.fn(() => {
    current = null;
    return Promise.resolve();
  });
  return {
    bridge: {
      session: { get, set, clear },
      consumePendingThreadOpen: () => Promise.resolve(null),
      addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
    },
    get,
    set,
    clear,
  };
}

afterEach(() => {
  resetShellSessionForTests();
});

describe("toShellServerWsBase", () => {
  it("maps http to ws and https to wss", () => {
    expect(toShellServerWsBase("http://192.168.1.5:3020")).toBe("ws://192.168.1.5:3020");
    expect(toShellServerWsBase("https://box.tail1234.ts.net")).toBe("wss://box.tail1234.ts.net");
  });

  it("passes ws(s) URLs through as their origin", () => {
    expect(toShellServerWsBase("ws://192.168.1.5:3020")).toBe("ws://192.168.1.5:3020");
    expect(toShellServerWsBase("wss://box.tail1234.ts.net")).toBe("wss://box.tail1234.ts.net");
  });

  it("drops any path, query and fragment", () => {
    expect(toShellServerWsBase("https://box.ts.net:8443/pair?a=1#token=abc")).toBe(
      "wss://box.ts.net:8443",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(toShellServerWsBase("  http://localhost:3020  ")).toBe("ws://localhost:3020");
  });

  it("returns null for input that is not an absolute http(s)/ws(s) URL", () => {
    expect(toShellServerWsBase("")).toBeNull();
    expect(toShellServerWsBase("192.168.1.5:3020")).toBeNull();
    expect(toShellServerWsBase("not a url")).toBeNull();
    expect(toShellServerWsBase("file:///tmp/x")).toBeNull();
    expect(toShellServerWsBase("javascript:alert(1)")).toBeNull();
  });
});

describe("hydrateShellSession", () => {
  it("reports storage as unavailable without a bridge instead of unpaired", async () => {
    // No bridge is not evidence about what is on the device: off the mobile shell nobody asks,
    // and on it a null bridge means the plugin has not attached yet.
    await expect(hydrateShellSession(null)).resolves.toBe("unavailable");
    expect(isShellPaired()).toBe(false);
    expect(getShellSessionToken()).toBeNull();
    expect(getShellServerWsUrl()).toBeNull();
  });

  it("exposes the stored session synchronously once hydrated", async () => {
    const { bridge } = makeBridge({ serverUrl: "https://box.ts.net", sessionToken: "tok-1" });
    await expect(hydrateShellSession(bridge)).resolves.toBe("paired");
    expect(isShellPaired()).toBe(true);
    expect(getShellSessionToken()).toBe("tok-1");
    expect(getShellServerWsUrl()).toBe("wss://box.ts.net");
  });

  it("stays unpaired when the device has never paired", async () => {
    const { bridge } = makeBridge(null);
    await expect(hydrateShellSession(bridge)).resolves.toBe("unpaired");
    expect(isShellPaired()).toBe(false);
  });

  it("treats a stored session with an unusable server URL as unpaired", async () => {
    const { bridge } = makeBridge({ serverUrl: "not a url", sessionToken: "tok-1" });
    await expect(hydrateShellSession(bridge)).resolves.toBe("unpaired");
    expect(isShellPaired()).toBe(false);
    expect(getShellSessionToken()).toBeNull();
    expect(getShellServerWsUrl()).toBeNull();
  });

  it("reads secure storage once across concurrent and repeat calls", async () => {
    const { bridge, get } = makeBridge({ serverUrl: "http://localhost:3020", sessionToken: "t" });
    await Promise.all([hydrateShellSession(bridge), hydrateShellSession(bridge)]);
    await hydrateShellSession(bridge);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("retries a failed read within the same hydration", async () => {
    // The keystore can still be locked, and the bridge still attaching, for a moment after a cold
    // start. Retrying costs a route load a few hundred milliseconds and saves a paired device
    // from being told it has never paired.
    const get = vi
      .fn<() => Promise<MobileShellSession | null>>()
      .mockRejectedValueOnce(new Error("keystore locked"))
      .mockResolvedValueOnce({ serverUrl: "http://localhost:3020", sessionToken: "t" });
    const bridge = {
      session: { get, set: vi.fn(), clear: vi.fn() },
      consumePendingThreadOpen: () => Promise.resolve(null),
      addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
    } as unknown as MobileBridge;

    await expect(hydrateShellSession(bridge)).resolves.toBe("paired");
    expect(get).toHaveBeenCalledTimes(2);
    expect(getShellSessionToken()).toBe("t");
  });

  it("reports unavailable — never unpaired — when storage keeps refusing, and does not cache it", async () => {
    const get = vi
      .fn<() => Promise<MobileShellSession | null>>()
      .mockRejectedValue(new Error("keystore locked"));
    const bridge = {
      session: { get, set: vi.fn(), clear: vi.fn() },
      consumePendingThreadOpen: () => Promise.resolve(null),
      addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
    } as unknown as MobileBridge;

    await expect(hydrateShellSession(bridge)).resolves.toBe("unavailable");
    expect(isShellPaired()).toBe(false);
    expect(get).toHaveBeenCalledTimes(3);

    // A read that never answered is not an answer to cache: the next caller tries again, and once
    // storage recovers the device is paired without a relaunch.
    get.mockResolvedValue({ serverUrl: "http://localhost:3020", sessionToken: "t" });
    await expect(hydrateShellSession(bridge)).resolves.toBe("paired");
    expect(get).toHaveBeenCalledTimes(4);
    expect(getShellSessionToken()).toBe("t");
  });

  it("does not let a slow read overwrite a pairing that happened meanwhile", async () => {
    let resolvePendingRead!: (session: MobileShellSession | null) => void;
    const pendingReadPromise = new Promise<MobileShellSession | null>((resolve) => {
      resolvePendingRead = resolve;
    });
    const get = vi.fn(() => pendingReadPromise);
    const bridge = {
      session: { get, set: vi.fn(() => Promise.resolve()), clear: vi.fn() },
      consumePendingThreadOpen: () => Promise.resolve(null),
      addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
    } as unknown as MobileBridge;

    const hydrating = hydrateShellSession(bridge);
    await pairFromCredential({ serverUrl: "https://new.ts.net", sessionToken: "fresh" }, bridge);
    resolvePendingRead({ serverUrl: "https://stale.ts.net", sessionToken: "stale" });
    await hydrating;

    expect(getShellSessionToken()).toBe("fresh");
    expect(getShellServerWsUrl()).toBe("wss://new.ts.net");
  });
});

describe("pairFromCredential", () => {
  it("persists through the bridge and updates memory immediately", async () => {
    const { bridge, set } = makeBridge(null);
    await pairFromCredential({ serverUrl: "http://10.0.0.2:3020", sessionToken: "tok-2" }, bridge);
    expect(set).toHaveBeenCalledWith({ serverUrl: "http://10.0.0.2:3020", sessionToken: "tok-2" });
    expect(getShellServerWsUrl()).toBe("ws://10.0.0.2:3020");
    expect(getShellSessionToken()).toBe("tok-2");
  });

  it("advances the pairing generation, which clearing does not", async () => {
    // What state latched against a repudiated session keys off: signing out must not re-arm it,
    // pairing again must.
    const { bridge } = makeBridge(null);
    const initial = getShellPairingGeneration();

    await pairFromCredential({ serverUrl: "https://box.ts.net", sessionToken: "tok" }, bridge);
    const afterPairing = getShellPairingGeneration();
    expect(afterPairing).not.toBe(initial);

    await clearShellSession(bridge);
    expect(getShellPairingGeneration()).toBe(afterPairing);

    await pairFromCredential({ serverUrl: "https://box.ts.net", sessionToken: "tok-2" }, bridge);
    expect(getShellPairingGeneration()).not.toBe(afterPairing);
  });

  it("does not advance the pairing generation when the write fails", async () => {
    const set = vi.fn(() => Promise.reject(new Error("keystore write failed")));
    const bridge = {
      session: { get: vi.fn(() => Promise.resolve(null)), set, clear: vi.fn() },
      consumePendingThreadOpen: () => Promise.resolve(null),
      addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
    } as unknown as MobileBridge;

    const initial = getShellPairingGeneration();
    await expect(
      pairFromCredential({ serverUrl: "https://box.ts.net", sessionToken: "tok" }, bridge),
    ).rejects.toThrow(/write failed/);
    expect(getShellPairingGeneration()).toBe(initial);
  });

  it("rejects an unusable server URL without persisting anything", async () => {
    const { bridge, set } = makeBridge(null);
    await expect(
      pairFromCredential({ serverUrl: "box.ts.net", sessionToken: "tok" }, bridge),
    ).rejects.toThrow(/unusable server URL/);
    expect(set).not.toHaveBeenCalled();
    expect(isShellPaired()).toBe(false);
  });

  it("refuses to pair without a bridge instead of mutating memory", async () => {
    await expect(
      pairFromCredential({ serverUrl: "https://box.ts.net", sessionToken: "tok" }, null),
    ).rejects.toThrow(/mobile shell/);
    expect(isShellPaired()).toBe(false);
    expect(getShellServerWsUrl()).toBeNull();
  });

  it("keeps the stored session reachable when the write fails", async () => {
    const stored: MobileShellSession = { serverUrl: "https://old.ts.net", sessionToken: "old" };
    const get = vi.fn(() => Promise.resolve(stored));
    const set = vi.fn(() => Promise.reject(new Error("keystore write failed")));
    const bridge = {
      session: { get, set, clear: vi.fn() },
      consumePendingThreadOpen: () => Promise.resolve(null),
      addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
    } as unknown as MobileBridge;

    await hydrateShellSession(bridge);
    await expect(
      pairFromCredential({ serverUrl: "https://new.ts.net", sessionToken: "new" }, bridge),
    ).rejects.toThrow(/write failed/);

    // Memory still holds the old session, and the failed write did not latch hydration shut:
    // the next hydrate re-reads storage, which still holds the old session too.
    expect(getShellSessionToken()).toBe("old");
    await hydrateShellSession(bridge);
    expect(get).toHaveBeenCalledTimes(2);
    expect(getShellSessionToken()).toBe("old");
    expect(getShellServerWsUrl()).toBe("wss://old.ts.net");
  });
});

describe("clearShellSession", () => {
  it("clears secure storage and memory", async () => {
    const { bridge, clear } = makeBridge({ serverUrl: "https://box.ts.net", sessionToken: "tok" });
    await hydrateShellSession(bridge);
    await clearShellSession(bridge);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(isShellPaired()).toBe(false);
    expect(getShellSessionToken()).toBeNull();
    expect(getShellServerWsUrl()).toBeNull();
  });

  it("is a no-op without a bridge", async () => {
    await expect(clearShellSession(null)).resolves.toBeUndefined();
    expect(isShellPaired()).toBe(false);
  });

  it("drops the repudiated session from memory even when secure storage refuses", async () => {
    const get = vi.fn(() =>
      Promise.resolve({ serverUrl: "https://box.ts.net", sessionToken: "t" }),
    );
    const clear = vi.fn(() => Promise.reject(new Error("keystore locked")));
    const bridge = {
      session: { get, set: vi.fn(), clear },
      consumePendingThreadOpen: () => Promise.resolve(null),
      addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
    } as unknown as MobileBridge;

    await hydrateShellSession(bridge);
    await expect(clearShellSession(bridge)).rejects.toThrow(/keystore locked/);

    // The failure surfaces, but the token the server repudiated is already unusable here.
    expect(isShellPaired()).toBe(false);
    expect(getShellSessionToken()).toBeNull();
    expect(getShellServerWsUrl()).toBeNull();

    // Storage may still hold it; a re-hydrate in this process must not resurrect it.
    await hydrateShellSession(bridge);
    expect(get).toHaveBeenCalledTimes(1);
    expect(isShellPaired()).toBe(false);
    expect(getShellSessionToken()).toBeNull();
  });
});
