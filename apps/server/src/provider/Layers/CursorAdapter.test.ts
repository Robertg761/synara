// FILE: CursorAdapter.test.ts
// Purpose: Characterizes Cursor's private Synara host-policy delivery.
// Layer: Provider adapter tests

import {
  HARNESS_APPROVAL_CONSENT_CLAUSE,
  HARNESS_FULL_ACCESS_CONSENT_CLAUSE,
  SYNARA_HARNESS_POLICY_MARKER,
} from "../../agentGateway/harnessPolicy.ts";
import { describe, expect, it } from "vitest";

import { takeCursorSynaraHarnessPolicyTextPart } from "./CursorAdapter.ts";

describe("Cursor Synara harness policy", () => {
  it("delivers scoped MCP host context exactly once per fresh/load/fork session", () => {
    for (const lifecycle of ["fresh", "load", "fork"] as const) {
      const state: { harnessPolicyDelivered?: boolean } = {};
      const first = takeCursorSynaraHarnessPolicyTextPart(state, {
        scopedGatewayConnectionAvailable: true,
      });
      expect(first?.text, lifecycle).toContain(SYNARA_HARNESS_POLICY_MARKER);
      expect(first?.text, lifecycle).toContain("Use the synara_* tools");
      expect(
        takeCursorSynaraHarnessPolicyTextPart(state, { scopedGatewayConnectionAvailable: true }),
        lifecycle,
      ).toBeNull();
    }
  });

  it("stays truthful without a scoped gateway connection", () => {
    expect(
      takeCursorSynaraHarnessPolicyTextPart({}, { scopedGatewayConnectionAvailable: false })?.text,
    ).toContain("Synara MCP control is unavailable");
  });

  it("names the session's own runtime mode in the desktop-consent sentence", () => {
    expect(
      takeCursorSynaraHarnessPolicyTextPart(
        {},
        { scopedGatewayConnectionAvailable: true, runtimeMode: "full-access" },
      )?.text,
    ).toContain(HARNESS_FULL_ACCESS_CONSENT_CLAUSE);
    expect(
      takeCursorSynaraHarnessPolicyTextPart(
        {},
        { scopedGatewayConnectionAvailable: true, runtimeMode: "approval-required" },
      )?.text,
    ).toContain(HARNESS_APPROVAL_CONSENT_CLAUSE);
  });
});
