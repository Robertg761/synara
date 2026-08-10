import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AuthSessionId } from "@synara/contracts";
import {
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  type Scope,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import {
  AuthSessionRepository,
  type AuthSessionRenewalPolicy,
} from "../../persistence/Services/AuthSessions";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { base64UrlDecodeUtf8 } from "../utils";
import { ServerSecretStoreLive } from "./ServerSecretStore";
import {
  SessionCapacityError,
  SessionCredentialService,
  type SessionCredentialChange,
  type SessionCredentialError,
} from "../Services/SessionCredentialService";
import {
  MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION,
  MAX_OUTSTANDING_WEBSOCKET_TICKETS_PER_SESSION,
  SessionCredentialServiceLive,
} from "./SessionCredentialService";

// `provideMerge` so tests can reach the same in-memory database the service writes to and
// stage rows that only an older build (or a different default TTL) could have produced.
const testLayer = SessionCredentialServiceLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-auth-session-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

type SessionTestServices =
  | SessionCredentialService
  | AuthSessionRepository
  | SqlClient.SqlClient
  | Scope.Scope;

const SESSION_TTL_MILLIS = Duration.toMillis(Duration.days(30));
const SESSION_ABSOLUTE_LIFETIME_MILLIS = Duration.toMillis(Duration.days(365));

interface SessionTokenClaims {
  readonly iat: number;
  readonly exp: number;
}

function decodeSessionTokenClaims(token: string): SessionTokenClaims {
  return JSON.parse(base64UrlDecodeUtf8(token.split(".")[0]!)) as SessionTokenClaims;
}

/**
 * Rewrites a row's persisted renewal policy. Renewability is only ever chosen at issuance, so
 * this is how a test stages the rows that matter: one issued by a build with a different
 * default TTL, and one whose policy disagrees with what the token's claims would imply.
 */
const setPersistedRenewalPolicy = (
  sessionId: AuthSessionId,
  renewalPolicy: AuthSessionRenewalPolicy,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE auth_sessions
      SET renewal_policy = ${renewalPolicy}
      WHERE session_id = ${sessionId}
    `;
  });

const runSessionTest = <A, E>(effect: Effect.Effect<A, E, SessionTestServices>) =>
  effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);

const runSessionTestWithTestClock = <A, E>(effect: Effect.Effect<A, E, SessionTestServices>) =>
  effect.pipe(
    Effect.provide(Layer.merge(testLayer, TestClock.layer())),
    Effect.scoped,
    Effect.runPromise,
  );

const makeBlockingConnection = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const effect = Effect.acquireUseRelease(
    Deferred.succeed(started, undefined),
    () => Effect.never,
    () => Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
  );
  return { started, closed, effect } as const;
});

describe("SessionCredentialServiceLive", () => {
  it("issues and verifies signed browser session tokens", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({
          subject: "desktop-bootstrap",
          role: "owner",
          client: {
            label: "Desktop app",
            deviceType: "desktop",
            os: "macOS",
            browser: "Electron",
            ipAddress: "127.0.0.1",
          },
        });
        const verified = yield* sessions.verify(issued.token);

        expect(verified.method).toBe("browser-session-cookie");
        expect(verified.subject).toBe("desktop-bootstrap");
        expect(verified.role).toBe("owner");
        expect(verified.client.label).toBe("Desktop app");
        expect(verified.client.browser).toBe("Electron");
      }),
    );
  });

  it("rejects malformed session tokens", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const error = yield* Effect.flip(sessions.verify("not-a-session-token"));

        expect(error.message).toContain("Malformed session token");
      }),
    );
  });

  it("issues and verifies websocket tokens for active sessions", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });
        const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);
        const verified = yield* sessions.verifyWebSocketToken(websocket.token);

        expect(verified.sessionId).toBe(issued.sessionId);
        expect(verified.method).toBe("bearer-session-token");
      }),
    );
  });

  it("consumes websocket tickets exactly once under concurrent verification", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);
        const attempts = yield* Effect.forEach(
          Array.from({ length: 12 }),
          () => sessions.verifyWebSocketToken(websocket.token).pipe(Effect.exit),
          { concurrency: "unbounded" },
        );

        expect(attempts.filter((attempt) => attempt._tag === "Success")).toHaveLength(1);
        expect(attempts.filter((attempt) => attempt._tag === "Failure")).toHaveLength(11);
      }),
    );
  });

  it("bounds outstanding websocket tickets per session and frees consumed capacity", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        const tickets = yield* Effect.forEach(
          Array.from({ length: MAX_OUTSTANDING_WEBSOCKET_TICKETS_PER_SESSION }),
          () => sessions.issueWebSocketToken(issued.sessionId),
        );

        const capacityError = yield* Effect.flip(sessions.issueWebSocketToken(issued.sessionId));
        expect(capacityError).toBeInstanceOf(SessionCapacityError);
        if (capacityError instanceof SessionCapacityError) {
          expect(capacityError.scope).toBe("websocket-tickets");
          expect(capacityError.active).toBe(MAX_OUTSTANDING_WEBSOCKET_TICKETS_PER_SESSION);
        }

        yield* sessions.verifyWebSocketToken(tickets[0]!.token);
        yield* sessions.issueWebSocketToken(issued.sessionId);
      }),
    );
  });

  it("lists active sessions and tracks connectivity", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({
          subject: "client",
          client: { label: "Client", deviceType: "desktop" },
        });
        const connection = yield* makeBlockingConnection;

        const fiber = yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(issued.sessionId, connection.effect),
        );
        yield* Deferred.await(connection.started);
        const connected = yield* sessions.listActive();
        yield* Fiber.interrupt(fiber);
        yield* Deferred.await(connection.closed);
        const disconnected = yield* sessions.listActive();

        expect(connected[0]?.connected).toBe(true);
        expect(connected[0]?.lastConnectedAt).not.toBeNull();
        expect(disconnected[0]?.connected).toBe(false);
      }),
    );
  });

  it("atomically caps session connections and preserves capacity isolation", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const saturatedSession = yield* sessions.issue({ subject: "saturated" });
        const independentSession = yield* sessions.issue({ subject: "independent" });
        const startedCount = yield* Ref.make(0);
        const connectionEffect = Effect.acquireUseRelease(
          Ref.update(startedCount, (count) => count + 1),
          () => Effect.never,
          () => Effect.void,
        );
        const attempts = yield* Effect.forEach(
          Array.from({ length: MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION + 4 }),
          () =>
            Effect.forkChild(
              sessions.runAuthenticatedConnection(saturatedSession.sessionId, connectionEffect),
            ),
        );

        yield* Effect.sleep(Duration.millis(50));
        expect(yield* Ref.get(startedCount)).toBe(MAX_AUTHENTICATED_CONNECTIONS_PER_SESSION);
        const completed = attempts.map((fiber) => fiber.pollUnsafe());
        const rejected = completed.filter((result) => result?._tag === "Failure");
        expect(rejected).toHaveLength(4);

        const independent = yield* makeBlockingConnection;
        const independentFiber = yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(independentSession.sessionId, independent.effect),
        );
        yield* Deferred.await(independent.started);
        expect(yield* Deferred.isDone(independent.closed)).toBe(false);

        yield* Effect.forEach(attempts, Fiber.interrupt, { discard: true });
        yield* Fiber.interrupt(independentFiber);
      }),
    );
  });

  it("interrupts every connection for a revoked session without affecting other sessions", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const revokedSession = yield* sessions.issue({ subject: "revoked-client" });
        const survivingSession = yield* sessions.issue({ subject: "surviving-client" });
        const first = yield* makeBlockingConnection;
        const second = yield* makeBlockingConnection;
        const survivor = yield* makeBlockingConnection;

        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(revokedSession.sessionId, first.effect),
        );
        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(revokedSession.sessionId, second.effect),
        );
        const survivorFiber = yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(survivingSession.sessionId, survivor.effect),
        );
        yield* Deferred.await(first.started);
        yield* Deferred.await(second.started);
        yield* Deferred.await(survivor.started);

        expect(yield* sessions.revoke(revokedSession.sessionId)).toBe(true);
        expect(yield* Deferred.isDone(first.closed)).toBe(true);
        expect(yield* Deferred.isDone(second.closed)).toBe(true);
        yield* Deferred.await(first.closed);
        yield* Deferred.await(second.closed);

        expect(yield* Deferred.isDone(survivor.closed)).toBe(false);
        expect(
          (yield* sessions.listActive()).find(
            (item) => item.sessionId === survivingSession.sessionId,
          )?.connected,
        ).toBe(true);

        yield* Fiber.interrupt(survivorFiber);
      }),
    );
  });

  it("rejects connection registration after revocation", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        yield* sessions.revoke(issued.sessionId);

        const error = yield* Effect.flip(
          sessions.runAuthenticatedConnection(issued.sessionId, Effect.void),
        );

        expect(error).toBeInstanceOf(Error);
        expect((error as SessionCredentialError).message).toContain("revoked");
      }),
    );
  });

  it("interrupts revoked connections before revoke-all-except returns", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const currentSession = yield* sessions.issue({ subject: "current-client" });
        const firstRevokedSession = yield* sessions.issue({ subject: "first-revoked-client" });
        const secondRevokedSession = yield* sessions.issue({ subject: "second-revoked-client" });
        const current = yield* makeBlockingConnection;
        const firstRevoked = yield* makeBlockingConnection;
        const secondRevoked = yield* makeBlockingConnection;

        const currentFiber = yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(currentSession.sessionId, current.effect),
        );
        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(firstRevokedSession.sessionId, firstRevoked.effect),
        );
        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(secondRevokedSession.sessionId, secondRevoked.effect),
        );
        yield* Deferred.await(current.started);
        yield* Deferred.await(firstRevoked.started);
        yield* Deferred.await(secondRevoked.started);

        expect(yield* sessions.revokeAllExcept(currentSession.sessionId)).toBe(2);
        expect(yield* Deferred.isDone(firstRevoked.closed)).toBe(true);
        expect(yield* Deferred.isDone(secondRevoked.closed)).toBe(true);
        expect(yield* Deferred.isDone(current.closed)).toBe(false);

        yield* Fiber.interrupt(currentFiber);
      }),
    );
  });

  it("rejects websocket tokens once the parent session has expired", async () => {
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ ttl: Duration.seconds(1) });
        const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

        yield* TestClock.adjust(Duration.seconds(2));

        const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
        expect(error.message).toContain("Invalid websocket token");
      }),
    );
  });

  it("interrupts an established connection when its session expires", async () => {
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ ttl: Duration.seconds(1) });
        const connection = yield* makeBlockingConnection;

        yield* Effect.forkChild(
          sessions.runAuthenticatedConnection(issued.sessionId, connection.effect),
        );
        yield* Deferred.await(connection.started);
        yield* TestClock.adjust(Duration.seconds(2));
        yield* Deferred.await(connection.closed);

        expect(yield* sessions.listActive()).toHaveLength(0);
      }),
    );
  });

  it("leaves session expiry untouched inside the renewal throttle window", async () => {
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });
        const verified = yield* sessions.verify(issued.token);

        expect(DateTime.toEpochMillis(verified.expiresAt!)).toBe(
          DateTime.toEpochMillis(issued.expiresAt),
        );
        const active = yield* sessions.listActive();
        expect(DateTime.toEpochMillis(active[0]!.expiresAt)).toBe(
          DateTime.toEpochMillis(issued.expiresAt),
        );
      }),
    );
  });

  it("slides session expiry forward on use once the renewal throttle has elapsed", async () => {
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });
        const changes = yield* Queue.unbounded<SessionCredentialChange>();
        yield* Effect.forkScoped(
          sessions.streamChanges.pipe(
            Stream.runForEach((change) => Queue.offer(changes, change).pipe(Effect.asVoid)),
          ),
          { startImmediately: true },
        );

        yield* TestClock.adjust(Duration.days(2));
        const verified = yield* sessions.verify(issued.token);
        const nowMillis = yield* Clock.currentTimeMillis;

        expect(DateTime.toEpochMillis(verified.expiresAt!)).toBe(nowMillis + SESSION_TTL_MILLIS);
        const active = yield* sessions.listActive();
        expect(DateTime.toEpochMillis(active[0]!.expiresAt)).toBe(nowMillis + SESSION_TTL_MILLIS);

        const change = yield* Queue.take(changes);
        expect(change.type).toBe("clientUpserted");
        if (change.type === "clientUpserted") {
          expect(change.clientSession.sessionId).toBe(issued.sessionId);
          expect(DateTime.toEpochMillis(change.clientSession.expiresAt)).toBe(
            nowMillis + SESSION_TTL_MILLIS,
          );
        }
      }),
    );
  });

  it("keeps verifying a bearer token past the expiry stamped into its claims", async () => {
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });

        yield* TestClock.adjust(Duration.days(29));
        yield* sessions.verify(issued.token);
        yield* TestClock.adjust(Duration.days(29));

        const nowMillis = yield* Clock.currentTimeMillis;
        expect(nowMillis).toBeGreaterThan(DateTime.toEpochMillis(issued.expiresAt));

        const verified = yield* sessions.verify(issued.token);
        expect(verified.sessionId).toBe(issued.sessionId);
        expect(DateTime.toEpochMillis(verified.expiresAt!)).toBe(nowMillis + SESSION_TTL_MILLIS);
      }),
    );
  });

  it("expires a session that goes unused for longer than its lifetime", async () => {
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });

        yield* TestClock.adjust(Duration.days(31));

        const error = yield* Effect.flip(sessions.verify(issued.token));
        expect(error.message).toContain("Session token expired");
        expect(yield* sessions.listActive()).toHaveLength(0);
      }),
    );
  });

  it("never renews the session when a websocket ticket is consumed", async () => {
    // Regression pin: ticket consumption is deliberately not a renewal point. Every ticket is
    // minted moments earlier by a request that authenticated through `verify`, which renews.
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });

        yield* TestClock.adjust(Duration.days(2));
        const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);
        const verified = yield* sessions.verifyWebSocketToken(websocket.token);

        expect(DateTime.toEpochMillis(verified.expiresAt!)).toBe(
          DateTime.toEpochMillis(issued.expiresAt),
        );
        const active = yield* sessions.listActive();
        expect(DateTime.toEpochMillis(active[0]!.expiresAt)).toBe(
          DateTime.toEpochMillis(issued.expiresAt),
        );
      }),
    );
  });

  it("slides a browser-session-cookie session exactly like a bearer one", async () => {
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "browser-session-cookie" });

        yield* TestClock.adjust(Duration.days(2));
        const verified = yield* sessions.verify(issued.token);
        const nowMillis = yield* Clock.currentTimeMillis;

        expect(verified.method).toBe("browser-session-cookie");
        expect(DateTime.toEpochMillis(verified.expiresAt!)).toBe(nowMillis + SESSION_TTL_MILLIS);
        const active = yield* sessions.listActive();
        expect(DateTime.toEpochMillis(active[0]!.expiresAt)).toBe(nowMillis + SESSION_TTL_MILLIS);
      }),
    );
  });

  it("persists the renewal policy chosen at issuance", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const repository = yield* AuthSessionRepository;
        const sliding = yield* sessions.issue({ method: "bearer-session-token" });
        const fixed = yield* sessions.issue({
          method: "bearer-session-token",
          ttl: Duration.days(10),
        });

        const slidingRow = yield* repository.getById({ sessionId: sliding.sessionId });
        const fixedRow = yield* repository.getById({ sessionId: fixed.sessionId });

        expect(Option.isSome(slidingRow) && slidingRow.value.renewalPolicy).toBe("sliding");
        expect(Option.isSome(fixedRow) && fixedRow.value.renewalPolicy).toBe("fixed");
      }),
    );
  });

  it("never slides a session whose persisted policy is fixed", async () => {
    // The row is the only authority on renewability: a token that was minted as sliding must
    // stop sliding the moment its row says otherwise, with no re-derivation from its claims.
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });
        yield* setPersistedRenewalPolicy(issued.sessionId, "fixed");

        yield* TestClock.adjust(Duration.days(2));
        const verified = yield* sessions.verify(issued.token);

        expect(DateTime.toEpochMillis(verified.expiresAt!)).toBe(
          DateTime.toEpochMillis(issued.expiresAt),
        );
        const active = yield* sessions.listActive();
        expect(DateTime.toEpochMillis(active[0]!.expiresAt)).toBe(
          DateTime.toEpochMillis(issued.expiresAt),
        );
      }),
    );
  });

  it("keeps renewing a sliding session issued under a different default TTL", async () => {
    // Stands in for the default TTL constant changing after a session was issued: this row's
    // lifetime is nothing like the current default, and the old `exp - iat === DEFAULT_TTL`
    // inference would have quietly stopped renewing it. The persisted policy governs instead.
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({
          method: "bearer-session-token",
          ttl: Duration.days(10),
        });
        yield* setPersistedRenewalPolicy(issued.sessionId, "sliding");

        yield* TestClock.adjust(Duration.days(2));
        const verified = yield* sessions.verify(issued.token);
        const nowMillis = yield* Clock.currentTimeMillis;

        expect(DateTime.toEpochMillis(verified.expiresAt!)).toBe(nowMillis + SESSION_TTL_MILLIS);
        const active = yield* sessions.listActive();
        expect(DateTime.toEpochMillis(active[0]!.expiresAt)).toBe(nowMillis + SESSION_TTL_MILLIS);
      }),
    );
  });

  it("stamps a sliding token's claims with the absolute lifetime cap", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const sliding = yield* sessions.issue({ method: "bearer-session-token" });
        const fixed = yield* sessions.issue({
          method: "bearer-session-token",
          ttl: Duration.days(10),
        });

        const slidingClaims = decodeSessionTokenClaims(sliding.token);
        expect(slidingClaims.exp - slidingClaims.iat).toBe(SESSION_ABSOLUTE_LIFETIME_MILLIS);
        // A sliding row can never outlive its claims, so the backstop can never fight renewal.
        expect(DateTime.toEpochMillis(sliding.expiresAt)).toBeLessThan(slidingClaims.exp);

        const fixedClaims = decodeSessionTokenClaims(fixed.token);
        expect(fixedClaims.exp).toBe(DateTime.toEpochMillis(fixed.expiresAt));
      }),
    );
  });

  it("rejects a token past its claimed expiry even when its row is still live", async () => {
    // Independent backstop for any future path that verifies a token without loading its row.
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const repository = yield* AuthSessionRepository;
        const issued = yield* sessions.issue({
          method: "bearer-session-token",
          ttl: Duration.hours(1),
        });
        expect(
          yield* repository.extendExpiry({
            sessionId: issued.sessionId,
            expiresAt: DateTime.addDuration(DateTime.toUtc(issued.expiresAt), Duration.days(30)),
          }),
        ).toBe(true);

        yield* TestClock.adjust(Duration.hours(2));

        const error = yield* Effect.flip(sessions.verify(issued.token));
        expect(error.message).toContain("Session token expired");
        // The row really did outlive the claims: only the claims check rejected the token.
        const row = yield* repository.getById({ sessionId: issued.sessionId });
        const nowMillis = yield* Clock.currentTimeMillis;
        expect(Option.isSome(row)).toBe(true);
        if (Option.isSome(row)) {
          expect(DateTime.toEpochMillis(row.value.expiresAt)).toBeGreaterThan(nowMillis);
        }
      }),
    );
  });

  it("never renews a session issued with a non-default lifetime", async () => {
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({
          method: "bearer-session-token",
          ttl: Duration.days(10),
        });

        yield* TestClock.adjust(Duration.days(2));
        const verified = yield* sessions.verify(issued.token);

        expect(DateTime.toEpochMillis(verified.expiresAt!)).toBe(
          DateTime.toEpochMillis(issued.expiresAt),
        );
        const active = yield* sessions.listActive();
        expect(DateTime.toEpochMillis(active[0]!.expiresAt)).toBe(
          DateTime.toEpochMillis(issued.expiresAt),
        );
      }),
    );
  });

  it("stops sliding a continuously used session at its absolute lifetime", async () => {
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });
        const issuedAtMillis = DateTime.toEpochMillis((yield* sessions.listActive())[0]!.issuedAt);
        const capMillis = issuedAtMillis + SESSION_ABSOLUTE_LIFETIME_MILLIS;

        // Each step clears the one-day renewal throttle and stays inside the 30-day window,
        // so the session keeps sliding until the cap stops it.
        for (let step = 0; step < 12; step += 1) {
          yield* TestClock.adjust(Duration.days(29));
          const verified = yield* sessions.verify(issued.token);
          expect(DateTime.toEpochMillis(verified.expiresAt!)).toBeLessThanOrEqual(capMillis);
          const active = yield* sessions.listActive();
          expect(DateTime.toEpochMillis(active[0]!.expiresAt)).toBeLessThanOrEqual(capMillis);
        }

        const nowMillis = yield* Clock.currentTimeMillis;
        expect(nowMillis).toBeGreaterThan(issuedAtMillis + Duration.toMillis(Duration.days(340)));
        expect(DateTime.toEpochMillis((yield* sessions.listActive())[0]!.expiresAt)).toBe(
          capMillis,
        );

        yield* TestClock.adjust(Duration.millis(capMillis - nowMillis + 1));
        const error = yield* Effect.flip(sessions.verify(issued.token));
        expect(error.message).toContain("Session token expired");
      }),
    );
  });

  it("never renews a revoked session", async () => {
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const repository = yield* AuthSessionRepository;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });
        yield* sessions.revoke(issued.sessionId);

        yield* TestClock.adjust(Duration.days(2));

        const error = yield* Effect.flip(sessions.verify(issued.token));
        expect(error.message).toContain("revoked");
        const row = yield* repository.getById({ sessionId: issued.sessionId });
        expect(Option.isSome(row)).toBe(true);
        if (Option.isSome(row)) {
          expect(DateTime.toEpochMillis(row.value.expiresAt)).toBe(
            DateTime.toEpochMillis(issued.expiresAt),
          );
        }
        expect(
          yield* repository.extendExpiry({
            sessionId: issued.sessionId,
            expiresAt: DateTime.addDuration(DateTime.toUtc(issued.expiresAt), Duration.days(10)),
          }),
        ).toBe(false);
      }),
    );
  });

  it("moves session expiry monotonically", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const repository = yield* AuthSessionRepository;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });
        const expiresAt = DateTime.toUtc(issued.expiresAt);

        expect(
          yield* repository.extendExpiry({
            sessionId: issued.sessionId,
            expiresAt: DateTime.subtractDuration(expiresAt, Duration.days(1)),
          }),
        ).toBe(false);
        expect(
          yield* repository.extendExpiry({
            sessionId: issued.sessionId,
            expiresAt: DateTime.addDuration(expiresAt, Duration.days(1)),
          }),
        ).toBe(true);

        const active = yield* sessions.listActive();
        expect(DateTime.toEpochMillis(active[0]!.expiresAt)).toBe(
          DateTime.toEpochMillis(expiresAt) + Duration.toMillis(Duration.days(1)),
        );
      }),
    );
  });

  it("issues and verifies media tokens for active sessions", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });
        const media = yield* sessions.issueMediaToken(issued.sessionId);
        const verified = yield* sessions.verifyMediaToken(media.token);

        expect(verified.sessionId).toBe(issued.sessionId);
        expect(verified.method).toBe("bearer-session-token");
      }),
    );
  });

  it("keeps a media token replayable for its whole lifetime", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        const media = yield* sessions.issueMediaToken(issued.sessionId);

        // Unlike a websocket ticket this is deliberately not single-use: one rendered `<img src>`
        // is retried, range-requested and reloaded, all against the same URL.
        const attempts = yield* Effect.forEach(
          Array.from({ length: 8 }),
          () => sessions.verifyMediaToken(media.token).pipe(Effect.exit),
          { concurrency: "unbounded" },
        );
        expect(attempts.filter((attempt) => attempt._tag === "Success")).toHaveLength(8);
      }),
    );
  });

  it("rejects a media token once it expires", async () => {
    await runSessionTestWithTestClock(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        const media = yield* sessions.issueMediaToken(issued.sessionId, {
          ttl: Duration.minutes(15),
        });

        yield* TestClock.adjust(Duration.minutes(16));

        const error = yield* Effect.flip(sessions.verifyMediaToken(media.token));
        expect(error.message).toContain("Media token expired");
      }),
    );
  });

  it("rejects a media token as soon as its session is revoked", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        const media = yield* sessions.issueMediaToken(issued.sessionId);

        yield* sessions.revoke(issued.sessionId);

        // Statelessness stops at the session row: the credential carries no authority of its own,
        // so revoking the session it names kills every URL it was ever pasted into.
        const error = yield* Effect.flip(sessions.verifyMediaToken(media.token));
        expect(error.message).toContain("Media session revoked");
      }),
    );
  });

  it("never outlives the session it was minted for", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ ttl: Duration.minutes(2) });
        const media = yield* sessions.issueMediaToken(issued.sessionId, {
          ttl: Duration.minutes(15),
        });

        expect(DateTime.toEpochMillis(media.expiresAt)).toBe(
          DateTime.toEpochMillis(issued.expiresAt),
        );
      }),
    );
  });

  it("refuses to mint for an unknown or revoked session", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        yield* sessions.revoke(issued.sessionId);

        const revoked = yield* Effect.flip(sessions.issueMediaToken(issued.sessionId));
        expect(revoked.message).toContain("Media session revoked");
      }),
    );
  });

  it("keeps the three token families non-substitutable", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ method: "bearer-session-token" });
        const media = yield* sessions.issueMediaToken(issued.sessionId);
        const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

        // All three are signed with the same key, so only the literal discriminants in their
        // claims stop a read-only capability from being replayed as a session.
        expect((yield* Effect.flip(sessions.verify(media.token))).message).toContain(
          "Invalid session token payload",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(media.token))).message).toContain(
          "Invalid websocket token payload",
        );
        expect((yield* Effect.flip(sessions.verifyMediaToken(issued.token))).message).toContain(
          "Invalid media token payload",
        );
        expect((yield* Effect.flip(sessions.verifyMediaToken(websocket.token))).message).toContain(
          "Invalid media token payload",
        );
      }),
    );
  });

  it("rejects a media token whose signature does not check out", async () => {
    await runSessionTest(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue();
        const media = yield* sessions.issueMediaToken(issued.sessionId);
        const [payload] = media.token.split(".");

        expect(
          (yield* Effect.flip(sessions.verifyMediaToken(`${payload}.forged`))).message,
        ).toContain("Invalid media token signature");
        expect((yield* Effect.flip(sessions.verifyMediaToken("nope"))).message).toContain(
          "Malformed media token",
        );
      }),
    );
  });
});
