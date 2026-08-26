// FILE: dockPaneOpenRequest.ts
// Purpose: One routing rule for every agent-triggered "open my dock pane" request.
// Layer: Web chat surface logic
// Exports: routeSingleDockPaneOpenRequest
// Depends on: nothing (pure)

import type { ThreadId } from "@synara/contracts";

interface DockPaneOpenRequestInput {
  readonly currentThreadId: ThreadId;
  readonly requestedThreadId: ThreadId;
  /**
   * Agent-triggered opens must not wait for rAF, which Chromium/Electron
   * suspends for backgrounded windows.
   */
  readonly requestImmediateHydration: () => void;
  readonly openPane: (threadId: ThreadId) => void;
  /**
   * Where to send the user when the request names some other thread. The event
   * carries its own thread, so an agent driving a desktop from a background
   * thread should land the user on the thread doing the work rather than show
   * nothing at all.
   */
  readonly navigateToThread: (threadId: ThreadId) => void;
}

export function routeSingleDockPaneOpenRequest(input: DockPaneOpenRequestInput): void {
  input.requestImmediateHydration();

  if (input.requestedThreadId === input.currentThreadId) {
    input.openPane(input.currentThreadId);
    return;
  }

  input.openPane(input.requestedThreadId);
  input.navigateToThread(input.requestedThreadId);
}
