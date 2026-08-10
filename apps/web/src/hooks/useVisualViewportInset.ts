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
 * The leftover space below the visual viewport is the keyboard inset: `window.innerHeight` is the
 * layout viewport, `visualViewport.height`/`offsetTop` are the part of it the user can actually
 * see. Clamped at 0 because pinch-zoom and rubber-band scrolling can make the visual viewport
 * report more height than the layout viewport.
 *
 * Keeping composers above the on-screen keyboard is a TWO-mechanism job, and this hook is only
 * one of them — which is why a 0 result is a normal, correct outcome rather than a failure:
 *
 *  - Chrome / Android WebView honour `interactive-widget=resizes-content` (see `index.html`), so
 *    the *layout* viewport itself shrinks to the space above the keyboard. `innerHeight` shrinks
 *    with `visualViewport.height`, this returns 0, and nothing extra is needed: the app's `dvh`
 *    box already ends at the top of the keyboard.
 *  - iOS Safari / WKWebView ignore that descriptor: the layout viewport keeps its full height and
 *    only the visual viewport shrinks. `innerHeight - visualViewport.height` is then the keyboard
 *    height, and publishing it is what lifts the composer.
 *
 * The consumer (`pb-keyboard-safe`, `index.css`) resolves to
 * `max(env(safe-area-inset-bottom), var(--app-keyboard-inset))`, which is correct on both: on
 * Android the inset is 0 so the padding is the plain home-indicator inset (the keyboard is
 * already outside the layout viewport, so counting it again would be the bug); on iOS the
 * keyboard inset is larger than the home-indicator inset and subsumes it, because the keyboard
 * covers the home indicator. The two terms are alternatives, never a sum.
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
 * `enabled` (phone layout only — see `useLayoutModeEffects`). On platforms that resize the layout
 * viewport for the keyboard it publishes a steady `0px`; see {@link computeViewportInset}.
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
