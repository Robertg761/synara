/**
 * Makes a session's renewability an explicit, persisted property instead of something
 * re-derived from `expires_at - issued_at` on every request.
 *
 * Backfill contract for rows issued before this column existed: the pre-migration rule was
 * "a session slides only if it was issued with the default 30-day TTL", so that rule is
 * replayed here, once, against the 30-day constant as it stood at migration time.
 * - Rows whose original lifetime was shorter than 30 days were deliberate short-lived
 *   credentials and become `fixed`; promoting them to a sliding 30-day session would hand out
 *   lifetime nobody asked for.
 * - Everything else becomes `sliding` (the column default), which preserves current behaviour
 *   for the default-TTL population. A row that had already slid forward reads as *longer* than
 *   30 days, so this deliberately classifies "at least the default TTL" as sliding rather than
 *   testing for equality, which would misfile every already-renewed session as fixed.
 *
 * After this migration the column is the only authority, and the TTL constant may change
 * without silently reclassifying already-issued sessions.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

// The default session TTL in days at the time this migration was written. Intentionally a
// literal: the backfill must reproduce the historic rule, not track the current constant.
const LEGACY_DEFAULT_SESSION_TTL_DAYS = 30;
// julianday() is a float, and the timestamps carry milliseconds; a tenth of a second of slack
// keeps an exactly-30-day row from tipping into `fixed` on representation error alone.
const TTL_COMPARISON_TOLERANCE_DAYS = 0.1 / 86_400;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (yield* columnExists(sql, "auth_sessions", "renewal_policy")) return;

  // Do not catch SqlError here. Only the already-present column is idempotent; locks,
  // read-only databases, and I/O failures must leave the migration pending so a later
  // startup retries instead of recording a schema change that never happened.
  yield* sql`
    ALTER TABLE auth_sessions
    ADD COLUMN renewal_policy TEXT NOT NULL DEFAULT 'sliding'
  `;

  yield* sql`
    UPDATE auth_sessions
    SET renewal_policy = 'fixed'
    WHERE julianday(expires_at) - julianday(issued_at)
      < ${LEGACY_DEFAULT_SESSION_TTL_DAYS - TTL_COMPARISON_TOLERANCE_DAYS}
  `;
});
