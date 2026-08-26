import { AuthSessionId } from "@synara/contracts";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors";
import {
  AuthSessionRecord,
  AuthSessionRenewalPolicy,
  AuthSessionRepository,
  type AuthSessionRepositoryShape,
  CreateAuthSessionInput,
  GetAuthSessionByIdInput,
  SetAuthSessionLastConnectedAtInput,
} from "../Services/AuthSessions";

const AuthSessionDbRow = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  role: Schema.Literals(["owner", "client"]),
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  clientLabel: Schema.NullOr(Schema.String),
  clientIpAddress: Schema.NullOr(Schema.String),
  clientUserAgent: Schema.NullOr(Schema.String),
  clientDeviceType: Schema.Literals(["desktop", "mobile", "tablet", "bot", "unknown"]),
  clientOs: Schema.NullOr(Schema.String),
  clientBrowser: Schema.NullOr(Schema.String),
  renewalPolicy: AuthSessionRenewalPolicy,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});

/**
 * Request shapes for `SqlSchema.findAll`, which — unlike `findOne`/`findOneOption`/`void` —
 * types its query function as taking `Request["Encoded"]`. Passing a decoded request through
 * that signature only compiles behind a cast, and a cast is exactly what hides a renamed or
 * retyped field: the call site would keep compiling while the query silently stopped matching.
 * These schemas therefore describe the already-encoded row values (ISO-8601 timestamps), so
 * every `findAll` call site is checked against the shape the query actually receives.
 */
const ListActiveAuthSessionsDbRequest = Schema.Struct({ now: Schema.String });
const ExtendAuthSessionExpiryDbRequest = Schema.Struct({
  sessionId: AuthSessionId,
  expiresAt: Schema.String,
});
const RevokeAuthSessionDbRequest = Schema.Struct({
  sessionId: AuthSessionId,
  revokedAt: Schema.String,
});
const RevokeOtherAuthSessionsDbRequest = Schema.Struct({
  currentSessionId: AuthSessionId,
  revokedAt: Schema.String,
});

function toAuthSessionRecord(row: typeof AuthSessionDbRow.Type): typeof AuthSessionRecord.Type {
  return {
    sessionId: row.sessionId,
    subject: row.subject,
    role: row.role,
    method: row.method,
    client: {
      label: row.clientLabel,
      ipAddress: row.clientIpAddress,
      userAgent: row.clientUserAgent,
      deviceType: row.clientDeviceType,
      os: row.clientOs,
      browser: row.clientBrowser,
    },
    renewalPolicy: row.renewalPolicy,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    lastConnectedAt: row.lastConnectedAt,
    revokedAt: row.revokedAt,
  };
}

// Accepts both forms a timestamp reaches a query in: already encoded (`SqlSchema` hands
// `execute` the encoded request) or still decoded (request shapes mapped by hand below).
function toIsoDateTime(value: string | Date | DateTime.DateTime): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return DateTime.formatIso(value);
}

const makeAuthSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createSessionRow = SqlSchema.void({
    Request: CreateAuthSessionInput,
    execute: (input) => sql`
      INSERT INTO auth_sessions (
        session_id,
        subject,
        role,
        method,
        client_label,
        client_ip_address,
        client_user_agent,
        client_device_type,
        client_os,
        client_browser,
        renewal_policy,
        issued_at,
        expires_at,
        revoked_at
      )
      VALUES (
        ${input.sessionId},
        ${input.subject},
        ${input.role},
        ${input.method},
        ${input.client.label},
        ${input.client.ipAddress},
        ${input.client.userAgent},
        ${input.client.deviceType},
        ${input.client.os},
        ${input.client.browser},
        ${input.renewalPolicy},
        ${toIsoDateTime(input.issuedAt)},
        ${toIsoDateTime(input.expiresAt)},
        NULL
      )
    `,
  });

  const getSessionRowById = SqlSchema.findOneOption({
    Request: GetAuthSessionByIdInput,
    Result: AuthSessionDbRow,
    execute: ({ sessionId }) => sql`
      SELECT
        session_id AS "sessionId",
        subject AS "subject",
        role AS "role",
        method AS "method",
        client_label AS "clientLabel",
        client_ip_address AS "clientIpAddress",
        client_user_agent AS "clientUserAgent",
        client_device_type AS "clientDeviceType",
        client_os AS "clientOs",
        client_browser AS "clientBrowser",
        renewal_policy AS "renewalPolicy",
        issued_at AS "issuedAt",
        expires_at AS "expiresAt",
        last_connected_at AS "lastConnectedAt",
        revoked_at AS "revokedAt"
      FROM auth_sessions
      WHERE session_id = ${sessionId}
    `,
  });

  const listActiveSessionRows = SqlSchema.findAll({
    Request: ListActiveAuthSessionsDbRequest,
    Result: AuthSessionDbRow,
    execute: ({ now }) => sql`
      SELECT
        session_id AS "sessionId",
        subject AS "subject",
        role AS "role",
        method AS "method",
        client_label AS "clientLabel",
        client_ip_address AS "clientIpAddress",
        client_user_agent AS "clientUserAgent",
        client_device_type AS "clientDeviceType",
        client_os AS "clientOs",
        client_browser AS "clientBrowser",
        renewal_policy AS "renewalPolicy",
        issued_at AS "issuedAt",
        expires_at AS "expiresAt",
        last_connected_at AS "lastConnectedAt",
        revoked_at AS "revokedAt"
      FROM auth_sessions
      WHERE revoked_at IS NULL
        AND expires_at > ${now}
      ORDER BY issued_at DESC, session_id DESC
    `,
  });

  const setLastConnectedAtRow = SqlSchema.void({
    Request: SetAuthSessionLastConnectedAtInput,
    execute: ({ sessionId, lastConnectedAt }) => sql`
      UPDATE auth_sessions
      SET last_connected_at = ${toIsoDateTime(lastConnectedAt)}
      WHERE session_id = ${sessionId}
        AND revoked_at IS NULL
    `,
  });

  const extendSessionExpiryRows = SqlSchema.findAll({
    Request: ExtendAuthSessionExpiryDbRequest,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, expiresAt }) => sql`
      UPDATE auth_sessions
      SET expires_at = ${expiresAt}
      WHERE session_id = ${sessionId}
        AND revoked_at IS NULL
        AND expires_at < ${expiresAt}
      RETURNING session_id AS "sessionId"
    `,
  });

  const revokeSessionRows = SqlSchema.findAll({
    Request: RevokeAuthSessionDbRequest,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ sessionId, revokedAt }) => sql`
      UPDATE auth_sessions
      SET revoked_at = ${revokedAt}
      WHERE session_id = ${sessionId}
        AND revoked_at IS NULL
      RETURNING session_id AS "sessionId"
    `,
  });

  const revokeOtherSessionRows = SqlSchema.findAll({
    Request: RevokeOtherAuthSessionsDbRequest,
    Result: Schema.Struct({ sessionId: AuthSessionId }),
    execute: ({ currentSessionId, revokedAt }) => sql`
      UPDATE auth_sessions
      SET revoked_at = ${revokedAt}
      WHERE session_id <> ${currentSessionId}
        AND revoked_at IS NULL
      RETURNING session_id AS "sessionId"
    `,
  });

  const create: AuthSessionRepositoryShape["create"] = (input) =>
    createSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.create:query",
          "AuthSessionRepository.create:encodeRequest",
        ),
      ),
    );

  const getById: AuthSessionRepositoryShape["getById"] = (input) =>
    getSessionRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.getById:query",
          "AuthSessionRepository.getById:decodeRow",
        ),
      ),
      Effect.map((rowOption) => Option.map(rowOption, toAuthSessionRecord)),
    );

  const listActive: AuthSessionRepositoryShape["listActive"] = (input) =>
    listActiveSessionRows({ now: toIsoDateTime(input.now) }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.listActive:query",
          "AuthSessionRepository.listActive:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(toAuthSessionRecord)),
    );

  const extendExpiry: AuthSessionRepositoryShape["extendExpiry"] = (input) =>
    extendSessionExpiryRows({
      sessionId: input.sessionId,
      expiresAt: toIsoDateTime(input.expiresAt),
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.extendExpiry:query",
          "AuthSessionRepository.extendExpiry:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const revoke: AuthSessionRepositoryShape["revoke"] = (input) =>
    revokeSessionRows({
      sessionId: input.sessionId,
      revokedAt: toIsoDateTime(input.revokedAt),
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revoke:query",
          "AuthSessionRepository.revoke:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const revokeAllExcept: AuthSessionRepositoryShape["revokeAllExcept"] = (input) =>
    revokeOtherSessionRows({
      currentSessionId: input.currentSessionId,
      revokedAt: toIsoDateTime(input.revokedAt),
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.revokeAllExcept:query",
          "AuthSessionRepository.revokeAllExcept:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.sessionId)),
    );

  const setLastConnectedAt: AuthSessionRepositoryShape["setLastConnectedAt"] = (input) =>
    setLastConnectedAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthSessionRepository.setLastConnectedAt:query",
          "AuthSessionRepository.setLastConnectedAt:encodeRequest",
        ),
      ),
    );

  return {
    create,
    getById,
    listActive,
    extendExpiry,
    revoke,
    revokeAllExcept,
    setLastConnectedAt,
  };
});

export const AuthSessionRepositoryLive = Layer.effect(
  AuthSessionRepository,
  makeAuthSessionRepository,
);
