// FILE: branding.test.ts
// Purpose: Verifies the client build identity reported during WebSocket negotiation.
// Layer: Web constants tests
// Depends on: mocked ~/env so both shells can be exercised from one file.

import { SYNARA_MOBILE_CLIENT_BUILD_PREFIX } from "@synara/shared/mobileIdentity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { APP_VERSION, resolveClientBuild } from "./branding";

let mobileShell = false;

vi.mock("./env", () => ({
  get isMobileShell() {
    return mobileShell;
  },
  get isNativeShell() {
    return mobileShell;
  },
  isElectron: false,
  appRuntime: "browser",
}));

afterEach(() => {
  mobileShell = false;
});

describe("resolveClientBuild", () => {
  it("reports the plain app version off the mobile shell", () => {
    expect(resolveClientBuild()).toBe(APP_VERSION);
  });

  it("prefixes the version on the mobile shell", () => {
    mobileShell = true;
    expect(resolveClientBuild()).toBe(`${SYNARA_MOBILE_CLIENT_BUILD_PREFIX}-${APP_VERSION}`);
    expect(resolveClientBuild()).not.toBe(APP_VERSION);
  });
});
