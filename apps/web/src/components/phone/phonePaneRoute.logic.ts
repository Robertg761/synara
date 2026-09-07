// FILE: phonePaneRoute.logic.ts
// Purpose: Pure reconciliation between the phone `?pane=` route param and the right-dock store,
//          so a dock pane on phone behaves like a pushed screen with a real history entry.
// Layer: Phone layout route logic
// Exports: NO_PREVIOUS_STORE_PANE, PhonePaneSyncInput, PhonePaneSyncAction, resolvePhonePaneSync
// Depends on: nothing (deliberately React- and router-free so it stays unit-testable)

/**
 * The reconcile model, in one place:
 *
 * 1. The URL is the ONLY source of visibility. The phone pane screen shows iff `?pane=` names a
 *    pane that still exists; the store never decides what is on screen.
 * 2. Intent is read from STORE TRANSITIONS observed inside one hook lifetime
 *    (`previousStorePaneId` -> `storePaneId`), never from "did the URL change": our own
 *    navigations move the URL too, so URL movement cannot classify who acted.
 * 3. Back is detected from `lastShownPaneId` — the URL dropped a pane we were showing while the
 *    store still presents it. That is also what makes re-opening the same pane observable as a
 *    fresh `null -> paneId` store transition.
 * 4. The first pass of a lifetime (`previousStorePaneId === NO_PREVIOUS_STORE_PANE`) never
 *    mutates the store: it adopts a valid param, replaces a stale one, and leaves a persisted
 *    open dock completely alone when there is no param at all (so a desktop user who narrows
 *    the window below the phone breakpoint and widens it again keeps their dock).
 */

/** Sentinel for "no store snapshot has been consumed yet in this hook lifetime". */
export const NO_PREVIOUS_STORE_PANE = Symbol("phone-pane-no-previous-store");

export type PreviousStorePaneId = string | null | typeof NO_PREVIOUS_STORE_PANE;

export interface PhonePaneSyncInput {
  /** Pane id currently named by `?pane=` (already normalized by parseDiffRouteSearch). */
  readonly urlPaneId: string | null;
  /** Whether `urlPaneId` still names a pane that exists in the dock store for this thread. */
  readonly urlPaneExists: boolean;
  /**
   * Pane the store currently presents — `resolveActivePane(...)?.id ?? null`, which folds
   * "dock collapsed", "no active tab" and "active tab gone" into one null. Collapsing them is
   * deliberate: every store-side intent (open, switch, collapse, close) then shows up as a
   * change of this single value.
   */
  readonly storePaneId: string | null;
  /** Same value from the previous *consumed* pass. Skipped passes must not update it. */
  readonly previousStorePaneId: PreviousStorePaneId;
  /** Pane the phone screen was showing at the previous consumed pass (null = nothing shown). */
  readonly lastShownPaneId: string | null;
}

export type PhonePaneSyncAction =
  /** Already consistent. */
  | { readonly kind: "none" }
  /**
   * The URL names a live pane the store is not presenting: make the store agree (select the
   * pane, which also opens the dock) so the shared dock pane renderer's open/active gating is
   * satisfied for the pane the user is actually looking at.
   */
  | { readonly kind: "adoptUrlPane"; readonly paneId: string }
  /** The store opened or switched panes: give that pane its own history entry. */
  | { readonly kind: "pushPaneParam"; readonly paneId: string }
  /**
   * Remove `?pane=`. `stale` means the param never belonged to this screen (cold link, restored
   * URL, thread switch) and must be replaced in place. `closed` means the pane we were showing
   * went away, so the entry may be popped — but only if the caller knows it created it.
   */
  | { readonly kind: "clearPaneParam"; readonly reason: "stale" | "closed" }
  /**
   * The user pressed back off a pane screen: collapse the dock without destroying the pane, so
   * the tab survives for desktop and re-opening it is observable as a store transition.
   */
  | { readonly kind: "dismissDock" };

const NO_ACTION: PhonePaneSyncAction = { kind: "none" };

/** One step of URL <-> dock-store reconciliation for the phone pane screen. */
export function resolvePhonePaneSync(input: PhonePaneSyncInput): PhonePaneSyncAction {
  const { urlPaneId, urlPaneExists, storePaneId, previousStorePaneId, lastShownPaneId } = input;
  const storeTransitioned =
    previousStorePaneId !== NO_PREVIOUS_STORE_PANE && previousStorePaneId !== storePaneId;

  if (urlPaneId === null) {
    // The pane we were showing left the URL while the store still holds it: that can only be a
    // back navigation, because every clear we issue ourselves either removes the pane first or
    // collapses the dock first.
    if (lastShownPaneId !== null && storePaneId === lastShownPaneId) {
      return { kind: "dismissDock" };
    }
    // Store-driven open (`null -> paneId`) with nothing in the URL: give it a history entry.
    if (storeTransitioned && storePaneId !== null) {
      return { kind: "pushPaneParam", paneId: storePaneId };
    }
    return NO_ACTION;
  }

  if (!urlPaneExists) {
    // A param that resolves to nothing can never render. If it is the pane we were showing, the
    // user closed it (pop-able); otherwise it is a link/restore artifact (replace in place).
    return { kind: "clearPaneParam", reason: lastShownPaneId === urlPaneId ? "closed" : "stale" };
  }

  if (storeTransitioned && storePaneId !== null && storePaneId !== urlPaneId) {
    // Pane switch on top of a live pane screen: stack a new entry so back returns to the
    // previous pane rather than leaving it unreachable.
    return { kind: "pushPaneParam", paneId: storePaneId };
  }

  if (storeTransitioned && storePaneId === null && previousStorePaneId === urlPaneId) {
    // The dock collapsed under the pane we are showing (header toggle, programmatic close)
    // without removing the pane: treat it exactly like closing the screen.
    return { kind: "clearPaneParam", reason: "closed" };
  }

  if (storePaneId !== urlPaneId) {
    return { kind: "adoptUrlPane", paneId: urlPaneId };
  }

  return NO_ACTION;
}
