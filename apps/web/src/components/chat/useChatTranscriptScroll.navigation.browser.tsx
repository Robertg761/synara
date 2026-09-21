import type { LegendListRef } from "@legendapp/list/react";
import { ThreadId } from "@synara/contracts";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { useChatTranscriptScroll } from "./useChatTranscriptScroll";

it.each([false, true])(
  "resumes follow on thread switches with streaming=%s before another layout notification",
  async (streaming) => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const viewport = document.createElement("div");
    // This tests scroll ownership and effect ordering, independent of list measurement.
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1_000 },
      clientHeight: { value: 200 },
      // Detached elements have no native scroll offset in Chromium. Model it
      // alongside the synthetic dimensions so this fixture stays layout-free.
      scrollTop: { value: 300, writable: true },
    });
    const scrollToEnd = vi.fn(() => {
      viewport.scrollTop = 800;
    });
    const listRef = {
      current: { getScrollableNode: () => viewport, scrollToEnd } as unknown as LegendListRef,
    };
    let controls: ReturnType<typeof useChatTranscriptScroll>;
    function Harness({ threadId }: { threadId: string }) {
      controls = useChatTranscriptScroll({
        activeThreadId: ThreadId.makeUnsafe(threadId),
        legendListRef: listRef,
        timelineEntries: [],
        hasStreamingAssistantText: streaming,
        composerTranscriptInsetPx: 0,
        isInactiveSplitPane: false,
      });
      return null;
    }
    const render = (threadId: string) =>
      flushSync(() => root.render(<Harness threadId={threadId} />));
    try {
      render("first");
      await vi.advanceTimersByTimeAsync(32);
      flushSync(() => controls.onTranscriptNavigate());
      viewport.scrollTop = 300;
      scrollToEnd.mockClear();
      render("first");
      await vi.advanceTimersByTimeAsync(32);
      expect(controls!.isUserScrollDetached).toBe(true);
      expect(scrollToEnd).not.toHaveBeenCalled();

      for (const threadId of ["second", "first"]) {
        render(threadId);
        await vi.advanceTimersByTimeAsync(32);
        expect(controls!.isUserScrollDetached).toBe(false);
        expect(scrollToEnd).toHaveBeenCalledTimes(1);
        expect(viewport.scrollTop).toBe(800);
        // Detach again so the return navigation must reset the old ownership too.
        flushSync(() => controls.onTranscriptNavigate());
        viewport.scrollTop = 300;
        scrollToEnd.mockClear();
      }
    } finally {
      flushSync(() => root.unmount());
      host.remove();
      vi.useRealTimers();
    }
  },
);

it("re-sticks to the end when rows measure taller after a thread switch", async () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const viewport = document.createElement("div");
  // A remounted list scrolls to its estimated end first; the tail then grows as
  // rows measure. Model both sizes without layout.
  let scrollHeight = 1_000;
  Object.defineProperties(viewport, {
    scrollHeight: { get: () => scrollHeight },
    clientHeight: { value: 200 },
    scrollTop: { value: 0, writable: true },
  });
  const scrollToEnd = vi.fn(() => {
    viewport.scrollTop = scrollHeight - 200;
  });
  const listRef = {
    current: { getScrollableNode: () => viewport, scrollToEnd } as unknown as LegendListRef,
  };
  function Harness({ threadId }: { threadId: string }) {
    useChatTranscriptScroll({
      activeThreadId: ThreadId.makeUnsafe(threadId),
      legendListRef: listRef,
      timelineEntries: [],
      hasStreamingAssistantText: true,
      composerTranscriptInsetPx: 0,
      isInactiveSplitPane: false,
    });
    return null;
  }
  const render = (threadId: string) =>
    flushSync(() => root.render(<Harness threadId={threadId} />));
  try {
    render("first");
    await vi.advanceTimersByTimeAsync(16);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(viewport.scrollTop).toBe(800);
    // Rows measure taller than the estimate right after the end scroll.
    scrollHeight = 1_300;
    await vi.advanceTimersByTimeAsync(64);
    expect(viewport.scrollTop).toBe(1_100);
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
    // Once the height is stable at the end, the follow stops re-scrolling.
    await vi.advanceTimersByTimeAsync(400);
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});
