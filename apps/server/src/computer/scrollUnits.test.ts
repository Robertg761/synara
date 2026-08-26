import { describe, expect, it } from "vitest";

import { SCROLL_STEP_PX, takeDiscreteSteps } from "./scrollUnits.ts";

/**
 * The invariant these pins buy: one scroll means one thing on every desktop.
 * KWin converts pixels at the plugin boundary (value120), the wlroots helper
 * converts them in C (`take_discrete_steps` in wayland.c, same algorithm), and
 * GNOME's portal wire converts here. All three share SCROLL_STEP_PX = 15 and
 * the truncate-and-carry semantics asserted below.
 */
describe("takeDiscreteSteps", () => {
  it("converts exact multiples of a notch exactly", () => {
    // The deltaY:-600 case that once became 600 discrete steps.
    expect(takeDiscreteSteps(0, -600)).toEqual({ steps: -40, remainder: 0 });
  });

  it("truncates a sub-notch delta to zero steps and carries the dust", () => {
    const first = takeDiscreteSteps(0, 10);
    expect(first).toEqual({ steps: 0, remainder: 10 });
    const second = takeDiscreteSteps(first.remainder, 10);
    expect(second).toEqual({ steps: 1, remainder: 5 });
  });

  it("truncates toward zero in both directions", () => {
    expect(takeDiscreteSteps(0, 14)).toEqual({ steps: 0, remainder: 14 });
    expect(takeDiscreteSteps(0, -14)).toEqual({ steps: 0, remainder: -14 });
  });

  it("carries negative remainders the same way", () => {
    let total = 0;
    let remainder = 0;
    for (let index = 0; index < 6; index += 1) {
      const step = takeDiscreteSteps(remainder, -4);
      total += step.steps;
      remainder = step.remainder;
    }
    // Six 4 px upward nudges cross one notch line (at the fourth, -16 px)
    // and stop with 9 px of dust owed — nothing invented either way.
    expect(total).toBe(-1);
    expect(remainder).toBe(-9);
  });

  it("ignores non-finite deltas instead of poisoning the accumulator", () => {
    expect(takeDiscreteSteps(3, Number.NaN)).toEqual({ steps: 0, remainder: 3 });
    expect(takeDiscreteSteps(3, Number.POSITIVE_INFINITY)).toEqual({
      steps: 0,
      remainder: 3,
    });
  });

  it("keeps the notch size the two native implementations document", () => {
    expect(SCROLL_STEP_PX).toBe(15);
  });
});
