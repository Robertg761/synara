import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Identity is the client-generated operation id alone: unlike migration 070
  // there is no caller thread/turn scope, because a mobile outbox item owns the
  // id across reconnects and process restarts.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_creation_operations (
      operation_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'reserved',
          'creating-worktree',
          'creating-thread',
          'starting-turn',
          'compensating',
          'blocked',
          'completed',
          'failed'
        )
      ),
      compensation_phase TEXT CHECK (
        compensation_phase IS NULL
        OR compensation_phase IN ('reverting-turn', 'removing-thread', 'removing-worktree')
      ),
      blocked_reason TEXT CHECK (
        blocked_reason IS NULL
        OR blocked_reason IN (
          'worktree-ownership-mismatch',
          'worktree-cleanup-failed',
          'thread-cleanup-failed',
          'manual-attention-required'
        )
      ),
      owned_resources_json TEXT,
      request_json TEXT NOT NULL,
      plan_json TEXT,
      result_json TEXT,
      error_json TEXT,
      compensation_completed INTEGER NOT NULL DEFAULT 0 CHECK (compensation_completed IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_creation_operations_status
    ON thread_creation_operations (status, updated_at)
  `;
});
