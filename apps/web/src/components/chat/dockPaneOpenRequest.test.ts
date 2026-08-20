import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { routeSingleDockPaneOpenRequest } from "./dockPaneOpenRequest";

const CURRENT_THREAD_ID = ThreadId.makeUnsafe("thread-current");
const REQUESTED_THREAD_ID = ThreadId.makeUnsafe("thread-requested");

describe("routeSingleDockPaneOpenRequest with the browser pane's refuse policy", () => {
  it("opens the current thread browser immediately without navigating", () => {
    const calls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: (threadId) => calls.push(`open:${threadId}`),
      crossThread: { kind: "refuse" },
    });

    expect(calls).toEqual(["hydrate", `open:${CURRENT_THREAD_ID}`]);
  });

  it("leaves the current chat untouched for a background thread request", () => {
    const calls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: (threadId) => calls.push(`open:${threadId}`),
      crossThread: { kind: "refuse" },
    });

    expect(calls).toEqual([]);
  });
});

describe("routeSingleDockPaneOpenRequest with the device/computer navigate policy", () => {
  it("opens the current thread pane immediately without navigating", () => {
    const calls: string[] = [];
    const navigateToThread = vi.fn();

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: (threadId) => calls.push(`open:${threadId}`),
      crossThread: { kind: "navigate", navigateToThread },
    });

    expect(calls).toEqual(["hydrate", `open:${CURRENT_THREAD_ID}`]);
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("seeds the requested thread's dock before navigating to it", () => {
    const calls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: (threadId) => calls.push(`open:${threadId}`),
      crossThread: {
        kind: "navigate",
        navigateToThread: (threadId) => calls.push(`navigate:${threadId}`),
      },
    });

    expect(calls).toEqual([
      "hydrate",
      `open:${REQUESTED_THREAD_ID}`,
      `navigate:${REQUESTED_THREAD_ID}`,
    ]);
  });

  it("hydrates before opening so an agent request never waits on a suspended frame", () => {
    const calls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: () => calls.push("open"),
      crossThread: { kind: "navigate", navigateToThread: () => calls.push("navigate") },
    });

    expect(calls[0]).toBe("hydrate");
  });
});

describe("cross-thread policy divergence", () => {
  // The browser pane refuses cross-thread opens on purpose: its runtime stays
  // alive without the route mounted, so following the request would steal the
  // user's chat for nothing. Device and computer panes have no such runtime, so
  // they follow the request. Both halves are behaviour, not an oversight.
  it("refuses everything for a background thread while navigate seeds and routes", () => {
    const refuseCalls: string[] = [];
    const navigateCalls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateHydration: () => refuseCalls.push("hydrate"),
      openPane: (threadId) => refuseCalls.push(`open:${threadId}`),
      crossThread: { kind: "refuse" },
    });
    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateHydration: () => navigateCalls.push("hydrate"),
      openPane: (threadId) => navigateCalls.push(`open:${threadId}`),
      crossThread: {
        kind: "navigate",
        navigateToThread: (threadId) => navigateCalls.push(`navigate:${threadId}`),
      },
    });

    // Refuse skips hydration too — a refused request must leave no trace.
    expect(refuseCalls).toEqual([]);
    expect(navigateCalls).toEqual([
      "hydrate",
      `open:${REQUESTED_THREAD_ID}`,
      `navigate:${REQUESTED_THREAD_ID}`,
    ]);
  });

  it("is identical for a same-thread request under either policy", () => {
    const refuseCalls: string[] = [];
    const navigateCalls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => refuseCalls.push("hydrate"),
      openPane: (threadId) => refuseCalls.push(`open:${threadId}`),
      crossThread: { kind: "refuse" },
    });
    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => navigateCalls.push("hydrate"),
      openPane: (threadId) => navigateCalls.push(`open:${threadId}`),
      crossThread: {
        kind: "navigate",
        navigateToThread: (threadId) => navigateCalls.push(`navigate:${threadId}`),
      },
    });

    expect(refuseCalls).toEqual(navigateCalls);
  });
});
