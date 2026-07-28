import {
  INTERACTIVE_AUTH_AUDIENCE,
  type AuthAudience,
  type AuthPairingLink,
} from "@synara/contracts";
import * as Crypto from "node:crypto";
import { DateTime, Duration, Effect, Layer, Option, PubSub, Ref, Stream } from "effect";

import { AuthPairingLinkRepositoryLive } from "../../persistence/Layers/AuthPairingLinks";
import { AuthPairingLinkRepository } from "../../persistence/Services/AuthPairingLinks";
import { derivePairingCredentialDigest, derivePairingCredentialHint } from "../credentialDigest";
import { ServerSecretStore } from "../Services/ServerSecretStore";
import {
  BootstrapCredentialError,
  BootstrapCredentialService,
  type BootstrapCredentialChange,
  type BootstrapCredentialServiceShape,
  type BootstrapGrant,
  type IssuedBootstrapCredential,
} from "../Services/BootstrapCredentialService";

interface StoredBootstrapGrant extends BootstrapGrant {
  readonly remainingUses: number | "unbounded";
}

const PAIRING_DIGEST_SECRET_NAME = "pairing-credential-digest-key";
const DEFAULT_ONE_TIME_TOKEN_TTL = Duration.minutes(5);
const PAIRING_TOKEN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const PAIRING_TOKEN_LENGTH = 12;

// One message for every rejected credential. Distinguishing "unknown" from
// "revoked" or "expired" would tell a guesser that its token matched a row.
const UNAVAILABLE_CREDENTIAL_MESSAGE = "Bootstrap credential is not valid.";

const generatePairingToken = (): string => {
  const randomBytes = Crypto.randomBytes(PAIRING_TOKEN_LENGTH);
  return Array.from(randomBytes, (value) => PAIRING_TOKEN_ALPHABET[value & 31]).join("");
};

const toBootstrapCredentialError = (message: string, status: 401 | 500, cause?: unknown) =>
  new BootstrapCredentialError({
    message,
    status,
    ...(cause === undefined ? {} : { cause }),
  });

const toPairingLink = (row: {
  readonly id: string;
  readonly credentialHint: string;
  readonly audience: AuthAudience;
  readonly role: "owner" | "client";
  readonly subject: string;
  readonly label: string | null;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}): AuthPairingLink => ({
  id: row.id,
  credentialHint: row.credentialHint,
  audience: row.audience,
  role: row.role,
  subject: row.subject,
  ...(row.label ? { label: row.label } : {}),
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
});

export const makeBootstrapCredentialService = Effect.gen(function* () {
  const pairingLinks = yield* AuthPairingLinkRepository;
  const secretStore = yield* ServerSecretStore;
  const digestSecret = yield* secretStore.getOrCreateRandom(PAIRING_DIGEST_SECRET_NAME, 32);
  const seededGrantsRef = yield* Ref.make(new Map<string, StoredBootstrapGrant>());
  const changesPubSub = yield* PubSub.unbounded<BootstrapCredentialChange>();

  const emitUpsert = (pairingLink: AuthPairingLink) =>
    PubSub.publish(changesPubSub, {
      type: "pairingLinkUpserted",
      pairingLink,
    }).pipe(Effect.asVoid);

  const emitRemoved = (id: string) =>
    PubSub.publish(changesPubSub, {
      type: "pairingLinkRemoved",
      id,
    }).pipe(Effect.asVoid);

  const listActive: BootstrapCredentialServiceShape["listActive"] = () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const rows = yield* pairingLinks.listActive({ now });
      return rows.map(toPairingLink);
    }).pipe(
      Effect.mapError((cause) =>
        toBootstrapCredentialError("Failed to load active pairing links.", 500, cause),
      ),
    );

  const revoke: BootstrapCredentialServiceShape["revoke"] = (id) =>
    Effect.gen(function* () {
      const revokedAt = yield* DateTime.now;
      const revoked = yield* pairingLinks.revoke({ id, revokedAt });
      if (revoked) yield* emitRemoved(id);
      return revoked;
    }).pipe(
      Effect.mapError((cause) =>
        toBootstrapCredentialError("Failed to revoke pairing link.", 500, cause),
      ),
    );

  const issueOneTimeToken: BootstrapCredentialServiceShape["issueOneTimeToken"] = (input) =>
    Effect.gen(function* () {
      const id = Crypto.randomUUID();
      const credential = generatePairingToken();
      const credentialHint = derivePairingCredentialHint(credential);
      const now = yield* DateTime.now;
      const ttl = input?.ttl ?? DEFAULT_ONE_TIME_TOKEN_TTL;
      const expiresAt = DateTime.addDuration(now, ttl);
      const role = input?.role ?? "client";
      const subject = input?.subject ?? "one-time-token";
      const audience = input?.audience ?? INTERACTIVE_AUTH_AUDIENCE;
      const label = input?.label;

      yield* pairingLinks.create({
        id,
        credentialDigest: derivePairingCredentialDigest(credential, digestSecret),
        credentialHint,
        audience,
        method: "one-time-token",
        role,
        subject,
        label: label ?? null,
        createdAt: now,
        expiresAt,
      });

      const pairingLink = toPairingLink({
        id,
        credentialHint,
        audience,
        role,
        subject,
        label: label ?? null,
        createdAt: now,
        expiresAt,
      });
      yield* emitUpsert(pairingLink);

      return {
        id,
        credential,
        credentialHint,
        audience,
        ...(label ? { label } : {}),
        expiresAt,
      } satisfies IssuedBootstrapCredential;
    }).pipe(
      Effect.mapError((cause) =>
        toBootstrapCredentialError("Failed to issue pairing credential.", 500, cause),
      ),
    );

  const consumeSeededGrant = (
    credential: string,
    now: DateTime.Utc,
  ): Effect.Effect<StoredBootstrapGrant | "expired" | null> =>
    Ref.modify<Map<string, StoredBootstrapGrant>, StoredBootstrapGrant | "expired" | null>(
      seededGrantsRef,
      (current) => {
        const grant = current.get(credential);
        if (!grant) return [null, current] as const;

        const next = new Map(current);
        if (DateTime.isGreaterThanOrEqualTo(now, grant.expiresAt)) {
          next.delete(credential);
          return ["expired", next] as const;
        }

        if (typeof grant.remainingUses === "number") {
          if (grant.remainingUses <= 1) {
            next.delete(credential);
          } else {
            next.set(credential, { ...grant, remainingUses: grant.remainingUses - 1 });
          }
        }

        return [grant, next] as const;
      },
    );

  const consume: BootstrapCredentialServiceShape["consume"] = (credential) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const seeded = yield* consumeSeededGrant(credential, now);
      if (seeded === "expired") {
        return yield* toBootstrapCredentialError(UNAVAILABLE_CREDENTIAL_MESSAGE, 401);
      }
      if (seeded) {
        return {
          method: seeded.method,
          role: seeded.role,
          audience: seeded.audience,
          subject: seeded.subject,
          ...(seeded.label ? { label: seeded.label } : {}),
          expiresAt: seeded.expiresAt,
        } satisfies BootstrapGrant;
      }

      // The digest is derived before the atomic consume so the redemption stays
      // a single conditional UPDATE ... RETURNING against the stored digest.
      const credentialDigest = derivePairingCredentialDigest(credential, digestSecret);
      const consumed = yield* pairingLinks.consumeAvailable({
        credentialDigest,
        consumedAt: now,
        now,
      });

      if (Option.isSome(consumed)) {
        yield* emitRemoved(consumed.value.id);
        return {
          method: consumed.value.method,
          role: consumed.value.role,
          audience: consumed.value.audience,
          subject: consumed.value.subject,
          ...(consumed.value.label ? { label: consumed.value.label } : {}),
          expiresAt: consumed.value.expiresAt,
        } satisfies BootstrapGrant;
      }

      // Classify server-side only: every failure branch below runs the same
      // lookup and returns the same error, so neither the response nor the
      // work performed distinguishes a matched row from a guess.
      const matching = yield* pairingLinks.getByCredentialDigest({ credentialDigest });
      yield* Effect.logWarning("Rejected bootstrap credential.").pipe(
        Effect.annotateLogs({
          reason: Option.isNone(matching)
            ? "unknown"
            : matching.value.revokedAt !== null
              ? "revoked"
              : matching.value.consumedAt !== null
                ? "consumed"
                : "expired",
        }),
      );
      return yield* toBootstrapCredentialError(UNAVAILABLE_CREDENTIAL_MESSAGE, 401);
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof BootstrapCredentialError
          ? cause
          : toBootstrapCredentialError("Failed to consume bootstrap credential.", 500, cause),
      ),
    );

  return {
    issueOneTimeToken,
    listActive,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke,
    consume,
  } satisfies BootstrapCredentialServiceShape;
});

export const BootstrapCredentialServiceLive = Layer.effect(
  BootstrapCredentialService,
  makeBootstrapCredentialService,
).pipe(Layer.provideMerge(AuthPairingLinkRepositoryLive));
