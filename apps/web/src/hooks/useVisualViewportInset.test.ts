// FILE: useVisualViewportInset.test.ts
// Purpose: Covers the pure keyboard-inset computation behind the phone layout CSS variable.
// Layer: Hook unit tests
// Depends on: computeViewportInset and Vitest assertions.

import { describe, expect, it } from "vitest";

import { computeViewportInset } from "./useVisualViewportInset";

describe("computeViewportInset", () => {
  it("reports no inset when the visual viewport fills the layout viewport", () => {
    expect(
      computeViewportInset({ innerHeight: 844, viewportHeight: 844, viewportOffsetTop: 0 }),
    ).toBe(0);
  });

  it("reports the space the on-screen keyboard takes from the bottom", () => {
    expect(
      computeViewportInset({ innerHeight: 844, viewportHeight: 508, viewportOffsetTop: 0 }),
    ).toBe(336);
  });

  it("accounts for a scrolled visual viewport", () => {
    expect(
      computeViewportInset({ innerHeight: 844, viewportHeight: 508, viewportOffsetTop: 120 }),
    ).toBe(216);
  });

  it("clamps to zero when the visual viewport overflows the layout viewport", () => {
    expect(
      computeViewportInset({ innerHeight: 844, viewportHeight: 900, viewportOffsetTop: 0 }),
    ).toBe(0);
    expect(
      computeViewportInset({ innerHeight: 844, viewportHeight: 700, viewportOffsetTop: 400 }),
    ).toBe(0);
  });

  it("keeps sub-pixel viewport heights intact", () => {
    expect(
      computeViewportInset({ innerHeight: 844, viewportHeight: 507.5, viewportOffsetTop: 0 }),
    ).toBe(336.5);
  });
});
