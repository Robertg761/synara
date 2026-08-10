import { describe, expect, it } from "vitest";

import {
  mobileClientBuild,
  SYNARA_MOBILE_APP_HOSTNAME,
  SYNARA_MOBILE_APP_ID,
  SYNARA_MOBILE_APP_ORIGIN,
  SYNARA_MOBILE_CLIENT_BUILD_PREFIX,
} from "./mobileIdentity";

describe("mobileIdentity", () => {
  it("keeps the exact legacy Android application ID so upgrades stay in place", () => {
    expect(SYNARA_MOBILE_APP_ID).toBe("com.synara.android");
  });

  it("pins the shell hostname and the https origin derived from it", () => {
    expect(SYNARA_MOBILE_APP_HOSTNAME).toBe("app.synara.local");
    expect(SYNARA_MOBILE_APP_ORIGIN).toBe("https://app.synara.local");
    expect(new URL(SYNARA_MOBILE_APP_ORIGIN).origin).toBe(SYNARA_MOBILE_APP_ORIGIN);
  });

  it("builds prefixed mobile client build identifiers", () => {
    expect(SYNARA_MOBILE_CLIENT_BUILD_PREFIX).toBe("mobile-android");
    expect(mobileClientBuild("1.2.3")).toBe("mobile-android-1.2.3");
  });
});
