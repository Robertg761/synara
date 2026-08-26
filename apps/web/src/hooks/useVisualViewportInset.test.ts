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

/**
 * The two-mechanism split this hook is one half of. Keeping both platforms in one place so a
 * "fix" for one is never made without looking at what it does to the other — the Android result
 * being 0 is the CORRECT answer there, not a hole to be plugged.
 */
describe("computeViewportInset across keyboard mechanisms", () => {
  /** Pixel-6-class metrics: 892px tall, ~340px of IME. */
  const ANDROID_LAYOUT_HEIGHT = 892;
  const ANDROID_KEYBOARD_HEIGHT = 340;
  /** iPhone-14-class metrics: 844px tall, ~336px of keyboard. */
  const IOS_LAYOUT_HEIGHT = 844;
  const IOS_KEYBOARD_HEIGHT = 336;

  it("reports no inset on Android, where the layout viewport shrinks with the keyboard", () => {
    // `interactive-widget=resizes-content` (index.html) is honoured by Chrome / Android WebView:
    // the layout viewport itself ends at the top of the keyboard, so `innerHeight` and
    // `visualViewport.height` shrink together and there is nothing left for this hook to add.
    // Publishing the keyboard height here would double-count it and push the composer up by a
    // second keyboard's worth of padding.
    const shrunk = ANDROID_LAYOUT_HEIGHT - ANDROID_KEYBOARD_HEIGHT;
    expect(
      computeViewportInset({ innerHeight: shrunk, viewportHeight: shrunk, viewportOffsetTop: 0 }),
    ).toBe(0);
  });

  it("reports the keyboard height on iOS, where only the visual viewport shrinks", () => {
    // iOS Safari / WKWebView ignore the `interactive-widget` descriptor, so the layout viewport
    // keeps its full height and this hook is the ONLY thing that knows a keyboard is up.
    expect(
      computeViewportInset({
        innerHeight: IOS_LAYOUT_HEIGHT,
        viewportHeight: IOS_LAYOUT_HEIGHT - IOS_KEYBOARD_HEIGHT,
        viewportOffsetTop: 0,
      }),
    ).toBe(IOS_KEYBOARD_HEIGHT);
  });

  it("reports no inset on either platform with the keyboard dismissed", () => {
    for (const innerHeight of [ANDROID_LAYOUT_HEIGHT, IOS_LAYOUT_HEIGHT]) {
      expect(
        computeViewportInset({ innerHeight, viewportHeight: innerHeight, viewportOffsetTop: 0 }),
      ).toBe(0);
    }
  });
});
