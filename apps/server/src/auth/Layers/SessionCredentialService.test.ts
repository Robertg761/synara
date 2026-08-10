import * as NodeServices from "@effect/platform-node/NodeServices";
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
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { AuthSessionRepository } from "../../persistence/Services/AuthSessions";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
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

const testLayer = SessionCredentialServiceLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-auth-session-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

type SessionTestServices = SessionCredentialService | AuthSessionRepository | Scope.Scope;

const SESSION_TTL_MILLIS = Duration.toMillis(Duration.days(30));
const SESSION_ABSOLUTE_LIFETIME_MILLIS = Duration.toMillis(Duration.days(365));

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
});
