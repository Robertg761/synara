import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const insertLegacySession = (
  sql: SqlClient.SqlClient,
  input: { readonly sessionId: string; readonly issuedAt: string; readonly expiresAt: string },
) => sql`
  INSERT INTO auth_sessions (
    session_id,
    subject,
    role,
    method,
    client_device_type,
    issued_at,
    expires_at
  )
  VALUES (
    ${input.sessionId},
    'owner',
    'owner',
    'bearer-session-token',
    'unknown',
    ${input.issuedAt},
    ${input.expiresAt}
  )
`;

const readPolicies = (sql: SqlClient.SqlClient) =>
  sql<{ readonly sessionId: string; readonly renewalPolicy: string }>`
    SELECT session_id AS "sessionId", renewal_policy AS "renewalPolicy"
    FROM auth_sessions
    ORDER BY session_id ASC
  `.pipe(
    Effect.map((rows) => new Map(rows.map((row) => [row.sessionId, row.renewalPolicy] as const))),
  );

describe("097_AuthSessionRenewalPolicy", () => {
  it.effect("backfills pre-existing rows from the lifetime they were issued with", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });
      // Issued with the default 30-day TTL: the population that must keep sliding.
      yield* insertLegacySession(sql, {
        sessionId: "default-ttl",
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-31T00:00:00.000Z",
      });
      // Already slid forward before this migration existed; still a sliding session.
      yield* insertLegacySession(sql, {
        sessionId: "already-renewed",
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-06-15T09:30:00.000Z",
      });
      // Deliberate short-lived credential: never promotable to the default TTL.
      yield* insertLegacySession(sql, {
        sessionId: "short-lived",
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T01:00:00.000Z",
      });

      yield* runMigrations({ toMigrationInclusive: 90 });

      const policies = yield* readPolicies(sql);
      assert.strictEqual(policies.get("default-ttl"), "sliding");
      assert.strictEqual(policies.get("already-renewed"), "sliding");
      assert.strictEqual(policies.get("short-lived"), "fixed");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("adds the column once and safely accepts a pre-existing one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });
      yield* sql`
        ALTER TABLE auth_sessions
        ADD COLUMN renewal_policy TEXT NOT NULL DEFAULT 'sliding'
      `;
      yield* insertLegacySession(sql, {
        sessionId: "short-lived",
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T01:00:00.000Z",
      });

      yield* runMigrations({ toMigrationInclusive: 90 });

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('auth_sessions')
      `;
      assert.strictEqual(columns.filter((column) => column.name === "renewal_policy").length, 1);
      // A database that already carries the column was written by a build that set the policy
      // at issuance, so the backfill must not re-classify its rows.
      const policies = yield* readPolicies(sql);
      assert.strictEqual(policies.get("short-lived"), "sliding");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("propagates schema failures and leaves migration 90 retryable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });
      yield* sql`DROP TABLE auth_sessions`;

      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 90 }));
      assert.isTrue(Exit.isFailure(exit));

      const tracker = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM effect_sql_migrations
        WHERE migration_id = 90
      `;
      assert.strictEqual(tracker[0]?.count, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
