// FILE: mediaAssetUrls.test.ts
// Purpose: Verifies that media URLs resolve through the same endpoint chain as every other server
//          URL, and that the read-only media credential is appended on the mobile shell only — a
//          browser or desktop URL that changed shape would silently invalidate its HTTP cache and
//          re-authenticate a route that was already working.
// Layer: Web utility tests
// Depends on: mocked ~/mediaAuthToken (the credential itself is exercised in mediaAuthToken.test)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mediaUrlIdentity,
  resolveMediaHttpUrl,
  toAttachmentPreviewUrl,
  withCurrentMediaCredential,
} from "./mediaAssetUrls";

let mediaToken: string | null = null;
vi.mock("../mediaAuthToken", () => ({
  readMediaAuthToken: () => mediaToken,
}));

function stubWindow(bridgeWsUrl?: string): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        protocol: "http:",
        hostname: "localhost",
        port: "3020",
        origin: "http://localhost:3020",
      },
      desktopBridge: bridgeWsUrl === undefined ? undefined : { getWsUrl: () => bridgeWsUrl },
    },
  });
}

beforeEach(() => {
  vi.stubEnv("VITE_WS_URL", "");
  mediaToken = null;
  stubWindow();
});

afterEach(() => {
  vi.unstubAllEnvs();
  Reflect.deleteProperty(globalThis, "window");
});

describe("resolveMediaHttpUrl", () => {
  it("leaves the URL byte-identical when this runtime has no media credential", () => {
    stubWindow("ws://bridge:9000/ws?token=legacy-token");
    // The desktop window authenticates these routes with its startup token and a browser with its
    // cookie; neither may acquire a second credential it does not need.
    expect(resolveMediaHttpUrl("/api/project-favicon?cwd=%2Fsrc")).toBe(
      "http://bridge:9000/api/project-favicon?cwd=%2Fsrc&token=legacy-token",
    );
  });

  it("appends the credential when one is held", () => {
    mediaToken = "media-token-1";
    stubWindow("ws://192.168.1.5:3773/ws");
    expect(resolveMediaHttpUrl("/api/site-favicon?domain=example.com")).toBe(
      "http://192.168.1.5:3773/api/site-favicon?domain=example.com&mediaToken=media-token-1",
    );
  });

  it("replaces a stale credential rather than appending a second one", () => {
    mediaToken = "media-token-2";
    stubWindow("ws://192.168.1.5:3773/ws");
    expect(resolveMediaHttpUrl("/api/attachments/1?mediaToken=media-token-1")).toBe(
      "http://192.168.1.5:3773/api/attachments/1?mediaToken=media-token-2",
    );
  });
});

describe("mediaUrlIdentity", () => {
  it("is stable across a credential rotation", () => {
    expect(mediaUrlIdentity("http://h/api/site-favicon?domain=x.com&mediaToken=a")).toBe(
      mediaUrlIdentity("http://h/api/site-favicon?domain=x.com&mediaToken=b"),
    );
  });

  it("keeps every other query parameter, and the URL itself when there is no credential", () => {
    expect(mediaUrlIdentity("http://h/api/local-image?path=%2Fa.png&cwd=%2Fp&mediaToken=a")).toBe(
      "http://h/api/local-image?path=%2Fa.png&cwd=%2Fp",
    );
    expect(mediaUrlIdentity("http://h/api/attachments/1/preview")).toBe(
      "http://h/api/attachments/1/preview",
    );
  });

  it("handles a server-relative path and a credential-only query", () => {
    expect(mediaUrlIdentity("/api/attachments/1/preview?mediaToken=a")).toBe(
      "/api/attachments/1/preview",
    );
  });

  it("distinguishes different assets", () => {
    expect(mediaUrlIdentity("http://h/api/site-favicon?domain=x.com&mediaToken=a")).not.toBe(
      mediaUrlIdentity("http://h/api/site-favicon?domain=y.com&mediaToken=a"),
    );
  });
});

describe("toAttachmentPreviewUrl", () => {
  it("resolves server-relative paths through the endpoint chain", () => {
    stubWindow("ws://bridge:9000/ws");
    expect(toAttachmentPreviewUrl("/api/attachments/1/preview")).toBe(
      "http://bridge:9000/api/attachments/1/preview",
    );
  });

  it("leaves the credential off, because the result is kept in store state", () => {
    mediaToken = "media-token-1";
    stubWindow("ws://bridge:9000/ws");
    // A credential baked into store state goes stale in place; it is stamped on at render.
    expect(toAttachmentPreviewUrl("/api/attachments/1/preview")).toBe(
      "http://bridge:9000/api/attachments/1/preview",
    );
  });

  it("passes fully-qualified URLs through untouched", () => {
    mediaToken = "media-token-1";
    // Someone else's origin: appending our credential to it would leak it off-server.
    expect(toAttachmentPreviewUrl("https://example.com/image.png")).toBe(
      "https://example.com/image.png",
    );
  });
});

describe("withCurrentMediaCredential", () => {
  it("stamps the current credential onto a stored server URL", () => {
    mediaToken = "media-token-2";
    stubWindow("ws://bridge:9000/ws");
    expect(withCurrentMediaCredential("http://bridge:9000/api/attachments/1/preview")).toBe(
      "http://bridge:9000/api/attachments/1/preview?mediaToken=media-token-2",
    );
  });

  it("replaces a credential that has since rotated", () => {
    mediaToken = "media-token-2";
    stubWindow("ws://bridge:9000/ws");
    expect(
      withCurrentMediaCredential("http://bridge:9000/api/attachments/1/preview?mediaToken=old"),
    ).toBe("http://bridge:9000/api/attachments/1/preview?mediaToken=media-token-2");
  });

  it("leaves blob, data and third-party URLs alone", () => {
    mediaToken = "media-token-2";
    stubWindow("ws://bridge:9000/ws");
    // Composer previews are local object URLs, and someone else's image is not ours to stamp.
    expect(withCurrentMediaCredential("blob:http://localhost:3020/abc")).toBe(
      "blob:http://localhost:3020/abc",
    );
    expect(withCurrentMediaCredential("data:image/png;base64,AAA")).toBe(
      "data:image/png;base64,AAA",
    );
    expect(withCurrentMediaCredential("https://example.com/image.png")).toBe(
      "https://example.com/image.png",
    );
  });

  it("is byte-for-byte inert without a credential", () => {
    stubWindow("ws://bridge:9000/ws");
    expect(withCurrentMediaCredential("http://bridge:9000/api/attachments/1/preview")).toBe(
      "http://bridge:9000/api/attachments/1/preview",
    );
  });
});
