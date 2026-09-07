// FILE: pairingUrl.ts
// Purpose: Builds the /pair URL a remote device opens to claim a pairing credential, and parses
//          pasted connect-screen input (a pairing link, a bare token, or a server address) back
//          into a normalized server URL + credential.
// Layer: Web utility
// Exports: makePairingUrl, normalizeServerBaseUrl, parsePairingInput, ParsedPairingInput,
//          ParsedPairingInputKind
// Depends on: ./bootstrapLocation (pure) — a pairing link exists in both history-mode shapes and
//             only that module knows how to read the credential out of either one.

import { readBootstrapLocation } from "./bootstrapLocation";

const PAIRING_CREDENTIAL_PARAM = "token";

/** What a pasted string turned out to be. `serverUrl`/`credential` follow from this. */
export type ParsedPairingInputKind =
  /** Blank input. */
  | "empty"
  /** A full pairing link: both a server address and a credential. */
  | "pairingLink"
  /** A server address only (`http://box:3773`, `192.168.1.5:3773`). */
  | "serverUrl"
  /** Anything that is not a URL — treated as a raw pairing credential. */
  | "credential"
  /** Declared an http(s) scheme but is not a usable URL. */
  | "invalid";

export interface ParsedPairingInput {
  readonly kind: ParsedPairingInputKind;
  /** Normalized `scheme://host[:port]`, or null when the input carried no server address. */
  readonly serverUrl: string | null;
  /** Pairing credential, or null when the input carried none. Never log this value. */
  readonly credential: string | null;
}

const EMPTY_INPUT: ParsedPairingInput = { kind: "empty", serverUrl: null, credential: null };
const INVALID_INPUT: ParsedPairingInput = { kind: "invalid", serverUrl: null, credential: null };

const HTTP_SCHEME_PATTERN = /^https?:\/\//i;
/** Any `scheme://` prefix. `host:port` is deliberately not a match — `localhost:` looks like one. */
const SCHEME_AUTHORITY_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
/** `host[:port][/path]` with no scheme and no whitespace — the shape a user types by hand. */
const HOST_CANDIDATE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::\d{1,5})?(?:\/[^\s]*)?$/i;
const EXPLICIT_PORT_PATTERN = /:\d{1,5}$/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** A dotted name ending in an alphabetic label, e.g. `box.example.net`. */
const DOTTED_HOSTNAME_PATTERN = /\.[a-z]{2,}$/i;

/**
 * Mirrors the server's startup pairing URL shape (`ServerAuth.issueStartupPairingUrl`):
 * the credential travels in the fragment so it never reaches server logs or proxies.
 */
export function makePairingUrl(origin: string, credential: string): string {
  const url = new URL(origin);
  url.pathname = "/pair";
  url.search = "";
  url.hash = new URLSearchParams([[PAIRING_CREDENTIAL_PARAM, credential]]).toString();
  return url.toString();
}

/**
 * Normalize whatever the user typed into the server-address field into `scheme://host[:port]`,
 * or null when it cannot be a server. Ported from the native shell's `normalizeBaseUrl`: an
 * absent scheme means `http://` (LAN self-hosting is the common case) and trailing slashes go.
 *
 * Only the origin survives, because that is all the rest of the app can use: `toShellServerWsBase`
 * keeps the origin, and `resolveWsHttpUrl` overwrites the path — path prefixes are unsupported
 * repo-wide, so accepting one here would silently drop it later.
 */
export function normalizeServerBaseUrl(input: string): string | null {
  return parseServerUrl(input.trim())?.origin ?? null;
}

/** The one place scheme defaulting and http(s)-only validation happen. Null when unusable. */
function parseServerUrl(trimmed: string): URL | null {
  if (trimmed.length === 0) return null;
  // `ftp://host` must fail rather than become `http://ftp://host`, which parses as host `ftp`.
  if (SCHEME_AUTHORITY_PATTERN.test(trimmed) && !HTTP_SCHEME_PATTERN.test(trimmed)) return null;
  const candidate = HTTP_SCHEME_PATTERN.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.host.length === 0 ? null : url;
}

/**
 * Whether scheme-less input should be read as a server address rather than as a raw credential.
 *
 * Pairing credentials are opaque strings, so `box` alone is ambiguous. We only claim the input
 * when it carries positive evidence of being a host: an explicit port, `localhost`, an IPv4
 * literal, or a dotted name ending in an alphabetic label. Credentials (hex/base64url, and JWTs
 * whose last segment is not alphabetic) fail all four, and the connect screen keeps an explicit
 * server-URL field — which calls `normalizeServerBaseUrl` directly — for everything else.
 */
function looksLikeServerAddress(trimmed: string): boolean {
  if (!HOST_CANDIDATE_PATTERN.test(trimmed)) return false;
  const authority = trimmed.split("/", 1)[0] ?? "";
  if (EXPLICIT_PORT_PATTERN.test(authority)) return true;
  const hostname = authority.toLowerCase();
  return (
    hostname === "localhost" ||
    IPV4_PATTERN.test(hostname) ||
    DOTTED_HOSTNAME_PATTERN.test(hostname)
  );
}

/**
 * Read the credential out of an already-parsed pairing link. `readBootstrapLocation` normalizes
 * both link shapes — path history (`https://host/pair#token=…`) and hash history
 * (`https://host/#/pair#token=…`) — so this stays the inverse of `makePairingUrl` in either mode.
 * A `?token=` query is accepted too: older links and hand-edited ones use it.
 */
function readCredentialFromUrl(url: URL): string | null {
  const location = readBootstrapLocation({
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  });
  const credential =
    location.hashParams.get(PAIRING_CREDENTIAL_PARAM) ??
    location.searchParams.get(PAIRING_CREDENTIAL_PARAM);
  return credential !== null && credential.length > 0 ? credential : null;
}

/**
 * Classify one pasted string for the connect screen, which offers a single "paste anything" field
 * next to an explicit server-URL field. The inverse of `makePairingUrl`: a full pairing link
 * yields both halves, a bare token yields only the credential, a bare address only the server URL.
 *
 * Pure and total — it never throws and never touches the network — so the screen can call it on
 * every keystroke.
 */
export function parsePairingInput(input: string): ParsedPairingInput {
  const trimmed = input.trim();
  if (trimmed.length === 0) return EMPTY_INPUT;

  const hasHttpScheme = HTTP_SCHEME_PATTERN.test(trimmed);
  // Announced as a URL but not one we can pair with (`ftp://…`): bad input, not a credential.
  if (!hasHttpScheme && SCHEME_AUTHORITY_PATTERN.test(trimmed)) return INVALID_INPUT;
  // Everything else without a scheme that carries no evidence of being a host — including
  // `mailto:x` and any token containing a colon — is the credential itself.
  if (!hasHttpScheme && !looksLikeServerAddress(trimmed)) {
    return { kind: "credential", serverUrl: null, credential: trimmed };
  }

  const url = parseServerUrl(trimmed);
  if (url === null) {
    // It announced itself as a URL and still does not parse; calling it a credential would send
    // garbage to the server, so surface it as bad input instead.
    return INVALID_INPUT;
  }

  const credential = readCredentialFromUrl(url);
  return credential === null
    ? { kind: "serverUrl", serverUrl: url.origin, credential: null }
    : { kind: "pairingLink", serverUrl: url.origin, credential };
}
