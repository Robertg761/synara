// FILE: useComputerControlReadiness.ts
// Purpose: Answer "is computer control set up right now?" for a chat, from live state,
//          and keep asking while it is not.
// Layer: Web data hook
// Exports: useComputerControlReadiness, COMPUTER_SETUP_RECHECK_INTERVAL_MS
// Depends on: computerStateStore (pushed thread state), computer.getThreadState
//
// The grant this waits for is given in a macOS dialog, outside Synara: the user
// clicks Allow and nothing in the app is pressed, so nothing would otherwise tell
// the setup card that its own reason for existing is gone. Hence the recheck.
//
// It costs nothing in a chat that never touched the desktop. The only source of
// truth is the thread state the server pushes, and a thread with no such state
// has never engaged a backend — so the query below stays disabled and this is a
// store read and nothing else. It also stops the moment the answer is "ready",
// which is the state a healthy machine is in permanently.

import type { ComputerPermission, ThreadId } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  computerControlReadiness,
  type ComputerControlReadiness,
} from "~/components/ComputerPanel.logic";
import { ensureNativeApi } from "~/nativeApi";
import { selectThreadComputerState, useComputerStateStore } from "../computerStateStore";

/**
 * Short enough that allowing the dialog and looking back at the chat shows the
 * card already changed, long enough that a desktop nobody is fixing is not
 * polled hard. Only ever runs while a grant is actually outstanding.
 */
export const COMPUTER_SETUP_RECHECK_INTERVAL_MS = 3_000;

export interface ComputerControlReadinessState {
  readonly readiness: ComputerControlReadiness;
  /**
   * The grants the desktop is currently missing, when it named them. Read from
   * the same live state as the readiness so the toast that says which permission
   * macOS is about to ask for cannot describe a different moment than the card.
   */
  readonly missing: readonly ComputerPermission[];
}

export function useComputerControlReadiness(threadId: ThreadId): ComputerControlReadinessState {
  const threadState = useComputerStateStore(selectThreadComputerState(threadId));
  const upsertThreadState = useComputerStateStore((store) => store.upsertThreadState);
  const readiness = computerControlReadiness(threadState);

  const recheck = useQuery({
    queryKey: ["computer", "threadState", threadId] as const,
    queryFn: () => ensureNativeApi().computer.getThreadState({ threadId }),
    // Never the thing that engages a backend: only a thread that already has
    // state, and only while that state says something is missing.
    enabled: readiness === "needs-setup",
    refetchInterval: COMPUTER_SETUP_RECHECK_INTERVAL_MS,
    staleTime: 0,
    gcTime: 0,
  });

  const recheckedState = recheck.data;
  useEffect(() => {
    // Into the same store the pushes land in, so there is one answer rather than
    // two that can disagree. The store is version-gated, so a reply that raced a
    // newer push is discarded rather than rolling it back.
    if (recheckedState) upsertThreadState(recheckedState);
  }, [recheckedState, upsertThreadState]);

  const availability = threadState?.availability;
  return {
    readiness,
    missing:
      availability?.kind === "permission-required" ? availability.missing : EMPTY_PERMISSIONS,
  };
}

/** Stable identity so the toast copy this feeds is not rebuilt every render. */
const EMPTY_PERMISSIONS: readonly ComputerPermission[] = [];
