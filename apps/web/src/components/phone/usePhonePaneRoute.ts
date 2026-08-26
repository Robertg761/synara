// FILE: usePhonePaneRoute.ts
// Purpose: Drive the phone `?pane=` route param and the right-dock store into agreement, so a dock
//          pane on phone is a pushed screen that hardware/browser back closes.
// Layer: Phone layout route hook
// Exports: usePhonePaneRouteSync
// Depends on: phonePaneRoute.logic (pure decision), rightDockStore, and the router's history
//             (taken from the router, not the module-level app history, so the sync is testable
//             against a memory history and can never move a history the router does not own).

import type { ThreadId } from "@synara/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { goBackInAppHistory } from "../../appNavigation";
import { useRightDockStore } from "../../rightDockStore";
import { resolveActivePane, type RightDockThreadState } from "../../rightDockStore.logic";
import {
  NO_PREVIOUS_STORE_PANE,
  resolvePhonePaneSync,
  type PreviousStorePaneId,
} from "./phonePaneRoute.logic";

/**
 * A navigation this hook issued and is waiting to observe.
 *
 * While one is in flight every pass is skipped WITHOUT consuming the bookkeeping refs, so the
 * pass that finally runs re-derives everything from a fresh (URL, store, refs) snapshot. There
 * are deliberately no "the URL should now be X" assertions anywhere else: landing somewhere
 * unexpected (a pop that surfaces an older pane entry, a competing navigation) is then just an
 * ordinary pass instead of a state the sync cannot recover from.
 */
type PhonePaneNavigation =
  /** `push`/`replace`: settled once the URL carries exactly the pane we asked for. */
  | { readonly kind: "settle"; readonly targetUrlPaneId: string | null }
  /**
   * `back()`: we cannot know which entry we will land on, so it settles as soon as *anything*
   * we reconcile against moves. Including the store here bounds the wait: a pop that happens to
   * land on the same pane param can never wedge the sync.
   */
  | {
      readonly kind: "pop";
      readonly fromUrlPaneId: string | null;
      readonly fromStorePaneId: string | null;
    };

/**
 * Keeps `?pane=` and the dock store in sync while the phone layout is active.
 *
 * Visibility is the URL's job (see `phonePaneRoute.logic`); this hook only makes the store agree
 * with what the URL shows, gives store-driven opens their own history entry, and closes the
 * screen when the user goes back.
 *
 * Only ever runs when `enabled` is true (phone layout, chat surface — never the editor view,
 * which has no dock). Disabled or thread-switched, it drops all bookkeeping so the next pass is
 * a fresh mount: it will adopt a valid param and otherwise leave the store untouched.
 */
export function usePhonePaneRouteSync(input: {
  enabled: boolean;
  threadId: ThreadId;
  urlPaneId: string | null;
  dockState: RightDockThreadState;
}): void {
  const navigate = useNavigate();
  const router = useRouter();
  const setActivePane = useRightDockStore((store) => store.setActivePane);
  const setDockOpen = useRightDockStore((store) => store.setDockOpen);

  const previousStorePaneIdRef = useRef<PreviousStorePaneId>(NO_PREVIOUS_STORE_PANE);
  const lastShownPaneIdRef = useRef<string | null>(null);
  // Pane ids whose history entries this hook pushed, innermost last. Only the entry on top may
  // be popped; anything else is replaced, so a cold deep link or a reloaded page can never back
  // the user out of the app. Ownership survives nothing: a reload or a thread re-entry starts
  // with an empty stack.
  const pushedPaneStackRef = useRef<string[]>([]);
  const navigationRef = useRef<PhonePaneNavigation | null>(null);
  const syncedThreadIdRef = useRef<ThreadId | null>(null);

  const { enabled, threadId, urlPaneId, dockState } = input;
  const storePaneId = resolveActivePane(dockState)?.id ?? null;
  const urlPaneExists = urlPaneId !== null && dockState.panes.some((pane) => pane.id === urlPaneId);

  useEffect(() => {
    if (!enabled) {
      previousStorePaneIdRef.current = NO_PREVIOUS_STORE_PANE;
      lastShownPaneIdRef.current = null;
      pushedPaneStackRef.current = [];
      navigationRef.current = null;
      syncedThreadIdRef.current = null;
      return;
    }

    // A thread switch reuses this component and dock state is per thread: start the new thread
    // from scratch, which means the URL is adopted and the store is never mutated blind.
    if (syncedThreadIdRef.current !== threadId) {
      syncedThreadIdRef.current = threadId;
      previousStorePaneIdRef.current = NO_PREVIOUS_STORE_PANE;
      lastShownPaneIdRef.current = null;
      pushedPaneStackRef.current = [];
      navigationRef.current = null;
    }

    const inFlight = navigationRef.current;
    if (inFlight) {
      const settled =
        inFlight.kind === "pop"
          ? urlPaneId !== inFlight.fromUrlPaneId || storePaneId !== inFlight.fromStorePaneId
          : urlPaneId === inFlight.targetUrlPaneId;
      if (!settled) {
        // Deliberately no ref updates: this pass never happened.
        return;
      }
      navigationRef.current = null;
    }

    const previousStorePaneId = previousStorePaneIdRef.current;
    const lastShownPaneId = lastShownPaneIdRef.current;
    const action = resolvePhonePaneSync({
      urlPaneId,
      urlPaneExists,
      storePaneId,
      previousStorePaneId,
      lastShownPaneId,
    });
    previousStorePaneIdRef.current = storePaneId;
    // What the screen renders this pass is decided by the URL alone, so this is the record of
    // "the user could see pane X" that back-detection keys off.
    lastShownPaneIdRef.current = urlPaneExists ? urlPaneId : null;

    const runNavigation = (nextPaneId: string | undefined, replace: boolean) => {
      const issued = navigationRef.current;
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace,
        search: (previous) => ({ ...previous, pane: nextPaneId }),
      }).catch(() => {
        // A rejected navigation never lands, so releasing the gate here is what keeps a failed
        // push/replace from freezing the sync for the rest of the thread.
        if (navigationRef.current === issued) {
          navigationRef.current = null;
        }
      });
    };

    switch (action.kind) {
      case "none":
        return;
      case "adoptUrlPane": {
        const stack = pushedPaneStackRef.current;
        // We are standing on this pane's entry now (fresh mount, deep link, or a back/forward
        // that landed here), so ownership can only extend up to it.
        const ownedIndex = stack.lastIndexOf(action.paneId);
        stack.length = ownedIndex >= 0 ? ownedIndex + 1 : 0;
        // `setActivePane` is the atomic open+select (`setActivePaneInState` forces `open: true`),
        // so the dock pane renderer's `open`/`isActive` gating is satisfied in one store update
        // rather than through an intermediate state a concurrent pass could misread as a switch.
        setActivePane(threadId, action.paneId);
        setDockOpen(threadId, true);
        return;
      }
      case "dismissDock": {
        const stack = pushedPaneStackRef.current;
        if (stack[stack.length - 1] === lastShownPaneId) {
          stack.pop();
        }
        // Non-destructive: the pane stays a tab, so re-opening it registers as a store
        // transition and gets a new history entry.
        setDockOpen(threadId, false);
        return;
      }
      case "pushPaneParam":
        pushedPaneStackRef.current.push(action.paneId);
        navigationRef.current = { kind: "settle", targetUrlPaneId: action.paneId };
        runNavigation(action.paneId, false);
        return;
      case "clearPaneParam": {
        const stack = pushedPaneStackRef.current;
        const ownsCurrentEntry = urlPaneId !== null && stack[stack.length - 1] === urlPaneId;
        if (ownsCurrentEntry) {
          stack.pop();
        }
        if (action.reason === "closed" && ownsCurrentEntry && router.history.canGoBack()) {
          // Pop the entry we pushed instead of replacing it, so an open/close cycle leaves the
          // history stack exactly as deep as it found it.
          navigationRef.current = {
            kind: "pop",
            fromUrlPaneId: urlPaneId,
            fromStorePaneId: storePaneId,
          };
          goBackInAppHistory(router.history);
          return;
        }
        // Accepted consequence: ownership does not survive a reload or a thread re-entry, so
        // closing a pane we did not push replaces the entry instead. Back then returns to
        // whatever preceded it — which, if that was another pane URL, re-adopts that pane. That
        // is the correct trade: popping an entry we did not create could back the user out of
        // the app entirely.
        navigationRef.current = { kind: "settle", targetUrlPaneId: null };
        runNavigation(undefined, true);
        return;
      }
    }
  }, [
    enabled,
    navigate,
    router,
    setActivePane,
    setDockOpen,
    storePaneId,
    threadId,
    urlPaneExists,
    urlPaneId,
  ]);
}
