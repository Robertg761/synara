import { describe, expect, it } from "vitest";

import { buildCloudflaredArgs, parseTryCloudflareUrl } from "./cloudflaredQuickTunnel";

describe("buildCloudflaredArgs", () => {
  it("forwards the target and disables the auto-updater", () => {
    expect(buildCloudflaredArgs("http://127.0.0.1:3773")).toEqual([
      "tunnel",
      "--url",
      "http://127.0.0.1:3773",
      "--no-autoupdate",
      "--protocol",
      "http2",
    ]);
  });
});

describe("parseTryCloudflareUrl", () => {
  it("reads the URL from the quick-tunnel banner", () => {
    const banner = [
      "+--------------------------------------------------------------------------------------------+",
      "|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
      "|  https://slowly-royal-amount.trycloudflare.com                                              |",
      "+--------------------------------------------------------------------------------------------+",
    ].join("\n");
    expect(parseTryCloudflareUrl(banner)).toBe("https://slowly-royal-amount.trycloudflare.com");
  });

  it("finds the URL wherever it appears in a log line", () => {
    expect(
      parseTryCloudflareUrl(
        "2026-08-24T00:00:00Z INF +--------------------------------------------------------------------------------------------+|  Your quick Tunnel has been created! Visit it at https://bold-idea-example.trycloudflare.com",
      ),
    ).toBe("https://bold-idea-example.trycloudflare.com");
  });

  it("ignores unrelated output", () => {
    expect(parseTryCloudflareUrl("INF Starting tunnel protocol=http2")).toBeNull();
    expect(parseTryCloudflareUrl("")).toBeNull();
  });

  it("does not match lookalike hosts", () => {
    expect(parseTryCloudflareUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
    expect(parseTryCloudflareUrl("https://a.trycloudflare.com.evil.test/x")).toBeNull();
  });
});
