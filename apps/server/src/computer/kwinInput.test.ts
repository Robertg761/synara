import { describe, expect, it } from "vitest";

import {
  EVDEV_KEY_CODES,
  GLIDE_FRAME_INTERVAL_MS,
  keyStrokeForKey,
  pointerGlideSteps,
} from "./kwinInput.ts";

describe("keyStrokeForKey", () => {
  it("maps literal and named space keys", () => {
    expect(keyStrokeForKey(" ")).toEqual({ code: EVDEV_KEY_CODES.Space, shift: false });
    expect(keyStrokeForKey("space")).toEqual({ code: EVDEV_KEY_CODES.Space, shift: false });
    expect(keyStrokeForKey("spacebar")).toEqual({ code: EVDEV_KEY_CODES.Space, shift: false });
  });

  it("keeps function keys on the named-key path", () => {
    expect(keyStrokeForKey("F12")).toEqual({ code: EVDEV_KEY_CODES.F12, shift: false });
  });
});

describe("pointerGlideSteps", () => {
  const origin = { x: 0, y: 0 };

  it("schedules the last sample at the requested duration with even spacing", () => {
    const steps = pointerGlideSteps(origin, { x: 200, y: 0 }, 1_500);
    const offsets = steps.map((step) => step.offsetMs);

    expect(offsets.at(-1)).toBeCloseTo(1_500, 6);
    // The gaps are what a paced caller actually waits, so they must add up to
    // the requested duration rather than to steps x a fixed sleep.
    const gaps = offsets.map((offset, index) => offset - (offsets[index - 1] ?? 0));
    expect(gaps.reduce((total, gap) => total + gap, 0)).toBeCloseTo(1_500, 6);
    expect(Math.min(...gaps)).toBeGreaterThan(0);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(GLIDE_FRAME_INTERVAL_MS);
  });

  it("keeps every sample gap inside one frame interval for a long duration", () => {
    // A 1500ms drag used to be sampled at 40ms and then walked with fixed 8ms
    // sleeps, so it ran in a fraction of the duration it asked for.
    const steps = pointerGlideSteps(origin, { x: 10, y: 10 }, 1_500);
    expect(steps.length).toBeGreaterThanOrEqual(Math.ceil(1_500 / GLIDE_FRAME_INTERVAL_MS));
    for (const step of steps) expect(step.offsetMs).toBeLessThanOrEqual(1_500);
  });

  it("keeps the smoothstep easing", () => {
    const steps = pointerGlideSteps(origin, { x: 100, y: 200 }, 0, 4);

    expect(steps).toEqual([
      { point: { x: 15.625, y: 31.25 }, offsetMs: 0 },
      { point: { x: 50, y: 100 }, offsetMs: 0 },
      { point: { x: 84.375, y: 168.75 }, offsetMs: 0 },
      { point: { x: 100, y: 200 }, offsetMs: 0 },
    ]);
  });

  it("keeps the distance minimum so a fast glide over a long path stays smooth", () => {
    const steps = pointerGlideSteps(origin, { x: 800, y: 0 }, 0);

    expect(steps.length).toBeGreaterThanOrEqual(10);
    expect(steps.every((step) => step.offsetMs === 0)).toBe(true);
    expect(steps.at(-1)?.point).toEqual({ x: 800, y: 0 });
  });

  it("treats a negative or non-finite duration as immediate", () => {
    for (const duration of [-1_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const steps = pointerGlideSteps(origin, { x: 40, y: 0 }, duration);
      expect(steps).toHaveLength(2);
      expect(steps.every((step) => step.offsetMs === 0)).toBe(true);
    }
  });
});
