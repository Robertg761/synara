// FILE: useComputerDesktopControl.ts
// Purpose: Whether an agent is driving this thread's desktop right now, steadily,
//          and how to stop it.
// Layer: Web state hook
// Exports: useSteadyComputerAgentActive, useComputerDesktopControl
// Depends on: computerStateStore (pushed thread state), threadTurnInterrupt
//
// Shared by the Computer pane header and the chat-level banner, which must agree
// down to the frame: two surfaces computing "is the agent acting" from the same
// flickering source, with two different debounces, would tell the user opposite
// things about their own machine.

import type { ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useState } from "react";

import { nextComputerAgentActiveState } from "~/components/ComputerPanel.logic";
import { interruptThreadTurn } from "~/lib/threadTurnInterrupt";
import { selectThreadComputerState, useComputerStateStore } from "../computerStateStore";

/**
 * `agentActive` with its falling edge held.
 *
 * The server reports `callsInFlight > 0`, and an agent working a screenshot loop
 * has a gap between every call — so anything keyed off it raw (a badge, a stop
 * button, a banner announcing that the machine is being driven) blinked several
 * times a second through a perfectly steady run. Rising edges are immediate,
 * because being told late that your desktop is being driven is the failure that
 * matters.
 */
export function useSteadyComputerAgentActive(reported: boolean): boolean {
  const [steady, setSteady] = useState(reported);
  useEffect(() => {
    const next = nextComputerAgentActiveState({ current: steady, reported });
    if (next.value !== steady) setSteady(next.value);
    if (next.scheduleClearAfterMs === null) return;
    const timer = setTimeout(() => setSteady(false), next.scheduleClearAfterMs);
    return () => clearTimeout(timer);
  }, [reported, steady]);
  return steady;
}

export interface ComputerDesktopControl {
  /** An agent is acting on this thread's desktop, debounced. */
  readonly agentActive: boolean;
  /** That desktop is the one the user is sitting at. */
  readonly visibleDesktop: boolean;
  /** Requested a stop that has not landed yet. */
  readonly stopRequested: boolean;
  readonly stop: () => void;
  /** Set when a stop was refused, so the surface can say why. */
  readonly stopError: string | null;
}

export function useComputerDesktopControl(threadId: ThreadId): ComputerDesktopControl {
  const threadState = useComputerStateStore(selectThreadComputerState(threadId));
  const agentActive = useSteadyComputerAgentActive(threadState?.agentActive ?? false);
  const [stopRequested, setStopRequested] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const stop = useCallback(() => {
    setStopRequested(true);
    setStopError(null);
    // The ordinary turn interrupt, not a computer-only kill path: ending the
    // turn is what releases the desktop lease
    // (`ComputerManager.releaseDesktopControl`), so a second mechanism could
    // only ever disagree with this one.
    void interruptThreadTurn(threadId).catch((error: unknown) => {
      setStopRequested(false);
      setStopError(
        error instanceof Error && error.message.length > 0
          ? error.message
          : "The stop request failed. Try again in a moment.",
      );
    });
  }, [threadId]);

  useEffect(() => {
    // Re-arm once the agent has actually stopped: a stop that did not take must
    // not leave the control dead for the rest of the conversation.
    if (!agentActive) {
      setStopRequested(false);
      setStopError(null);
    }
  }, [agentActive]);

  return {
    agentActive,
    visibleDesktop: threadState?.capabilities.visibleDesktop ?? false,
    stopRequested,
    stop,
    stopError,
  };
}
