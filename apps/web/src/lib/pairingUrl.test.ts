// FILE: pairingUrl.test.ts
// Purpose: Covers pairing URL construction against the server's /pair contract.

import { describe, expect, it } from "vitest";

import { makePairingUrl } from "./pairingUrl";

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
