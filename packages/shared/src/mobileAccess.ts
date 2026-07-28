// FILE: mobileAccess.ts
// Purpose: Normalize and resolve the owner-configured mobile access policy.
// Layer: Shared runtime utility
// Exports: config normalization, root identity, and reachability resolution
//
// One resolver serves the desktop shell (which writes the config and derives
// backend arguments) and the server (which loads it at startup and reports
// status), so bind host, published base URL, and pairing eligibility can never
// disagree between the two.

import {
  type MobileAccessConfig,
  type MobileAccessMode,
  type MobileAccessReachability,
  type MobileApprovedRoot,
  type MobileRootId,
} from "@synara/contracts";

export const MOBILE_ACCESS_LOOPBACK_HOST = "127.0.0.1";

export const DEFAULT_MOBILE_ACCESS_CONFIG: MobileAccessConfig = {
  enabled: false,
  mode: "trusted-proxy",
  approvedRoots: [],
};

const MOBILE_ACCESS_MODES: ReadonlyArray<MobileAccessMode> = ["trusted-proxy", "private-lan"];

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Lenient normalization: a hand-edited or partially written config must degrade
 * to a safe loopback-only policy rather than fail the whole startup.
 */
export function normalizeMobileAccessConfig(raw: unknown): MobileAccessConfig {
  if (typeof raw !== "object" || raw === null) return DEFAULT_MOBILE_ACCESS_CONFIG;
  const source = raw as Record<string, unknown>;
  const mode = MOBILE_ACCESS_MODES.find((candidate) => candidate === source.mode);
  const publicBaseUrl = asTrimmedString(source.publicBaseUrl);
  const privateBindAddress = asTrimmedString(source.privateBindAddress);
  const approvedRoots = Array.isArray(source.approvedRoots)
    ? Array.from(
        new Set(
          source.approvedRoots
            .map((entry) => asTrimmedString(entry))
            .filter((entry): entry is string => entry !== undefined),
        ),
      )
    : [];
  return {
    enabled: source.enabled === true,
    mode: mode ?? "trusted-proxy",
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    ...(privateBindAddress === undefined ? {} : { privateBindAddress }),
    approvedRoots,
  };
}

export function parseMobileAccessConfig(text: string): MobileAccessConfig {
  try {
    return normalizeMobileAccessConfig(JSON.parse(text));
  } catch {
    return DEFAULT_MOBILE_ACCESS_CONFIG;
  }
}

export function serializeMobileAccessConfig(config: MobileAccessConfig): string {
  return `${JSON.stringify(normalizeMobileAccessConfig(config), null, 2)}\n`;
}

/**
 * Only an exact HTTPS root origin qualifies: a path, query, credential, or
 * fragment means the operator described something other than the endpoint the
 * mobile client will dial.
 */
export function normalizeTrustedHttpsBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  return url.origin;
}

/** Private-LAN binds must name a concrete private interface, never a wildcard. */
export function isPrivateBindAddress(value: string): boolean {
  const host = value
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (host.length === 0) return false;
  if (host === "0.0.0.0" || host === "::" || host === "*") return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1, 5).map(Number);
    if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return false;
    const [a = 0, b = 0] = octets;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (host.includes(":")) {
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  return false;
}

export interface MobileAccessResolutionInput {
  readonly config: MobileAccessConfig | null | undefined;
  /** False in Release builds: only development builds may expose the plain listener. */
  readonly allowPrivateLan: boolean;
  readonly port: number;
}

export interface MobileAccessResolution {
  readonly enabled: boolean;
  readonly mode: MobileAccessMode;
  readonly reachability: MobileAccessReachability;
  /** Host the backend HTTP listener binds to. Loopback unless private-LAN is active. */
  readonly bindHost: string;
  /** Exact base URL that may be published in a pairing payload. */
  readonly pairingBaseUrl: string | null;
  readonly pairingBlockedReason: string | null;
  readonly insecureDevelopmentAccess: boolean;
}

export function resolveMobileAccess(input: MobileAccessResolutionInput): MobileAccessResolution {
  const config = input.config ?? DEFAULT_MOBILE_ACCESS_CONFIG;
  const base = {
    enabled: config.enabled,
    mode: config.mode,
    bindHost: MOBILE_ACCESS_LOOPBACK_HOST,
    pairingBaseUrl: null,
    insecureDevelopmentAccess: false,
  } as const;

  if (!config.enabled) {
    return {
      ...base,
      reachability: "disabled",
      pairingBlockedReason: "Mobile access is turned off. Enable it to pair a device.",
    };
  }

  if (config.mode === "private-lan") {
    if (!input.allowPrivateLan) {
      return {
        ...base,
        reachability: "loopback-only",
        pairingBlockedReason:
          "Private LAN access is a development-build-only mode; this build serves loopback only.",
      };
    }
    const bindAddress = config.privateBindAddress?.trim() ?? "";
    if (!isPrivateBindAddress(bindAddress)) {
      return {
        ...base,
        reachability: "loopback-only",
        pairingBlockedReason:
          "Private LAN access needs a specific private interface address (for example 192.168.1.24).",
      };
    }
    const hostForUrl = bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress;
    return {
      enabled: true,
      mode: "private-lan",
      reachability: "private-lan-insecure",
      bindHost: bindAddress,
      pairingBaseUrl: `http://${hostForUrl}:${input.port}`,
      pairingBlockedReason: null,
      insecureDevelopmentAccess: true,
    };
  }

  const publicBaseUrl = config.publicBaseUrl?.trim() ?? "";
  const normalized =
    publicBaseUrl.length === 0 ? null : normalizeTrustedHttpsBaseUrl(publicBaseUrl);
  if (normalized === null) {
    return {
      ...base,
      reachability: "loopback-only",
      pairingBlockedReason:
        publicBaseUrl.length === 0
          ? "Add the HTTPS endpoint your proxy publishes (for example https://mac.tail1234.ts.net)."
          : "The published endpoint must be an HTTPS root origin with no path, query, or credentials.",
    };
  }
  return {
    enabled: true,
    mode: "trusted-proxy",
    reachability: "trusted-proxy",
    bindHost: MOBILE_ACCESS_LOOPBACK_HOST,
    pairingBaseUrl: normalized,
    pairingBlockedReason: null,
    insecureDevelopmentAccess: false,
  };
}

/**
 * Stable opaque handle for an approved root. Derived from the canonical path so
 * it survives restarts, but never reveals it (FNV-1a is sufficient: the value
 * is an identifier, not a secret).
 */
export function mobileAccessRootId(canonicalPath: string): MobileRootId {
  let hash = 0xcbf2_9ce4_8422_2325n;
  const bytes = new TextEncoder().encode(canonicalPath);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x1000_0000_01b3n) & 0xffff_ffff_ffff_ffffn;
  }
  return `root-${hash.toString(16).padStart(16, "0")}` as MobileRootId;
}

export function mobileAccessRootLabel(canonicalPath: string): string {
  const segments = canonicalPath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? canonicalPath;
}

export function toMobileApprovedRoot(canonicalPath: string): MobileApprovedRoot {
  return {
    rootId: mobileAccessRootId(canonicalPath),
    label: mobileAccessRootLabel(canonicalPath),
    path: canonicalPath,
  };
}
