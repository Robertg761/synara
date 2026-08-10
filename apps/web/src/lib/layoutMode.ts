// FILE: layoutMode.ts
// Purpose: Resolve the app's viewport layout mode (phone vs desktop) and keep the
//          document in sync with it.
// Layer: Web shell layout primitive
// Exports: LayoutMode, resolveLayoutMode, applyLayoutModeDataset, useLayoutMode,
//          useLayoutModeEffects

import { useLayoutEffect } from "react";

import { useIsMobile } from "~/hooks/useMediaQuery";
import { useVisualViewportInset } from "~/hooks/useVisualViewportInset";

/**
 * Viewport-only layout axis, and one of three axes that stay deliberately
 * independent: viewport size ({@link useLayoutMode}), pointer coarseness
 * (`useIsCoarsePointer`), and shell platform (`isMobileShell` / `isElectron` /
 * `appRuntime` in `env.ts`). Never infer one from another — a narrow desktop
 * window is a phone layout, a touch laptop is not, and the mobile shell can be
 * running at any viewport size.
 */
export type LayoutMode = "phone" | "desktop";

/** Pure mapping from the phone-width media query result to a layout mode. */
export function resolveLayoutMode(isPhoneViewport: boolean): LayoutMode {
  return isPhoneViewport ? "phone" : "desktop";
}

/** Minimal structural view of `document.documentElement` so this stays unit-testable. */
type LayoutModeDatasetTarget = { dataset: { layout?: string } };

/** Publishes the layout mode as `<html data-layout="...">` for CSS and E2E selectors. */
export function applyLayoutModeDataset(target: LayoutModeDatasetTarget, mode: LayoutMode): void {
  target.dataset.layout = mode;
}

/**
 * Current layout mode. Backed by {@link useIsMobile} so the phone breakpoint has
 * exactly one definition (the `md` breakpoint in `useMediaQuery`), never a
 * second hard-coded pixel threshold.
 */
export function useLayoutMode(): LayoutMode {
  return resolveLayoutMode(useIsMobile());
}

/**
 * Global layout-mode side effects. Mount once near the app root (see `__root.tsx`):
 * keeps `<html data-layout>` current and, on phone layouts only, tracks the
 * virtual-keyboard inset.
 */
export function useLayoutModeEffects(): void {
  const layoutMode = useLayoutMode();

  // Layout effect so the first paint already carries the right layout attribute.
  useLayoutEffect(() => {
    applyLayoutModeDataset(document.documentElement, layoutMode);
  }, [layoutMode]);

  // Desktop windows never show a virtual keyboard, so the listeners stay off there.
  useVisualViewportInset(layoutMode === "phone");
}
