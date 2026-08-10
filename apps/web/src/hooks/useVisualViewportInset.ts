// FILE: useVisualViewportInset.ts
// Purpose: Publish the virtual-keyboard inset as a CSS variable so phone layouts can
//          keep composers and action bars above the on-screen keyboard.
// Layer: Web shell viewport hook
// Exports: APP_KEYBOARD_INSET_CSS_VAR, computeViewportInset, useVisualViewportInset

import { useEffect } from "react";

/** Set on `<html>`; `0px` whenever no keyboard/browser UI overlaps the layout viewport. */
export const APP_KEYBOARD_INSET_CSS_VAR = "--app-keyboard-inset";

/**
 * Pure helper: how much of the layout viewport is currently covered from the bottom.
 *
 * `window.innerHeight` stays at the layout viewport height while the visual
 * viewport shrinks (and scrolls) when the on-screen keyboard opens, so the
 * leftover space below the visual viewport is the keyboard inset. Clamped at 0
 * because pinch-zoom and rubber-band scrolling can make the visual viewport
 * report more height than the layout viewport.
 */
export function computeViewportInset(input: {
  innerHeight: number;
  viewportHeight: number;
  viewportOffsetTop: number;
}): number {
  return Math.max(0, input.innerHeight - (input.viewportHeight + input.viewportOffsetTop));
}

/**
 * Keeps {@link APP_KEYBOARD_INSET_CSS_VAR} aligned with the visual viewport while
 * `enabled` (phone layout only — see `useLayoutModeEffects`).
 *
 * Viewport resize/scroll fire at input frequency while the keyboard animates, so
 * the write is coalesced into a single rAF callback and never routed through
 * React state; nothing here should re-render the app.
 */
export function useVisualViewportInset(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const viewport = window.visualViewport;
    if (!viewport) return;

    const rootStyle = document.documentElement.style;
    let frame: number | null = null;
    let writtenInset: number | null = null;

    const write = () => {
      frame = null;
      const inset = computeViewportInset({
        innerHeight: window.innerHeight,
        viewportHeight: viewport.height,
        viewportOffsetTop: viewport.offsetTop,
      });
      if (inset === writtenInset) return;
      writtenInset = inset;
      rootStyle.setProperty(APP_KEYBOARD_INSET_CSS_VAR, `${inset}px`);
    };

    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(write);
    };

    write();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      rootStyle.removeProperty(APP_KEYBOARD_INSET_CSS_VAR);
    };
  }, [enabled]);
}
