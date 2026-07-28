import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists, tableExists } from "./schemaHelpers.ts";

/**
 * Store pairing credentials as keyed digests and give both pairing links and
 * sessions an audience.
 *
 * `credential TEXT NOT NULL UNIQUE` cannot be renamed in place under SQLite's
 * ALTER support, so the pairing table is rebuilt. Legacy rows kept their raw
 * credential in the old column; their plaintext is dropped here and any row
 * that was still redeemable is revoked, because no digest can be derived for a
 * secret that must not survive the migration.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (yield* tableExists(sql, "auth_pairing_links")) {
    const alreadyRebuilt = yield* columnExists(sql, "auth_pairing_links", "credential_digest");
    if (!alreadyRebuilt) {
      yield* sql`DROP TABLE IF EXISTS auth_pairing_links_v88`;
      yield* sql`
        CREATE TABLE auth_pairing_links_v88 (
          id TEXT PRIMARY KEY,
          credential_digest TEXT NOT NULL UNIQUE,
          credential_hint TEXT NOT NULL,
          audience TEXT NOT NULL DEFAULT 'interactive',
          method TEXT NOT NULL,
          role TEXT NOT NULL,
          subject TEXT NOT NULL,
          label TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          revoked_at TEXT
        )
      `;
      // 'legacy:' || id can never collide with a base64url HMAC digest, so the
      // carried-over rows stay unique without retaining any secret material.
      yield* sql`
        INSERT INTO auth_pairing_links_v88 (
          id,
          credential_digest,
          credential_hint,
          audience,
          method,
          role,
          subject,
          label,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        )
        SELECT
          id,
          'legacy:' || id,
          substr(credential, 1, 4),
          'interactive',
          method,
          role,
          subject,
          label,
          created_at,
          expires_at,
          consumed_at,
          COALESCE(revoked_at, CASE WHEN consumed_at IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END)
        FROM auth_pairing_links
      `;
      yield* sql`DROP TABLE auth_pairing_links`;
      yield* sql`ALTER TABLE auth_pairing_links_v88 RENAME TO auth_pairing_links`;
    }

    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_auth_pairing_links_active
      ON auth_pairing_links(revoked_at, consumed_at, expires_at)
    `;
  }

  if (
    (yield* tableExists(sql, "auth_sessions")) &&
    !(yield* columnExists(sql, "auth_sessions", "audience"))
  ) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN audience TEXT NOT NULL DEFAULT 'interactive'
    `;
  }
});
