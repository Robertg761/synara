import type { ThreadId } from "@synara/contracts";

import { findLeafPaneById } from "../../splitView.logic";
import type { PaneId, SplitView } from "../../splitViewStore";

// The single-pane browser open request routes through
// `routeSingleDockPaneOpenRequest` (dockPaneOpenRequest.ts) with the `refuse`
// cross-thread policy; only the split-view variant is browser-specific.

interface SplitBrowserPanelOpenRequestInput {
  readonly splitView: SplitView;
  readonly requestedThreadId: ThreadId;
  readonly openBrowserPanel: (paneId: PaneId) => void;
}

export function routeSplitBrowserPanelOpenRequest(input: SplitBrowserPanelOpenRequestInput): void {
  const focusedPane = findLeafPaneById(input.splitView.root, input.splitView.focusedPaneId);
  if (!focusedPane || focusedPane.threadId !== input.requestedThreadId) {
    return;
  }

  input.openBrowserPanel(focusedPane.id);
}
