// FILE: trustedOrigins.test.ts
// Purpose: Pins which browser origins can use local-data HTTP/WS surfaces.
// Layer: Server utility tests

import { SYNARA_MOBILE_APP_ORIGIN } from "@synara/shared/mobileIdentity";
import { describe, expect, it } from "vitest";

import type { ServerConfigShape } from "./config";
import {
  isTrustedAppOrigin,
  normalizeCorsOrigin,
  requiresWebSocketAuthentication,
  shouldRejectAuthMutationOrigin,
  shouldRejectUntrustedRequestOrigin,
} from "./trustedOrigins";

const config = {
  devUrl: new URL("http://localhost:5173/"),
} as ServerConfigShape;

describe("trustedOrigins", () => {
  it("trusts same-origin, configured dev, and desktop app origins", () => {
    expect(
      isTrustedAppOrigin({
        origin: "http://127.0.0.1:58090",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
    expect(
      isTrustedAppOrigin({
        origin: "http://localhost:5173",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
    expect(
      isTrustedAppOrigin({
        origin: "synara://app",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
    expect(
      isTrustedAppOrigin({
        origin: "synara-canary://app",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
  });

  it("trusts the packaged mobile shell origin", () => {
    expect(normalizeCorsOrigin(SYNARA_MOBILE_APP_ORIGIN)).toBe(SYNARA_MOBILE_APP_ORIGIN);
    expect(normalizeCorsOrigin(`${SYNARA_MOBILE_APP_ORIGIN}/`)).toBe(SYNARA_MOBILE_APP_ORIGIN);
    expect(
      isTrustedAppOrigin({
        origin: SYNARA_MOBILE_APP_ORIGIN,
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
  });

  it("rejects lookalike variations of the mobile shell origin", () => {
    for (const origin of [
      "https://app.synara.local.evil.example",
      "https://xapp.synara.local",
      "http://app.synara.local",
    ]) {
      expect(
        isTrustedAppOrigin({ origin, requestOrigin: "http://127.0.0.1:58090", config }),
        origin,
      ).toBe(false);
      expect(
        shouldRejectUntrustedRequestOrigin({
          rawOrigin: origin,
          requestOrigin: "http://127.0.0.1:58090",
          config,
        }),
        origin,
      ).toBe(true);
    }
  });

  it("rejects unrelated browser origins but allows non-browser requests without Origin", () => {
    expect(
      isTrustedAppOrigin({
        origin: "https://example.test",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(false);
    expect(
      isTrustedAppOrigin({
        origin: null,
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
  });

  it("trusts same-origin hosts only when local, configured, or wildcard-bound", () => {
    expect(
      isTrustedAppOrigin({
        origin: "http://evil.test:3773",
        requestOrigin: "http://evil.test:3773",
        config,
      }),
    ).toBe(false);
    expect(
      isTrustedAppOrigin({
        origin: "http://192.168.1.50:3773",
        requestOrigin: "http://192.168.1.50:3773",
        config: { ...config, host: "192.168.1.50" },
      }),
    ).toBe(true);
    expect(
      isTrustedAppOrigin({
        origin: "http://192.168.1.50:3773",
        requestOrigin: "http://192.168.1.50:3773",
        config: { ...config, host: "0.0.0.0" },
      }),
    ).toBe(true);
  });

  it("narrows browser traffic to the HTTPS public origin in proxy-backed remote mode while keeping the app shells", () => {
    const remoteConfig = {
      ...config,
      host: "0.0.0.0",
      publicUrl: new URL("https://synara.example.test/"),
    };
    expect(
      isTrustedAppOrigin({
        origin: "https://synara.example.test",
        requestOrigin: "http://synara.example.test",
        config: remoteConfig,
      }),
    ).toBe(true);
    expect(
      isTrustedAppOrigin({
        origin: "http://192.168.1.50:3773",
        requestOrigin: "http://192.168.1.50:3773",
        config: remoteConfig,
      }),
    ).toBe(false);
    // The packaged shells stay trusted in every deployment by design: they are cross-origin
    // clients of whatever server they point at, so a public URL must not lock them out.
    for (const shellOrigin of [SYNARA_MOBILE_APP_ORIGIN, "synara://app", "synara-canary://app"]) {
      expect(
        isTrustedAppOrigin({
          origin: shellOrigin,
          requestOrigin: "http://synara.example.test",
          config: remoteConfig,
        }),
        shellOrigin,
      ).toBe(true);
    }
  });

  it("normalizes desktop origins with trailing slashes", () => {
    expect(normalizeCorsOrigin("synara://app/")).toBe("synara://app");
    expect(normalizeCorsOrigin("synara-canary://app/")).toBe("synara-canary://app");
  });

  it("rejects present but untrusted request origins for websocket-style gates", () => {
    expect(
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: undefined,
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(false);
    expect(
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: "null",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
    expect(
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: "https://example.test",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
    expect(
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: "http://localhost:5173",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(false);
    expect(
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: "http://192.168.1.50:3773",
        requestOrigin: "http://192.168.1.50:3773",
        config: { ...config, host: "0.0.0.0" },
      }),
    ).toBe(false);
  });

  it("requires websocket authentication for every non-loopback exposure", () => {
    expect(
      requiresWebSocketAuthentication({
        host: "127.0.0.1",
        authToken: undefined,
        publicUrl: undefined,
      }),
    ).toBe(false);
    expect(
      requiresWebSocketAuthentication({ host: "::1", authToken: undefined, publicUrl: undefined }),
    ).toBe(false);
    expect(
      requiresWebSocketAuthentication({
        host: "0.0.0.0",
        authToken: undefined,
        publicUrl: undefined,
      }),
    ).toBe(true);
    expect(
      requiresWebSocketAuthentication({ host: "::", authToken: undefined, publicUrl: undefined }),
    ).toBe(true);
    expect(
      requiresWebSocketAuthentication({
        host: "192.168.1.50",
        authToken: undefined,
        publicUrl: undefined,
      }),
    ).toBe(true);
    expect(
      requiresWebSocketAuthentication({
        host: "127.0.0.1",
        authToken: "secret",
        publicUrl: undefined,
      }),
    ).toBe(true);
    expect(
      requiresWebSocketAuthentication({
        host: "127.0.0.1",
        authToken: undefined,
        publicUrl: new URL("https://synara.example.test/"),
      }),
    ).toBe(true);
  });

  it("requires browser mutations to have a trusted origin or explicit bearer provenance", () => {
    expect(
      shouldRejectAuthMutationOrigin({
        rawOrigin: undefined,
        requestOrigin: "http://127.0.0.1:58090",
        config,
        credentialSource: "cookie",
      }),
    ).toBe(true);
    expect(
      shouldRejectAuthMutationOrigin({
        rawOrigin: undefined,
        requestOrigin: "http://127.0.0.1:58090",
        config,
        credentialSource: "bearer",
      }),
    ).toBe(false);
    expect(
      shouldRejectAuthMutationOrigin({
        rawOrigin: "http://localhost:5173",
        requestOrigin: "http://127.0.0.1:58090",
        config,
        credentialSource: "cookie",
      }),
    ).toBe(false);
    for (const rawOrigin of ["null", "not a url", "https://example.test"]) {
      expect(
        shouldRejectAuthMutationOrigin({
          rawOrigin,
          requestOrigin: "http://127.0.0.1:58090",
          config,
          credentialSource: "bearer",
        }),
      ).toBe(true);
    }
  });
});
