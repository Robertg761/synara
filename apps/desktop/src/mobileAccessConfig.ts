// FILE: mobileAccessConfig.ts
// Purpose: Persist and gate the owner-configured mobile access policy for the desktop shell.
// Layer: Desktop configuration
//
// The file names the owner's approved directories, so it is written 0600 and
// never logged. Mode gating lives here rather than in the UI: a Release build
// must not be able to hand the backend a plaintext non-loopback bind even if a
// hand-edited config asks for one.

import FS from "node:fs";
import Path from "node:path";

import {
  MOBILE_ACCESS_CONFIG_FILE_NAME,
  type MobileAccessConfig,
  type MobileAccessMode,
} from "@synara/contracts";
import {
  DEFAULT_MOBILE_ACCESS_CONFIG,
  normalizeMobileAccessConfig,
  parseMobileAccessConfig,
  resolveMobileAccess,
  serializeMobileAccessConfig,
} from "@synara/shared/mobileAccess";

export const MOBILE_ACCESS_CONFIG_FILE_MODE = 0o600;

export function resolveMobileAccessConfigPath(userDataDir: string): string {
  return Path.join(userDataDir, MOBILE_ACCESS_CONFIG_FILE_NAME);
}

export function readMobileAccessConfig(configPath: string): MobileAccessConfig {
  let text: string;
  try {
    text = FS.readFileSync(configPath, "utf8");
  } catch {
    return DEFAULT_MOBILE_ACCESS_CONFIG;
  }
  return parseMobileAccessConfig(text);
}

/**
 * The desktop renderer must dial the same concrete interface as the backend.
 * A private-LAN listener is not reachable through 127.0.0.1 even from the same
 * Mac, while trusted-proxy and disabled modes remain loopback-only.
 */
export function resolveDesktopBackendHost(
  config: MobileAccessConfig,
  options: { readonly privateLanAvailable: boolean },
): string {
  return resolveMobileAccess({
    config: gateMobileAccessConfig(config, options),
    allowPrivateLan: options.privateLanAvailable,
    port: 0,
  }).bindHost;
}

/**
 * Release builds have no private-LAN mode: `publicUrl` describes a proxy and
 * adds no TLS, so exposing `http.createServer()` directly is never acceptable
 * outside a development build. A stored `private-lan` therefore degrades to a
 * disabled trusted-proxy policy instead of silently binding.
 */
export function gateMobileAccessConfig(
  config: MobileAccessConfig,
  options: { readonly privateLanAvailable: boolean },
): MobileAccessConfig {
  const normalized = normalizeMobileAccessConfig(config);
  if (normalized.mode !== "private-lan" || options.privateLanAvailable) return normalized;
  const { privateBindAddress: _privateBindAddress, ...rest } = normalized;
  return { ...rest, mode: "trusted-proxy", enabled: false };
}

export function writeMobileAccessConfig(
  configPath: string,
  config: MobileAccessConfig,
  options: { readonly privateLanAvailable: boolean },
): MobileAccessConfig {
  const gated = gateMobileAccessConfig(config, options);
  FS.mkdirSync(Path.dirname(configPath), { recursive: true });
  FS.writeFileSync(configPath, serializeMobileAccessConfig(gated), {
    encoding: "utf8",
    mode: MOBILE_ACCESS_CONFIG_FILE_MODE,
  });
  // writeFileSync only applies `mode` when it creates the file, so an existing
  // file keeps whatever permissions it had until this narrows it.
  if (process.platform !== "win32") FS.chmodSync(configPath, MOBILE_ACCESS_CONFIG_FILE_MODE);
  return gated;
}

/**
 * Explicit backend handoff. Only the config path and the private-LAN capability
 * cross the boundary — never the approved roots, which the backend reads from
 * the file itself.
 */
export function mobileAccessBackendEnv(input: {
  readonly configPath: string;
  readonly privateLanAvailable: boolean;
}): Record<string, string> {
  return {
    SYNARA_MOBILE_ACCESS_CONFIG: input.configPath,
    ...(input.privateLanAvailable ? { SYNARA_MOBILE_ACCESS_ALLOW_PRIVATE_LAN: "1" } : {}),
  };
}

export function isMobileAccessMode(value: unknown): value is MobileAccessMode {
  return value === "trusted-proxy" || value === "private-lan";
}

/** Structural validation for the IPC boundary: the renderer is not trusted. */
export function isMobileAccessConfigInput(value: unknown): value is MobileAccessConfig {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean") return false;
  if (!isMobileAccessMode(input.mode)) return false;
  if (input.publicBaseUrl !== undefined && typeof input.publicBaseUrl !== "string") return false;
  if (input.privateBindAddress !== undefined && typeof input.privateBindAddress !== "string") {
    return false;
  }
  return (
    Array.isArray(input.approvedRoots) &&
    input.approvedRoots.every((entry) => typeof entry === "string")
  );
}
