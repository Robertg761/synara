// FILE: remoteAccessUrls.ts
// Purpose: Enumerates and classifies the reachable URLs for desktop remote access.
// Layer: Desktop main process (pure helpers)

import type { DesktopRemoteAccessUrl, DesktopRemoteAccessUrlKind } from "@synara/contracts";

/** Shape-compatible subset of `os.NetworkInterfaceInfo` for testability. */
export interface RemoteAccessInterfaceAddress {
  readonly family: string | number;
  readonly address: string;
  readonly internal: boolean;
}

const KIND_DISPLAY_ORDER: Record<DesktopRemoteAccessUrlKind, number> = {
  tailscale: 0,
  lan: 1,
  other: 2,
};

function parseIpv4(address: string): readonly [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? (octets as unknown as readonly [number, number, number, number])
    : null;
}

/**
 * Tailscale assigns addresses from the CGNAT range 100.64.0.0/10; RFC1918
 * ranges classify as LAN. Anything else non-internal is "other" so exposure
 * stays visible rather than hidden.
 */
export function classifyRemoteAccessAddress(address: string): DesktopRemoteAccessUrlKind {
  const octets = parseIpv4(address);
  if (!octets) return "other";
  const [first, second] = octets;
  if (first === 100 && second >= 64 && second <= 127) return "tailscale";
  if (first === 10) return "lan";
  if (first === 172 && second >= 16 && second <= 31) return "lan";
  if (first === 192 && second === 168) return "lan";
  return "other";
}

export function listRemoteAccessUrls(input: {
  readonly interfaces: Readonly<
    Record<string, ReadonlyArray<RemoteAccessInterfaceAddress> | undefined>
  >;
  readonly port: number;
}): DesktopRemoteAccessUrl[] {
  const seen = new Set<string>();
  const urls: DesktopRemoteAccessUrl[] = [];
  for (const addresses of Object.values(input.interfaces)) {
    for (const entry of addresses ?? []) {
      const isIpv4 = entry.family === "IPv4" || entry.family === 4;
      if (!isIpv4 || entry.internal || seen.has(entry.address)) continue;
      seen.add(entry.address);
      urls.push({
        url: `http://${entry.address}:${input.port}`,
        kind: classifyRemoteAccessAddress(entry.address),
      });
    }
  }
  return urls.toSorted(
    (left, right) =>
      KIND_DISPLAY_ORDER[left.kind] - KIND_DISPLAY_ORDER[right.kind] ||
      left.url.localeCompare(right.url),
  );
}
