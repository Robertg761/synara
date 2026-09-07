// FILE: toastRouteVisibility.ts
// Purpose: Keeps thread-scoped toasts visible for every thread currently rendered in the route.
// Layer: UI helpers
// Exports: visible-thread resolver shared by toast containers and split-aware tests

import type { ThreadId } from "@synara/contracts";
import { resolveSplitViewThreadIds, type SplitView } from "../../splitViewStore";
import {
  resolveVisibleDockPane,
  type DockVisibility,
  type RightDockThreadState,
} from "../../rightDockStore.logic";

export function resolveVisibleToastThreadIds(input: {
  activeThreadId: ThreadId | null;
  splitView: SplitView | null;
  // Which dock pane (if any) is on screen. On desktop that is the dock's active
  // pane; on phone it is the `?pane=` full-screen pane. Both cases come from
  // `resolveDockVisibility` so this never re-derives on-screen-ness itself.
  dockVisibility: DockVisibility;
  rightDockState?: RightDockThreadState | null;
}): ReadonlySet<ThreadId> {
  const visibleThreadIds = input.splitView
    ? new Set(resolveSplitViewThreadIds(input.splitView))
    : input.activeThreadId
      ? new Set([input.activeThreadId])
      : new Set<ThreadId>();

  if (!input.splitView) {
    const visiblePane = resolveVisibleDockPane(input.dockVisibility, input.rightDockState);
    if (visiblePane?.kind === "sidechat" && visiblePane.threadId) {
      visibleThreadIds.add(visiblePane.threadId);
    }
  }

  return visibleThreadIds;
}

export function shouldRenderToastForVisibleThreads(input: {
  allowCrossThreadVisibility?: boolean | undefined;
  toastThreadId?: ThreadId | null | undefined;
  visibleThreadIds: ReadonlySet<ThreadId>;
}): boolean {
  if (input.allowCrossThreadVisibility) {
    return true;
  }
  const toastThreadId = input.toastThreadId;
  if (!toastThreadId) {
    return true;
  }
  return input.visibleThreadIds.has(toastThreadId);
}
