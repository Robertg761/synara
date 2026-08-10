// FILE: usePhonePaneRoute.browser.tsx
// Purpose: Behavioural regressions for the phone `?pane=` <-> right-dock sync, driven through a
//          real router (memory history) and the real zustand dock store — the layer where every
//          previously shipped defect lived (dead sync after a stacked close, misclassified
//          in-flight store changes, a persisted desktop dock dismissed on mount).
// Layer: Phone layout browser test
// Depends on: @tanstack/react-router (a minimal `/$threadId` route tree), rightDockStore.

import { ThreadId } from "@synara/contracts";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useMemo } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { selectRightDockState, useRightDockStore } from "~/rightDockStore";
import type {
  RightDockPane,
  RightDockPaneKind,
  RightDockThreadState,
} from "~/rightDockStore.logic";
import { usePhonePaneRouteSync } from "./usePhonePaneRoute";

const THREAD_ID = ThreadId.makeUnsafe("thread-phone-pane");
const THREAD_PATH = `/${THREAD_ID}`;
/** Long enough for any pending navigation/effect chain to settle and start oscillating. */
const SETTLE_MS = 120;

interface ThreadRouteSearch {
  pane?: string | undefined;
}

function createPane(id: string, kind: RightDockPaneKind): RightDockPane {
  return {
    id,
    kind,
    threadId: null,
    diffTurnId: null,
    diffFilePath: null,
    filePath: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    pullRequestNumber: null,
    pullRequestInitialTab: null,
  };
}

const EXPLORER_PANE = createPane("explorer", "explorer");

/** Armed by the in-flight test so a store change can land *during* one of our navigations. */
let onThreadRouteBeforeLoad: ((search: ThreadRouteSearch) => void) | null = null;

function PhonePaneRouteHarness() {
  const urlPaneId = useRouterState({
    select: (state) => (state.location.search as ThreadRouteSearch).pane ?? null,
  });
  const dockState = useRightDockStore(useMemo(() => selectRightDockState(THREAD_ID), []));
  usePhonePaneRouteSync({ enabled: true, threadId: THREAD_ID, urlPaneId, dockState });
  // Exactly the rule the surface uses: the screen shows iff the URL names a live pane.
  const shownPaneId =
    urlPaneId !== null && dockState.panes.some((pane) => pane.id === urlPaneId) ? urlPaneId : "";
  return <div data-testid="phone-pane-screen">{shownPaneId}</div>;
}

const rootRoute = createRootRoute({ component: () => <Outlet /> });
const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$threadId",
  validateSearch: (search: Record<string, unknown>): ThreadRouteSearch =>
    typeof search.pane === "string" && search.pane.length > 0 ? { pane: search.pane } : {},
  beforeLoad: ({ search }) => {
    onThreadRouteBeforeLoad?.(search);
  },
  component: PhonePaneRouteHarness,
});
const routeTree = rootRoute.addChildren([threadRoute]);

function dockThreadState(): RightDockThreadState | null {
  return useRightDockStore.getState().dockStateByThreadId[THREAD_ID] ?? null;
}

function seedDockState(state: RightDockThreadState): void {
  useRightDockStore.setState({ dockStateByThreadId: { [THREAD_ID]: state } });
}

function shownPaneId(): string {
  return document.querySelector('[data-testid="phone-pane-screen"]')?.textContent ?? "";
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

let mounted: { unmount: () => Promise<void> | void } | null = null;

async function mountRoute(href: string) {
  const history = createMemoryHistory({ initialEntries: [href] });
  const router = createRouter({ routeTree, history });
  const screen = await render(<RouterProvider router={router} />);
  mounted = screen;
  await expect.element(screen.getByTestId("phone-pane-screen")).toBeInTheDocument();
  return {
    history,
    paneParam: () => (router.state.location.search as ThreadRouteSearch).pane ?? null,
    historyIndex: () => history.location.state.__TSR_index,
  };
}

describe("usePhonePaneRouteSync", () => {
  afterEach(async () => {
    onThreadRouteBeforeLoad = null;
    if (mounted) {
      await mounted.unmount();
      mounted = null;
    }
    useRightDockStore.setState({ dockStateByThreadId: {} });
  });

  it("adopts a cold-loaded pane param and closes it by replacing, never popping", async () => {
    seedDockState({ open: false, panes: [EXPLORER_PANE], activePaneId: "explorer" });
    const route = await mountRoute(`${THREAD_PATH}?pane=explorer`);

    // The URL is visibility: the screen shows before the store has caught up, and the store is
    // then converged so the shared pane renderer's open/active gating holds.
    await expect.poll(() => dockThreadState()?.open).toBe(true);
    expect(dockThreadState()?.activePaneId).toBe("explorer");
    expect(shownPaneId()).toBe("explorer");
    expect(route.historyIndex()).toBe(0);
    expect(route.history.length).toBe(1);

    // Closing an entry we never pushed (cold load / reload) must replace it: popping would back
    // the user out of the app.
    useRightDockStore.getState().closePane(THREAD_ID, "explorer");
    await expect.poll(() => route.paneParam()).toBe(null);
    await settle();
    expect(shownPaneId()).toBe("");
    expect(route.historyIndex()).toBe(0);
    expect(route.history.length).toBe(1);
  });

  it("leaves a persisted open dock alone when the URL names no pane", async () => {
    // The desktop-window-narrowed case: mounting the phone sync must never persist a close.
    seedDockState({ open: true, panes: [EXPLORER_PANE], activePaneId: "explorer" });
    const route = await mountRoute(THREAD_PATH);

    await settle();
    expect(dockThreadState()).toEqual({
      open: true,
      panes: [EXPLORER_PANE],
      activePaneId: "explorer",
    });
    expect(shownPaneId()).toBe("");
    expect(route.paneParam()).toBe(null);
    expect(route.history.length).toBe(1);
  });

  it("replaces a stale pane param without touching the store", async () => {
    seedDockState({ open: true, panes: [EXPLORER_PANE], activePaneId: "explorer" });
    const route = await mountRoute(`${THREAD_PATH}?pane=does-not-exist`);

    await expect.poll(() => route.paneParam()).toBe(null);
    await settle();
    expect(dockThreadState()).toEqual({
      open: true,
      panes: [EXPLORER_PANE],
      activePaneId: "explorer",
    });
    expect(shownPaneId()).toBe("");
    expect(route.historyIndex()).toBe(0);
    expect(route.history.length).toBe(1);
  });

  it("pushes a store-driven open, dismisses on back, and re-adopts on forward", async () => {
    seedDockState({ open: false, panes: [], activePaneId: null });
    const route = await mountRoute(THREAD_PATH);

    useRightDockStore.getState().openPane(THREAD_ID, { kind: "terminal", paneId: "terminal" });
    await expect.poll(() => route.paneParam()).toBe("terminal");
    expect(route.historyIndex()).toBe(1);
    expect(shownPaneId()).toBe("terminal");

    route.history.back();
    await expect.poll(() => route.paneParam()).toBe(null);
    // Non-destructive: the pane survives as a tab, only the dock collapses.
    await expect.poll(() => dockThreadState()?.open).toBe(false);
    expect(dockThreadState()?.panes).toHaveLength(1);
    expect(shownPaneId()).toBe("");

    route.history.forward();
    await expect.poll(() => route.paneParam()).toBe("terminal");
    await expect.poll(() => dockThreadState()?.open).toBe(true);
    expect(shownPaneId()).toBe("terminal");
  });

  it("pushes again when the same pane is re-opened after a back dismiss", async () => {
    seedDockState({ open: false, panes: [], activePaneId: null });
    const route = await mountRoute(THREAD_PATH);

    useRightDockStore.getState().openPane(THREAD_ID, { kind: "terminal", paneId: "terminal" });
    await expect.poll(() => route.paneParam()).toBe("terminal");

    route.history.back();
    await expect.poll(() => dockThreadState()?.open).toBe(false);

    // Collapsing (rather than deleting) the pane on back is what makes this a fresh
    // "closed -> open" store transition instead of an unobservable no-op.
    useRightDockStore.getState().openPane(THREAD_ID, { kind: "terminal", paneId: "terminal" });
    await expect.poll(() => route.paneParam()).toBe("terminal");
    expect(route.historyIndex()).toBe(1);
    expect(shownPaneId()).toBe("terminal");
  });

  it("recovers after closing a stacked pane instead of wedging on the entry below", async () => {
    seedDockState({ open: false, panes: [], activePaneId: null });
    const route = await mountRoute(THREAD_PATH);

    useRightDockStore.getState().openPane(THREAD_ID, { kind: "explorer", paneId: "explorer" });
    await expect.poll(() => route.paneParam()).toBe("explorer");

    useRightDockStore
      .getState()
      .openPane(THREAD_ID, { kind: "file", paneId: "file-1", filePath: "a.ts" });
    await expect.poll(() => route.paneParam()).toBe("file-1");
    expect(route.historyIndex()).toBe(2);

    // X on the stacked pane pops back onto ?pane=explorer, which must simply be adopted.
    useRightDockStore.getState().closePane(THREAD_ID, "file-1");
    await expect.poll(() => route.paneParam()).toBe("explorer");
    await settle();
    expect(route.paneParam()).toBe("explorer");
    expect(route.historyIndex()).toBe(1);
    expect(shownPaneId()).toBe("explorer");
    expect(dockThreadState()?.open).toBe(true);
    expect(dockThreadState()?.activePaneId).toBe("explorer");

    // ...and the sync is still alive: the next pane still gets its own entry.
    useRightDockStore
      .getState()
      .openPane(THREAD_ID, { kind: "file", paneId: "file-2", filePath: "b.ts" });
    await expect.poll(() => route.paneParam()).toBe("file-2");
    expect(route.historyIndex()).toBe(2);
    expect(shownPaneId()).toBe("file-2");
  });

  it("keeps a store switch that lands while one of our navigations is in flight", async () => {
    seedDockState({ open: false, panes: [], activePaneId: null });
    const route = await mountRoute(THREAD_PATH);

    onThreadRouteBeforeLoad = (search) => {
      if (search.pane !== "pane-b") {
        return;
      }
      onThreadRouteBeforeLoad = null;
      useRightDockStore.getState().openPane(THREAD_ID, { kind: "git", paneId: "pane-c" });
    };

    useRightDockStore.getState().openPane(THREAD_ID, { kind: "terminal", paneId: "pane-b" });

    // The switch must not be dropped (it would leave pane-c unreachable) nor revert the store
    // back to pane-b: the pass after the navigation lands re-derives and pushes pane-c.
    await expect.poll(() => route.paneParam()).toBe("pane-c");
    await settle();
    expect(route.paneParam()).toBe("pane-c");
    expect(shownPaneId()).toBe("pane-c");
    expect(dockThreadState()?.open).toBe(true);
    expect(dockThreadState()?.activePaneId).toBe("pane-c");
  });

  it("does not grow the history stack across open/close cycles", async () => {
    seedDockState({ open: false, panes: [], activePaneId: null });
    const route = await mountRoute(THREAD_PATH);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      useRightDockStore.getState().openPane(THREAD_ID, { kind: "terminal", paneId: "terminal" });
      await expect.poll(() => route.paneParam()).toBe("terminal");
      expect(route.historyIndex()).toBe(1);

      useRightDockStore.getState().closePane(THREAD_ID, "terminal");
      await expect.poll(() => route.paneParam()).toBe(null);
      expect(route.historyIndex()).toBe(0);
    }

    expect(route.history.length).toBe(2);
  });
});
