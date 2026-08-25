// FILE: serverEndpoint.test.ts
// Purpose: Verifies the single server-endpoint precedence chain shared by the WS transport
// and HTTP asset requests (explicit → mobile shell → desktop bridge → VITE_WS_URL → page origin).
// Layer: Web utility tests
// Depends on: the desktop bridge URL contract stubbed onto a fake window, and a fake
// MobileBridge injected into the shell session cache.

import type { MobileBridge, MobileShellSession } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hydrateShellSession, resetShellSessionForTests } from "../shellSession";
import { resolveServerWsBase, resolveWsHttpUrl } from "./serverEndpoint";

/** Pairs the shell session cache with `serverUrl` the way a hydrated mobile shell would be. */
async function pairShellWith(serverUrl: string): Promise<void> {
  const stored: MobileShellSession = { serverUrl, sessionToken: "shell-token" };
  const bridge = {
    session: {
      get: () => Promise.resolve(stored),
      set: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    },
    consumePendingThreadOpen: () => Promise.resolve(null),
    addListener: () => Promise.resolve({ remove: () => Promise.resolve() }),
  } as unknown as MobileBridge;
  await hydrateShellSession(bridge);
}

function stubWindow(input: {
  readonly protocol?: string;
  readonly bridgeWsUrl?: string | null;
}): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        protocol: input.protocol ?? "http:",
        hostname: "localhost",
        port: "3020",
        origin: `${input.protocol === "https:" ? "https" : "http"}://localhost:3020`,
      },
      desktopBridge:
        input.bridgeWsUrl === undefined || input.bridgeWsUrl === null
          ? undefined
          : { getWsUrl: () => input.bridgeWsUrl },
    },
  });
}

beforeEach(() => {
  vi.stubEnv("VITE_WS_URL", "");
  stubWindow({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetShellSessionForTests();
  Reflect.deleteProperty(globalThis, "window");
});

describe("resolveServerWsBase", () => {
  it("prefers an explicit URL over every configured source", () => {
    stubWindow({ bridgeWsUrl: "ws://bridge:9000" });
    vi.stubEnv("VITE_WS_URL", "ws://env:9001");
    expect(resolveServerWsBase("ws://explicit:9002")).toBe("ws://explicit:9002");
  });

  it("prefers an explicit URL over the paired mobile shell server", async () => {
    await pairShellWith("https://box.ts.net");
    expect(resolveServerWsBase("ws://explicit:9002")).toBe("ws://explicit:9002");
  });

  it("prefers the paired mobile shell server over every other configured source", async () => {
    stubWindow({ bridgeWsUrl: "ws://bridge:9000" });
    vi.stubEnv("VITE_WS_URL", "ws://env:9001");
    await pairShellWith("https://box.ts.net:8443");
    expect(resolveServerWsBase()).toBe("wss://box.ts.net:8443");
  });

  it("ignores an unpaired shell session", () => {
    vi.stubEnv("VITE_WS_URL", "ws://env:9001");
    expect(resolveServerWsBase()).toBe("ws://env:9001");
  });

  it("prefers the desktop bridge over the env override", () => {
    stubWindow({ bridgeWsUrl: "ws://bridge:9000/ws?token=abc" });
    vi.stubEnv("VITE_WS_URL", "ws://env:9001");
    expect(resolveServerWsBase()).toBe("ws://bridge:9000/ws?token=abc");
  });

  it("uses the env override when no bridge URL is available", () => {
    vi.stubEnv("VITE_WS_URL", "ws://env:9001");
    expect(resolveServerWsBase()).toBe("ws://env:9001");
  });

  it("falls back to the page origin with a ws scheme on http pages", () => {
    expect(resolveServerWsBase()).toBe("ws://localhost:3020");
  });

  it("falls back to the page origin with a wss scheme on https pages", () => {
    stubWindow({ protocol: "https:" });
    expect(resolveServerWsBase()).toBe("wss://localhost:3020");
  });

  it("ignores an empty bridge URL", () => {
    stubWindow({ bridgeWsUrl: "" });
    vi.stubEnv("VITE_WS_URL", "ws://env:9001");
    expect(resolveServerWsBase()).toBe("ws://env:9001");
  });
});

describe("resolveWsHttpUrl", () => {
  it("resolves against the page origin when nothing is configured", () => {
    expect(resolveWsHttpUrl("/api/attachments/1")).toBe("http://localhost:3020/api/attachments/1");
  });

  it("mirrors the bridge WS host with the matching http scheme", () => {
    stubWindow({ bridgeWsUrl: "ws://bridge:9000/ws" });
    expect(resolveWsHttpUrl("/api/attachments/1")).toBe("http://bridge:9000/api/attachments/1");
  });

  it("mirrors the paired mobile shell host ahead of the desktop bridge", async () => {
    stubWindow({ bridgeWsUrl: "ws://bridge:9000/ws" });
    await pairShellWith("https://box.ts.net");
    expect(resolveWsHttpUrl("/api/attachments/1")).toBe("https://box.ts.net/api/attachments/1");
  });

  it("maps wss to https", () => {
    stubWindow({ bridgeWsUrl: "wss://bridge:9000/ws" });
    expect(resolveWsHttpUrl("/api/attachments/1")).toBe("https://bridge:9000/api/attachments/1");
  });

  it("forwards the legacy token query param from the WS URL", () => {
    stubWindow({ bridgeWsUrl: "ws://bridge:9000/ws?token=legacy-token" });
    expect(resolveWsHttpUrl("/api/attachments/1")).toBe(
      "http://bridge:9000/api/attachments/1?token=legacy-token",
    );
  });

  it("does not overwrite a token already present on the path", () => {
    stubWindow({ bridgeWsUrl: "ws://bridge:9000/ws?token=legacy-token" });
    expect(resolveWsHttpUrl("/api/attachments/1?token=own-token")).toBe(
      "http://bridge:9000/api/attachments/1?token=own-token",
    );
  });

  it("does not forward the websocket token to an absolute external URL", () => {
    stubWindow({ bridgeWsUrl: "wss://synara.test/ws?token=legacy-secret" });
    expect(resolveWsHttpUrl("https://example.test/image.png")).toBe(
      "https://example.test/image.png",
    );
  });

  it("falls back to the page origin when the configured WS URL is unparsable", () => {
    stubWindow({ bridgeWsUrl: "not a url" });
    expect(resolveWsHttpUrl("/api/attachments/1")).toBe("http://localhost:3020/api/attachments/1");
  });
});
