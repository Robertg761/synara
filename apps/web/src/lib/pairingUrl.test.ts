// FILE: pairingUrl.test.ts
// Purpose: Covers pairing URL construction against the server's /pair contract, and the connect
//          screen's parse of pasted pairing links / tokens / server addresses back out of it.

import { describe, expect, it } from "vitest";

import {
  makePairingUrl,
  normalizeServerBaseUrl,
  parsePairingInput,
  type ParsedPairingInput,
} from "./pairingUrl";

describe("makePairingUrl", () => {
  it("places the credential in the fragment of the /pair path", () => {
    expect(makePairingUrl("http://100.71.203.27:3773", "ABCDEF234567")).toBe(
      "http://100.71.203.27:3773/pair#token=ABCDEF234567",
    );
  });

  it("drops any query and path from the base origin", () => {
    expect(makePairingUrl("http://192.168.1.42:3773/some/path?x=1", "TOKEN2345678")).toBe(
      "http://192.168.1.42:3773/pair#token=TOKEN2345678",
    );
  });
});

interface ParseCase {
  readonly name: string;
  readonly input: string;
  readonly expected: ParsedPairingInput;
}

const PARSE_CASES: ReadonlyArray<ParseCase> = [
  {
    name: "empty input",
    input: "",
    expected: { kind: "empty", serverUrl: null, credential: null },
  },
  {
    name: "whitespace-only input",
    input: "   \n ",
    expected: { kind: "empty", serverUrl: null, credential: null },
  },
  {
    name: "full pairing link (fragment token)",
    input: "http://192.168.1.5:3773/pair#token=ABCDEF234567",
    expected: {
      kind: "pairingLink",
      serverUrl: "http://192.168.1.5:3773",
      credential: "ABCDEF234567",
    },
  },
  {
    name: "hash-history pairing link (nested fragment)",
    input: "http://192.168.1.5:3773/#/pair#token=ABCDEF234567",
    expected: {
      kind: "pairingLink",
      serverUrl: "http://192.168.1.5:3773",
      credential: "ABCDEF234567",
    },
  },
  {
    name: "pairing link with a query token",
    input: "http://192.168.1.5:3773/pair?token=QUERY2345678",
    expected: {
      kind: "pairingLink",
      serverUrl: "http://192.168.1.5:3773",
      credential: "QUERY2345678",
    },
  },
  {
    name: "https pairing link keeps the scheme and drops the path",
    input: "https://box.tail1234.ts.net/pair#token=HTTPS2345678",
    expected: {
      kind: "pairingLink",
      serverUrl: "https://box.tail1234.ts.net",
      credential: "HTTPS2345678",
    },
  },
  {
    name: "pairing link surrounded by whitespace",
    input: "  http://192.168.1.5:3773/pair#token=ABCDEF234567\n",
    expected: {
      kind: "pairingLink",
      serverUrl: "http://192.168.1.5:3773",
      credential: "ABCDEF234567",
    },
  },
  {
    name: "scheme-less pairing link",
    input: "192.168.1.5:3773/pair#token=ABCDEF234567",
    expected: {
      kind: "pairingLink",
      serverUrl: "http://192.168.1.5:3773",
      credential: "ABCDEF234567",
    },
  },
  {
    name: "bare token",
    input: "ABCDEF234567",
    expected: { kind: "credential", serverUrl: null, credential: "ABCDEF234567" },
  },
  {
    name: "dotted token whose last label is not alphabetic stays a credential",
    input: "eyJhbGciOi.eyJhIjox.4pcPyMD09",
    expected: {
      kind: "credential",
      serverUrl: null,
      credential: "eyJhbGciOi.eyJhIjox.4pcPyMD09",
    },
  },
  {
    name: "bare host:port without a scheme",
    input: "192.168.1.5:3773",
    expected: { kind: "serverUrl", serverUrl: "http://192.168.1.5:3773", credential: null },
  },
  {
    name: "bare localhost:port without a scheme",
    input: "localhost:3773",
    expected: { kind: "serverUrl", serverUrl: "http://localhost:3773", credential: null },
  },
  {
    name: "server URL with a trailing slash",
    input: "http://192.168.1.5:3773/",
    expected: { kind: "serverUrl", serverUrl: "http://192.168.1.5:3773", credential: null },
  },
  {
    name: "garbage that cannot be a URL falls back to a raw credential",
    input: "not a real url",
    expected: { kind: "credential", serverUrl: null, credential: "not a real url" },
  },
  {
    name: "garbage that declares an http scheme is rejected",
    input: "http://",
    expected: { kind: "invalid", serverUrl: null, credential: null },
  },
  {
    name: "a non-http scheme is never a server address",
    input: "mailto:someone@example.com",
    expected: {
      kind: "credential",
      serverUrl: null,
      credential: "mailto:someone@example.com",
    },
  },
];

describe("parsePairingInput", () => {
  for (const testCase of PARSE_CASES) {
    it(testCase.name, () => {
      expect(parsePairingInput(testCase.input)).toEqual(testCase.expected);
    });
  }

  it("is the inverse of makePairingUrl", () => {
    const credential = "ROUNDTRIP234567";
    const parsed = parsePairingInput(makePairingUrl("http://192.168.1.42:3773", credential));
    expect(parsed).toEqual({
      kind: "pairingLink",
      serverUrl: "http://192.168.1.42:3773",
      credential,
    });
  });
});

const NORMALIZE_CASES: ReadonlyArray<readonly [string, string | null]> = [
  ["192.168.1.5:3773", "http://192.168.1.5:3773"],
  ["  http://192.168.1.5:3773/  ", "http://192.168.1.5:3773"],
  ["https://box.tail1234.ts.net", "https://box.tail1234.ts.net"],
  ["box.tail1234.ts.net", "http://box.tail1234.ts.net"],
  // A bare word is a legal host, matching the native shell's normalizeBaseUrl.
  ["box", "http://box"],
  ["http://192.168.1.5:3773/some/path", "http://192.168.1.5:3773"],
  ["", null],
  ["   ", null],
  ["not a real url", null],
  ["ftp://192.168.1.5", null],
  ["http://", null],
];

describe("normalizeServerBaseUrl", () => {
  for (const [input, expected] of NORMALIZE_CASES) {
    it(`${JSON.stringify(input)} -> ${String(expected)}`, () => {
      expect(normalizeServerBaseUrl(input)).toBe(expected);
    });
  }
});
