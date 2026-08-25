// FILE: types.ts
// Purpose: Shared shapes for provider session discovery and the sync pipeline.
// Layer: Session-sync domain

export type SyncProvider = "claudeAgent" | "codex";

export interface DiscoveredSession {
  readonly provider: SyncProvider;
  /** Provider-native session/thread identifier handed to orchestration.importThread. */
  readonly externalId: string;
  /** Working directory the session ran in; used to find or create the Synara project. */
  readonly cwd: string;
  readonly title: string | null;
  /** Last observed activity, used for quiet-period deferral. */
  readonly updatedAtMs: number;
}

/** Stable per-external-id record persisted across daemon restarts. */
export type SessionSyncStatus = "imported" | "baseline-skipped" | "failed";

export interface SessionStateEntry {
  readonly status: SessionSyncStatus;
  readonly threadId?: string;
  readonly error?: string;
  readonly updatedAt: string;
}

export interface SessionSyncState {
  readonly version: 1;
  readonly sessions: Record<string, SessionStateEntry>;
}
