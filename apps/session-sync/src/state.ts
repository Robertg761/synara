// FILE: state.ts
// Purpose: Crash-safe JSON state store so every external session is handled exactly once.
// Layer: Session-sync persistence

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { DiscoveredSession, SessionStateEntry, SessionSyncState } from "./types.ts";

export function emptySessionSyncState(): SessionSyncState {
  return { version: 1, sessions: {} };
}

export function loadSessionSyncState(path: string): SessionSyncState {
  if (!existsSync(path)) return emptySessionSyncState();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      (parsed as { version?: unknown }).version === 1 &&
      typeof (parsed as { sessions?: unknown }).sessions === "object" &&
      (parsed as { sessions?: unknown }).sessions !== null
    ) {
      return parsed as SessionSyncState;
    }
  } catch {
    // A torn or corrupt file falls back to empty; baseline rules then apply,
    // which is the conservative outcome (no surprise imports).
  }
  return emptySessionSyncState();
}

export function persistSessionSyncState(path: string, state: SessionSyncState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

export function sessionKey(session: DiscoveredSession): string {
  return `${session.provider}:${session.externalId}`;
}

export type DecideOutcome =
  | { readonly action: "skip-seen" }
  | { readonly action: "defer-quiet" }
  | { readonly action: "import" };

/**
 * Single decision point for whether a discovered session still needs work.
 * Already-imported sessions whose files keep growing only log once through the
 * `staleImported` flag at the call site; they never re-import.
 */
export function decideSessionAction(
  state: SessionSyncState,
  session: DiscoveredSession,
  nowMs: number,
  quietPeriodMs: number,
): DecideOutcome {
  const entry: SessionStateEntry | undefined = state.sessions[sessionKey(session)];
  if (entry) return { action: "skip-seen" };
  if (nowMs - session.updatedAtMs < quietPeriodMs) return { action: "defer-quiet" };
  return { action: "import" };
}
