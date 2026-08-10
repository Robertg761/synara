import { AuthClientMetadataDeviceType, AuthSessionId } from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { AuthSessionRepositoryError } from "../Errors";

export const AuthSessionClientMetadataRecord = Schema.Struct({
  label: Schema.NullOr(Schema.String),
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.NullOr(Schema.String),
  browser: Schema.NullOr(Schema.String),
});
export type AuthSessionClientMetadataRecord = typeof AuthSessionClientMetadataRecord.Type;

/**
 * Whether a session's expiry may slide forward on use, decided once by the issuer and then
 * persisted. It is deliberately a stored property rather than something re-derived from
 * `expiresAt - issuedAt`: an inferred rule silently reclassifies every already-issued session
 * the moment the default TTL constant changes, and the failure mode (sessions quietly stop
 * renewing) produces no error anywhere.
 *
 * - `sliding`: renewal may push `expiresAt` forward, bounded by the absolute lifetime cap.
 * - `fixed`: the session expires at `expiresAt` and is never extended. Anything issued with an
 *   explicitly requested TTL is a deliberate hard-expiry contract.
 */
export const AuthSessionRenewalPolicy = Schema.Literals(["sliding", "fixed"]);
export type AuthSessionRenewalPolicy = typeof AuthSessionRenewalPolicy.Type;

export const AuthSessionRecord = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  role: Schema.Literals(["owner", "client"]),
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  client: AuthSessionClientMetadataRecord,
  renewalPolicy: AuthSessionRenewalPolicy,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type AuthSessionRecord = typeof AuthSessionRecord.Type;

export const CreateAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  subject: Schema.String,
  role: Schema.Literals(["owner", "client"]),
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  client: AuthSessionClientMetadataRecord,
  renewalPolicy: AuthSessionRenewalPolicy,
  issuedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type CreateAuthSessionInput = typeof CreateAuthSessionInput.Type;

export const GetAuthSessionByIdInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type GetAuthSessionByIdInput = typeof GetAuthSessionByIdInput.Type;

export const ListActiveAuthSessionsInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
});
export type ListActiveAuthSessionsInput = typeof ListActiveAuthSessionsInput.Type;

export const ExtendAuthSessionExpiryInput = Schema.Struct({
  sessionId: AuthSessionId,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type ExtendAuthSessionExpiryInput = typeof ExtendAuthSessionExpiryInput.Type;

export const RevokeAuthSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthSessionInput = typeof RevokeAuthSessionInput.Type;

export const RevokeOtherAuthSessionsInput = Schema.Struct({
  currentSessionId: AuthSessionId,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeOtherAuthSessionsInput = typeof RevokeOtherAuthSessionsInput.Type;

export const SetAuthSessionLastConnectedAtInput = Schema.Struct({
  sessionId: AuthSessionId,
  lastConnectedAt: Schema.DateTimeUtcFromString,
});
export type SetAuthSessionLastConnectedAtInput = typeof SetAuthSessionLastConnectedAtInput.Type;

export interface AuthSessionRepositoryShape {
  readonly create: (
    input: CreateAuthSessionInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
  readonly getById: (
    input: GetAuthSessionByIdInput,
  ) => Effect.Effect<Option.Option<AuthSessionRecord>, AuthSessionRepositoryError>;
  readonly listActive: (
    input: ListActiveAuthSessionsInput,
  ) => Effect.Effect<ReadonlyArray<AuthSessionRecord>, AuthSessionRepositoryError>;
  /**
   * Pushes a session's expiry forward. The update is monotonic: it only applies to a
   * live (non-revoked) row whose current expiry is earlier than the requested one, so
   * concurrent renewals can never shrink a session's lifetime. Resolves to `true` when
   * a row was actually extended.
   *
   * Whether a session is allowed to be extended at all is the caller's decision, read from
   * the row's {@link AuthSessionRenewalPolicy}; this operation only enforces monotonicity.
   */
  readonly extendExpiry: (
    input: ExtendAuthSessionExpiryInput,
  ) => Effect.Effect<boolean, AuthSessionRepositoryError>;
  readonly revoke: (
    input: RevokeAuthSessionInput,
  ) => Effect.Effect<boolean, AuthSessionRepositoryError>;
  readonly revokeAllExcept: (
    input: RevokeOtherAuthSessionsInput,
  ) => Effect.Effect<ReadonlyArray<AuthSessionId>, AuthSessionRepositoryError>;
  readonly setLastConnectedAt: (
    input: SetAuthSessionLastConnectedAtInput,
  ) => Effect.Effect<void, AuthSessionRepositoryError>;
}

export class AuthSessionRepository extends ServiceMap.Service<
  AuthSessionRepository,
  AuthSessionRepositoryShape
>()("synara/persistence/Services/AuthSessions/AuthSessionRepository") {}
