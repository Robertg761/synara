// FILE: dockPaneOpenRequest.ts
// Purpose: One routing rule for every agent-triggered "open my dock pane" request.
// Layer: Web chat surface logic
// Exports: routeSingleDockPaneOpenRequest, DockPaneCrossThreadPolicy
// Depends on: nothing (pure)

import type { ThreadId } from "@synara/contracts";

/**
 * What a pane does when the request names a thread other than the one on screen.
 *
 * - `refuse`: drop the request. The browser pane uses this — its native runtime
 *   stays alive without mounting the route, so there is nothing to gain by
 *   stealing the user's current chat merely to make the browser executable.
 *   Nothing runs, not even hydration.
 * - `navigate`: seed the requested thread's dock and route there. The device and
 *   computer panes use this — the event carries its own thread, so an agent
 *   driving a desktop from a background thread lands the user on the thread that
 *   is actually doing the work rather than showing nothing at all.
 */
export type DockPaneCrossThreadPolicy =
  | { readonly kind: "refuse" }
  | { readonly kind: "navigate"; readonly navigateToThread: (threadId: ThreadId) => void };

interface DockPaneOpenRequestInput {
  readonly currentThreadId: ThreadId;
  readonly requestedThreadId: ThreadId;
  /**
   * Agent-triggered opens must not wait for rAF, which Chromium/Electron
   * suspends for backgrounded windows.
   */
  readonly requestImmediateHydration: () => void;
  readonly openPane: (threadId: ThreadId) => void;
  readonly crossThread: DockPaneCrossThreadPolicy;
}

export function routeSingleDockPaneOpenRequest(input: DockPaneOpenRequestInput): void {
  if (input.requestedThreadId === input.currentThreadId) {
    input.requestImmediateHydration();
    input.openPane(input.currentThreadId);
    return;
  }

  const crossThread = input.crossThread;
  if (crossThread.kind === "refuse") {
    return;
  }

  input.requestImmediateHydration();
  input.openPane(input.requestedThreadId);
  crossThread.navigateToThread(input.requestedThreadId);
}
