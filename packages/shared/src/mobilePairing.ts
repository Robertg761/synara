// FILE: mobilePairing.ts
// Purpose: Encode/decode the versioned mobile pairing deep link shared by desktop and iOS.
// Layer: Shared runtime utility
// Exports: encodeMobilePairingDeepLink, decodeMobilePairingDeepLink
//
// The credential rides only in the URL fragment: a query string would leak it
// into proxy and browser logs, so decoding rejects any link that carries one.

import {
  MOBILE_PAIRING_DEEP_LINK_HOST,
  MOBILE_PAIRING_DEEP_LINK_SCHEME,
  MOBILE_PAIRING_PAYLOAD_VERSION,
  type MobilePairingPayload,
} from "@synara/contracts";

const DEEP_LINK_PREFIX = `${MOBILE_PAIRING_DEEP_LINK_SCHEME}://${MOBILE_PAIRING_DEEP_LINK_HOST}#`;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes as unknown as ArrayLike<number>).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  if (typeof atob === "function") {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return new Uint8Array(Buffer.from(padded, "base64"));
}

/** `synara://pair#<base64url(JSON MobilePairingPayload)>`. Never log the result. */
export function encodeMobilePairingDeepLink(payload: MobilePairingPayload): string {
  const json = JSON.stringify({
    version: payload.version,
    baseUrl: payload.baseUrl,
    environmentId: payload.environmentId,
    credential: payload.credential,
    expiresAt: payload.expiresAt,
  });
  return `${DEEP_LINK_PREFIX}${toBase64Url(new TextEncoder().encode(json))}`;
}

export type MobilePairingDeepLinkFailure =
  | "malformed-uri"
  | "unexpected-query"
  | "missing-payload"
  | "malformed-payload"
  | "unsupported-version";

export type MobilePairingDeepLinkDecoded =
  | { readonly ok: true; readonly payload: MobilePairingPayload }
  | { readonly ok: false; readonly reason: MobilePairingDeepLinkFailure };

export function decodeMobilePairingDeepLink(link: string): MobilePairingDeepLinkDecoded {
  const trimmed = link.trim();
  const expectedHead = `${MOBILE_PAIRING_DEEP_LINK_SCHEME}://${MOBILE_PAIRING_DEEP_LINK_HOST}`;
  if (!trimmed.startsWith(expectedHead)) return { ok: false, reason: "malformed-uri" };
  const remainder = trimmed.slice(expectedHead.length);
  if (remainder.includes("?")) return { ok: false, reason: "unexpected-query" };
  if (!remainder.startsWith("#")) return { ok: false, reason: "missing-payload" };
  const fragment = remainder.slice(1);
  if (fragment.length === 0) return { ok: false, reason: "missing-payload" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(fragment)));
  } catch {
    return { ok: false, reason: "malformed-payload" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "malformed-payload" };
  }
  const candidate = parsed as Partial<Record<keyof MobilePairingPayload, unknown>>;
  if (typeof candidate.version !== "number") return { ok: false, reason: "malformed-payload" };
  if (candidate.version !== MOBILE_PAIRING_PAYLOAD_VERSION) {
    return { ok: false, reason: "unsupported-version" };
  }
  for (const key of ["baseUrl", "environmentId", "credential", "expiresAt"] as const) {
    if (typeof candidate[key] !== "string" || candidate[key].length === 0) {
      return { ok: false, reason: "malformed-payload" };
    }
  }
  return { ok: true, payload: candidate as unknown as MobilePairingPayload };
}
