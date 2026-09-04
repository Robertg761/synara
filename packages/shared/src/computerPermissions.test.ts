import { describe, expect, it } from "vitest";

import {
  computerPermissionSetupMessage,
  computerStaleGrantAdvice,
  listComputerPermissions,
  sortComputerPermissions,
} from "./computerPermissions";

describe("computer permission copy", () => {
  it("names grants in one fixed order whatever order they arrive in", () => {
    // Two surfaces describing the same state as "Screen Recording and
    // Accessibility" and "Accessibility and Screen Recording" is how this got
    // centralised in the first place.
    expect(sortComputerPermissions(["screenRecording", "accessibility"])).toEqual([
      "accessibility",
      "screenRecording",
    ]);
    expect(listComputerPermissions(["screenRecording", "accessibility"])).toBe(
      "Accessibility and Screen Recording",
    );
    expect(listComputerPermissions(["screenRecording"])).toBe("Screen Recording");
    expect(listComputerPermissions([])).toBe("");
  });

  it("explains a stale grant on an ad-hoc build, naming the right tccutil service", () => {
    const advice = computerStaleGrantAdvice(["accessibility", "screenRecording"], "adhoc");
    // The server clears the stale row itself before it asks, so the user's part
    // is a dialog; the command survives only for the case where none appears.
    expect(advice).toContain("allow the dialog when it appears");
    expect(advice).toContain("If none appears");
    expect(advice).toContain("tccutil reset Accessibility com.emanueledipietro.synara");
    // `ScreenCapture`, not "Screen Recording": the label is not the service name,
    // and a user who types the label gets an error instead of a reset.
    expect(advice).toContain("tccutil reset ScreenCapture com.emanueledipietro.synara");
  });

  it("says nothing about stale grants on a signed build", () => {
    expect(computerStaleGrantAdvice(["accessibility"], "signed")).toBeNull();
    const message = computerPermissionSetupMessage(["accessibility"], "signed");
    expect(message).toContain("Accessibility");
    expect(message).toContain("System Settings");
    expect(message).not.toContain("tccutil");
  });

  it("puts the stale-grant explanation into the ad-hoc setup message", () => {
    const message = computerPermissionSetupMessage(["accessibility"], "adhoc");
    expect(message).toContain("System Settings");
    expect(message).toContain("tccutil reset Accessibility");
  });
});
