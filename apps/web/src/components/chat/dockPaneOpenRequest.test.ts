import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { routeSingleDockPaneOpenRequest } from "./dockPaneOpenRequest";

const CURRENT_THREAD_ID = ThreadId.makeUnsafe("thread-current");
const REQUESTED_THREAD_ID = ThreadId.makeUnsafe("thread-requested");

describe("routeSingleDockPaneOpenRequest", () => {
  it("opens the current thread's pane without navigating", () => {
    const calls: string[] = [];
    const navigateToThread = vi.fn();

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: CURRENT_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: (threadId) => calls.push(`open:${threadId}`),
      navigateToThread,
    });

    expect(calls).toEqual(["hydrate", `open:${CURRENT_THREAD_ID}`]);
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("seeds the requested thread's dock before navigating to it", () => {
    // Seeding first means the pane is already there when the route mounts, so
    // arriving on the thread does not flash an empty dock.
    const calls: string[] = [];

    routeSingleDockPaneOpenRequest({
      currentThreadId: CURRENT_THREAD_ID,
      requestedThreadId: REQUESTED_THREAD_ID,
      requestImmediateHydration: () => calls.push("hydrate"),
      openPane: (threadId) => calls.push(`open:${threadId}`),
      navigateToThread: (threadId) => calls.push(`navigate:${threadId}`),
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
      navigateToThread: () => calls.push("navigate"),
    });

    expect(calls[0]).toBe("hydrate");
  });
});
