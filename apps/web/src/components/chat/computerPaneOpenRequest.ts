import type { ThreadId } from "@synara/contracts";

interface SingleComputerPaneOpenRequestInput {
  readonly currentThreadId: ThreadId;
  readonly requestedThreadId: ThreadId;
  readonly requestImmediateComputerHydration: () => void;
  readonly openComputerPane: (threadId: ThreadId) => void;
  readonly navigateToThread: (threadId: ThreadId) => void;
}

/**
 * Mirrors routeSingleDevicePaneOpenRequest. The event carries its own thread
 * so an agent driving the desktop from a background thread cannot yank the pane
 * away from whatever the user is currently reading — the dock is seeded there
 * and the route follows.
 */
export function routeSingleComputerPaneOpenRequest(
  input: SingleComputerPaneOpenRequestInput,
): void {
  // Agent-triggered opens must not wait for rAF, which Chromium suspends for
  // backgrounded windows.
  input.requestImmediateComputerHydration();

  if (input.requestedThreadId === input.currentThreadId) {
    input.openComputerPane(input.currentThreadId);
    return;
  }

  input.openComputerPane(input.requestedThreadId);
  input.navigateToThread(input.requestedThreadId);
}
