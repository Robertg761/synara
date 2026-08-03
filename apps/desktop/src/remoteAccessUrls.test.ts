// FILE: remoteAccessUrls.test.ts
// Purpose: Covers interface classification and URL enumeration for remote access.

import { describe, expect, it } from "vitest";

import { classifyRemoteAccessAddress, listRemoteAccessUrls } from "./remoteAccessUrls";

describe("classifyRemoteAccessAddress", () => {
  it.each([
    ["100.64.0.1", "tailscale"],
    ["100.71.203.27", "tailscale"],
    ["100.127.255.254", "tailscale"],
    ["100.128.0.1", "other"],
    ["100.63.255.255", "other"],
    ["10.0.0.5", "lan"],
    ["172.16.0.1", "lan"],
    ["172.31.255.1", "lan"],
    ["172.32.0.1", "other"],
    ["192.168.1.42", "lan"],
    ["192.169.1.42", "other"],
    ["203.0.113.9", "other"],
    ["not-an-ip", "other"],
  ] as const)("classifies %s as %s", (address, kind) => {
    expect(classifyRemoteAccessAddress(address)).toBe(kind);
  });
});

describe("listRemoteAccessUrls", () => {
  it("lists non-internal IPv4 addresses sorted tailscale-first and deduplicated", () => {
    const urls = listRemoteAccessUrls({
      port: 3773,
      interfaces: {
        lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
        eth0: [
          { family: "IPv4", address: "192.168.1.42", internal: false },
          { family: "IPv6", address: "fe80::1", internal: false },
        ],
        tailscale0: [{ family: "IPv4", address: "100.71.203.27", internal: false }],
        docker0: [{ family: "IPv4", address: "192.168.1.42", internal: false }],
        missing: undefined,
      },
    });

    expect(urls).toEqual([
      { url: "http://100.71.203.27:3773", kind: "tailscale" },
      { url: "http://192.168.1.42:3773", kind: "lan" },
    ]);
  });

  it("supports numeric IPv4 family values (Node 18+ shape)", () => {
    expect(
      listRemoteAccessUrls({
        port: 4881,
        interfaces: { eth0: [{ family: 4, address: "10.1.2.3", internal: false }] },
      }),
    ).toEqual([{ url: "http://10.1.2.3:4881", kind: "lan" }]);
  });
});
