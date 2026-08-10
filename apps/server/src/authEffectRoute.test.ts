import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AUTH_MEDIA_TOKEN_QUERY_PARAM, AuthSessionId } from "@synara/contracts";
import { SYNARA_DESKTOP_ORIGIN } from "@synara/shared/desktopIdentity";
import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
} from "@synara/shared/binaryTransfer";
import { SYNARA_MOBILE_APP_ORIGIN } from "@synara/shared/mobileIdentity";
import { DateTime, Duration, Effect, Exit, Layer, Option, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "./auth/Layers/SessionCredentialService";
import { AuthError, ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import {
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "./auth/Services/SessionCredentialService";
import { ServerConfig, type ServerConfigShape } from "./config";
import { ManagedAttachmentRepositoryLive } from "./persistence/Layers/ManagedAttachments";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import {
  AUTH_JSON_BODY_MAX_BYTES,
  authEffectRouteLayer,
  binaryUploadEffectRouteLayer,
  threadExportEffectRouteLayer,
} from "./http";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";

const currentSessionId = AuthSessionId.makeUnsafe("11111111-1111-4111-8111-111111111111");
const otherSessionId = AuthSessionId.makeUnsafe("22222222-2222-4222-8222-222222222222");
// Fixed so tests can assert the exact `Expires=` the session route re-stamps onto the cookie.
const sessionExpiresAt = DateTime.makeUnsafe("2027-03-04T05:06:07.000Z");

function makeSessionCredentialService(): SessionCredentialServiceShape {
  return {
    cookieName: "synara_session",
  } as SessionCredentialServiceShape;
}

// A real session stack (signing key, database, renewal) for the one route test that must
// exercise renewal end to end rather than assert against a stubbed expiry.
const sessionCredentialTestLayer = SessionCredentialServiceLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "synara-auth-route-session-test-" }),
  ),
  Layer.provide(NodeServices.layer),
);

const descriptor = {
  policy: "remote-reachable" as const,
  bootstrapMethods: ["one-time-token" as const],
  sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
  sessionCookieName: "synara_session",
};

function makeServerAuth(sideEffects: { count: number }): ServerAuthShape {
  const expiresAt = sessionExpiresAt;
  const mutate = <A>(value: A) =>
    Effect.sync(() => {
      sideEffects.count += 1;
      return value;
    });
  const authenticateHttpRequest: ServerAuthShape["authenticateHttpRequest"] = (request) => {
    const bearer = request.headers.authorization === "Bearer bearer-token";
    const cookie = request.cookies.synara_session === "cookie-token";
    if (!bearer && !cookie) {
      return Effect.fail(new AuthError({ message: "Authentication required.", status: 401 }));
    }
    return Effect.succeed({
      sessionId: currentSessionId,
      subject: "owner",
      method: bearer ? "bearer-session-token" : "browser-session-cookie",
      role: "owner",
      expiresAt,
      credentialSource: bearer ? "bearer" : "cookie",
    });
  };
  return {
    getDescriptor: () => Effect.succeed(descriptor),
    // Mirrors the real ServerAuth: bearer wins over cookie, either authenticates alone.
    getSessionState: (request) => {
      const bearer = request.headers.authorization === "Bearer bearer-token";
      const cookie = request.cookies.synara_session === "cookie-token";
      if (!bearer && !cookie) {
        return Effect.succeed({ authenticated: false, auth: descriptor });
      }
      return Effect.succeed({
        authenticated: true,
        auth: descriptor,
        role: "owner" as const,
        sessionMethod: bearer
          ? ("bearer-session-token" as const)
          : ("browser-session-cookie" as const),
        expiresAt,
      });
    },
    exchangeBootstrapCredential: () =>
      mutate({
        response: {
          authenticated: true,
          role: "owner",
          sessionMethod: "browser-session-cookie",
          expiresAt,
        },
        sessionToken: "cookie-token",
      }),
    exchangeBootstrapCredentialForBearerSession: () =>
      mutate({
        authenticated: true,
        role: "owner",
        sessionMethod: "bearer-session-token",
        expiresAt,
        sessionToken: "bearer-token",
      }),
    issuePairingCredential: () =>
      mutate({ id: "pairing-id", credential: "PAIRINGTOKEN", expiresAt }),
    listPairingLinks: () => Effect.succeed([]),
    revokePairingLink: () => mutate(true),
    listClientSessions: () => Effect.succeed([]),
    revokeClientSession: () => mutate(true),
    revokeOtherClientSessions: () => mutate(1),
    logoutSession: () => mutate(true),
    authenticateHttpRequest,
    authenticateWebSocketUpgrade: () =>
      Effect.fail(new AuthError({ message: "Not used in auth route tests.", status: 401 })),
    // Mirrors the real media guard: a `mediaToken` query parameter authenticates on its own, and
    // otherwise it falls through to the session. Deliberately more permissive than
    // `authenticateHttpRequest` so the thread-export tests below can prove which guard that route
    // actually runs.
    authenticateMediaHttpRequest: (request) =>
      request.url?.searchParams.get(AUTH_MEDIA_TOKEN_QUERY_PARAM) === "media-token"
        ? Effect.succeed({
            sessionId: currentSessionId,
            subject: "owner",
            method: "bearer-session-token",
            role: "client",
            expiresAt,
            credentialSource: "bearer",
          })
        : authenticateHttpRequest(request),
    issueWebSocketToken: () => mutate({ token: "ws-token", expiresAt }),
    issueMediaToken: () => mutate({ token: "media-token", expiresAt }),
    issueStartupPairingUrl: () =>
      Effect.succeed("https://synara.example.test/pair#token=PAIRINGTOKEN"),
  } satisfies ServerAuthShape;
}

async function withAuthEffectServer(
  config: ServerConfigShape,
  serverAuth: ServerAuthShape,
  run: (origin: string) => Promise<void>,
  routeLayer:
    | typeof authEffectRouteLayer
    | typeof binaryUploadEffectRouteLayer
    | typeof threadExportEffectRouteLayer = authEffectRouteLayer,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  try {
    const services = await Effect.runPromise(
      Layer.buildWithScope(
        Layer.mergeAll(
          Layer.succeed(ServerConfig, config),
          Layer.succeed(ServerAuth, serverAuth),
          Layer.succeed(SessionCredentialService, makeSessionCredentialService()),
          Layer.succeed(ProviderAdapterRegistry, {
            getByProvider: () => Effect.die("voice adapter not used in this test"),
            listProviders: () => Effect.succeed([]),
          }),
          // Every thread is absent: these tests are about which credential opens the route, and a
          // 404 already proves the request got past the guard.
          Layer.succeed(ProjectionSnapshotQuery, {
            getThreadDetailForExportById: () => Effect.succeed(Option.none()),
          } as unknown as ProjectionSnapshotQueryShape),
          ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
          NodeServices.layer,
        ),
        scope,
      ),
    );
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          if (routeLayer === authEffectRouteLayer) {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(authEffectRouteLayer));
          } else if (routeLayer === binaryUploadEffectRouteLayer) {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(binaryUploadEffectRouteLayer));
          } else {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(threadExportEffectRouteLayer));
          }
        }).pipe(Effect.provideServices(services)),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("Expected server address");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

const mutationRoutes: ReadonlyArray<{ readonly path: string; readonly body?: unknown }> = [
  { path: "/api/auth/ws-token" },
  { path: "/api/auth/media-token" },
  { path: "/api/auth/pairing-token" },
  { path: "/api/auth/pairing-links/revoke", body: { id: "pairing-id" } },
  { path: "/api/auth/clients/revoke", body: { sessionId: otherSessionId } },
  { path: "/api/auth/clients/revoke-others" },
  { path: "/api/auth/logout" },
] as const;

function mutationRequest(input: {
  readonly origin?: string;
  readonly credential: "bearer" | "cookie";
  readonly body?: unknown;
}): RequestInit {
  return {
    method: "POST",
    headers: {
      ...(input.origin === undefined ? {} : { Origin: input.origin }),
      ...(input.credential === "bearer"
        ? { Authorization: "Bearer bearer-token" }
        : { Cookie: "synara_session=cookie-token" }),
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  };
}

describe("authEffectRouteLayer", () => {
  it("serves CORS preflight and response headers to the trusted desktop origin", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "0.0.0.0", publicUrl: undefined, mode: "desktop" } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const preflight = await fetch(`${serverOrigin}/api/auth/bootstrap/bearer`, {
        method: "OPTIONS",
        headers: {
          Origin: SYNARA_DESKTOP_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(SYNARA_DESKTOP_ORIGIN);
      expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
      expect(sideEffects.count).toBe(0);

      const bearerExchange = await fetch(`${serverOrigin}/api/auth/bootstrap/bearer`, {
        method: "POST",
        headers: { Origin: SYNARA_DESKTOP_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "PAIRINGTOKEN" }),
      });
      expect(bearerExchange.status).toBe(200);
      expect(bearerExchange.headers.get("access-control-allow-origin")).toBe(SYNARA_DESKTOP_ORIGIN);
      expect(sideEffects.count).toBe(1);

      const untrustedPreflight = await fetch(`${serverOrigin}/api/auth/bootstrap/bearer`, {
        method: "OPTIONS",
        headers: { Origin: "http://evil.example.test" },
      });
      expect(untrustedPreflight.status).toBe(403);
    });
  });

  it("serves CORS preflight and bearer bootstrap to the trusted mobile shell origin", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "0.0.0.0", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const preflight = await fetch(`${serverOrigin}/api/auth/bootstrap/bearer`, {
        method: "OPTIONS",
        headers: {
          Origin: SYNARA_MOBILE_APP_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(SYNARA_MOBILE_APP_ORIGIN);
      expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
      expect(sideEffects.count).toBe(0);

      const bearerExchange = await fetch(`${serverOrigin}/api/auth/bootstrap/bearer`, {
        method: "POST",
        headers: { Origin: SYNARA_MOBILE_APP_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "PAIRINGTOKEN" }),
      });
      expect(bearerExchange.status).toBe(200);
      expect(bearerExchange.headers.get("access-control-allow-origin")).toBe(
        SYNARA_MOBILE_APP_ORIGIN,
      );
      expect(sideEffects.count).toBe(1);

      const lookalikePreflight = await fetch(`${serverOrigin}/api/auth/bootstrap/bearer`, {
        method: "OPTIONS",
        headers: { Origin: "https://app.synara.local.evil.example" },
      });
      expect(lookalikePreflight.status).toBe(403);
    });
  });

  it("re-stamps the cookie with the renewed expiry on cookie-authenticated state probes", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const response = await fetch(`${serverOrigin}/api/auth/session`, {
        headers: { Cookie: "synara_session=cookie-token" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("synara_session=cookie-token");
      expect(cookie).toContain(`Expires=${DateTime.toDate(sessionExpiresAt).toUTCString()}`);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).not.toContain("Secure");
    });
  });

  it("re-stamps the cookie with the expiry a real cookie session slid to", async () => {
    // End-to-end counterpart to the stubbed probe above: a genuine browser-session-cookie
    // credential, verified by the real SessionCredentialService, must renew on this probe and
    // the route must hand the browser the renewed `Expires` — otherwise the cookie jar evicts
    // a session the server still considers live.
    const scope = await Effect.runPromise(Scope.make("sequential"));
    try {
      const sessionServices = await Effect.runPromise(
        Layer.buildWithScope(sessionCredentialTestLayer, scope),
      );
      const provideSessionServices = <A, E>(
        effect: Effect.Effect<A, E, SessionCredentialService | SqlClient.SqlClient>,
      ) => Effect.runPromise(Effect.provideServices(effect, sessionServices));

      const { sessions, issued, agedExpiresAtMillis } = await provideSessionServices(
        Effect.gen(function* () {
          const sessions = yield* SessionCredentialService;
          const sql = yield* SqlClient.SqlClient;
          const issued = yield* sessions.issue({ method: "browser-session-cookie" });
          // Ages the row so the next use clears the renewal throttle. Only raw SQL can move an
          // expiry backwards — `extendExpiry` is monotonic by design — and this is exactly what
          // a session issued weeks ago looks like on disk.
          const agedExpiresAt = DateTime.addDuration(yield* DateTime.now, Duration.days(1));
          yield* sql`
            UPDATE auth_sessions
            SET expires_at = ${DateTime.formatIso(agedExpiresAt)}
            WHERE session_id = ${issued.sessionId}
          `;
          return {
            sessions,
            issued,
            agedExpiresAtMillis: DateTime.toEpochMillis(agedExpiresAt),
          };
        }),
      );

      const serverAuth: ServerAuthShape = {
        ...makeServerAuth({ count: 0 }),
        getSessionState: (request) => {
          const cookieToken = request.cookies.synara_session;
          if (cookieToken === undefined) {
            return Effect.succeed({ authenticated: false, auth: descriptor });
          }
          return sessions.verify(cookieToken).pipe(
            Effect.map((verified) =>
              verified.expiresAt === undefined
                ? { authenticated: false, auth: descriptor }
                : {
                    authenticated: true,
                    auth: descriptor,
                    role: verified.role,
                    sessionMethod: verified.method,
                    expiresAt: DateTime.toUtc(verified.expiresAt),
                  },
            ),
            Effect.catchCause(() => Effect.succeed({ authenticated: false, auth: descriptor })),
          );
        },
      };

      const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
      await withAuthEffectServer(config, serverAuth, async (serverOrigin) => {
        const response = await fetch(`${serverOrigin}/api/auth/session`, {
          headers: { Cookie: `synara_session=${issued.token}` },
        });
        expect(response.status).toBe(200);

        const [active] = await Effect.runPromise(sessions.listActive());
        expect(DateTime.toEpochMillis(active!.expiresAt)).toBeGreaterThan(
          agedExpiresAtMillis + Duration.toMillis(Duration.days(20)),
        );
        const cookie = response.headers.get("set-cookie") ?? "";
        expect(cookie).toContain(`synara_session=${encodeURIComponent(issued.token)}`);
        expect(cookie).toContain(`Expires=${DateTime.toDate(active!.expiresAt).toUTCString()}`);
      });
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });

  it("stamps Secure on the renewed cookie when the server is publicly reachable", async () => {
    const sideEffects = { count: 0 };
    const config = {
      host: "0.0.0.0",
      publicUrl: new URL("https://synara.example.test/"),
    } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const response = await fetch(`${serverOrigin}/api/auth/session`, {
        headers: { Cookie: "synara_session=cookie-token" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie") ?? "").toContain("Secure");
    });
  });

  it("never stamps a cookie on bearer, ambiguous, or unauthenticated state probes", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      // Bearer-authenticated: the reported expiry belongs to the bearer session.
      const bearerResponse = await fetch(`${serverOrigin}/api/auth/session`, {
        headers: { Authorization: "Bearer bearer-token" },
      });
      expect(bearerResponse.status).toBe(200);
      expect(bearerResponse.headers.get("cache-control")).toBe("no-store");
      expect(bearerResponse.headers.get("set-cookie")).toBeNull();

      // Both credentials present: bearer wins auth, so the cookie's own expiry is unknown.
      const ambiguousResponse = await fetch(`${serverOrigin}/api/auth/session`, {
        headers: {
          Authorization: "Bearer bearer-token",
          Cookie: "synara_session=cookie-token",
        },
      });
      expect(ambiguousResponse.status).toBe(200);
      expect(ambiguousResponse.headers.get("cache-control")).toBe("no-store");
      expect(ambiguousResponse.headers.get("set-cookie")).toBeNull();

      // Unauthenticated probe: nothing to renew, and no cookie may be minted from thin air.
      const anonymousResponse = await fetch(`${serverOrigin}/api/auth/session`);
      expect(anonymousResponse.status).toBe(200);
      expect(anonymousResponse.headers.get("cache-control")).toBe("no-store");
      expect(anonymousResponse.headers.get("set-cookie")).toBeNull();
    });
  });

  it("rejects declared and chunked oversized bootstrap JSON before auth exchange", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const oversizedBody = JSON.stringify({
        credential: "x".repeat(AUTH_JSON_BODY_MAX_BYTES),
      });
      const declaredResponse = await fetch(`${serverOrigin}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversizedBody,
      });
      expect(declaredResponse.status).toBe(413);
      expect(sideEffects.count).toBe(0);

      const chunkedStatus = await new Promise<number>((resolve, reject) => {
        const url = new URL("/api/auth/bootstrap", serverOrigin);
        const request = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Transfer-Encoding": "chunked",
            },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          },
        );
        request.once("error", reject);
        request.write('{"credential":"');
        request.write("x".repeat(AUTH_JSON_BODY_MAX_BYTES));
        request.end('"}');
      });
      expect(chunkedStatus).toBe(413);
      expect(sideEffects.count).toBe(0);

      const malformedResponse = await fetch(`${serverOrigin}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      expect(malformedResponse.status).toBe(400);

      const validResponse = await fetch(`${serverOrigin}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "PAIRINGTOKEN" }),
      });
      expect(validResponse.status).toBe(200);
      expect(sideEffects.count).toBe(1);
    });
  });

  it("rejects every cookie-authenticated mutation without a trusted origin", async () => {
    const sideEffects = { count: 0 };
    const config = {
      host: "0.0.0.0",
      publicUrl: new URL("https://synara.example.test/"),
    } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      for (const route of mutationRoutes) {
        for (const origin of [
          undefined,
          "null",
          "not a url",
          "https://evil.example.test",
          "https://cross-site.invalid",
        ]) {
          const response = await fetch(
            `${serverOrigin}${route.path}`,
            mutationRequest({
              ...(origin === undefined ? {} : { origin }),
              credential: "cookie",
              ...(route.body === undefined ? {} : { body: route.body }),
            }),
          );
          expect(response.status, `${route.path} with ${String(origin)}`).toBe(403);
        }
        for (const origin of [
          "null",
          "not a url",
          "https://evil.example.test",
          "https://cross-site.invalid",
        ]) {
          const response = await fetch(
            `${serverOrigin}${route.path}`,
            mutationRequest({
              origin,
              credential: "bearer",
              ...(route.body === undefined ? {} : { body: route.body }),
            }),
          );
          expect(response.status, `${route.path} bearer with ${origin}`).toBe(403);
        }
      }
      expect(sideEffects.count).toBe(0);
    });
  });

  it("allows trusted-origin cookies and originless explicit bearer credentials", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      for (const route of mutationRoutes) {
        const body = route.body === undefined ? {} : { body: route.body };
        const cookieResponse = await fetch(
          `${serverOrigin}${route.path}`,
          mutationRequest({ origin: serverOrigin, credential: "cookie", ...body }),
        );
        expect(cookieResponse.status, `${route.path} cookie`).toBe(200);

        const bearerResponse = await fetch(
          `${serverOrigin}${route.path}`,
          mutationRequest({ credential: "bearer", ...body }),
        );
        expect(bearerResponse.status, `${route.path} bearer`).toBe(200);
      }
      expect(sideEffects.count).toBe(mutationRoutes.length * 2);
    });
  });

  it("mints media credentials only for an authenticated session, and never caches them", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const anonymous = await fetch(`${serverOrigin}/api/auth/media-token`, {
        method: "POST",
        headers: { Origin: serverOrigin },
      });
      expect(anonymous.status).toBe(401);
      expect(sideEffects.count).toBe(0);

      const authenticated = await fetch(
        `${serverOrigin}/api/auth/media-token`,
        mutationRequest({ credential: "bearer" }),
      );
      expect(authenticated.status).toBe(200);
      await expect(authenticated.json()).resolves.toMatchObject({ token: "media-token" });
      // A bearer capability in a body: no proxy, and no browser, gets to keep a copy.
      expect(authenticated.headers.get("cache-control")).toBe("no-store");
      expect(sideEffects.count).toBe(1);
    });
  });

  it("logs out either role and clears the exact cookie with secure public-mode attributes", async () => {
    const sideEffects = { count: 0 };
    const config = {
      host: "0.0.0.0",
      publicUrl: new URL("https://synara.example.test/"),
    } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const response = await fetch(
        `${serverOrigin}/api/auth/logout`,
        mutationRequest({
          origin: "https://synara.example.test",
          credential: "cookie",
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ revoked: true });
      const cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("synara_session=");
      expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Secure");
      expect(sideEffects.count).toBe(1);
    });
  });
});

describe("binaryUploadEffectRouteLayer", () => {
  it("allows credentialed Canary attachment upload preflights", async () => {
    const config = {
      host: "127.0.0.1",
      attachmentsDir: fs.mkdtempSync(path.join(os.tmpdir(), "synara-upload-cors-")),
    } as ServerConfigShape;
    try {
      await withAuthEffectServer(
        config,
        makeServerAuth({ count: 0 }),
        async (serverOrigin) => {
          const response = await fetch(`${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}`, {
            method: "OPTIONS",
            headers: {
              Origin: "synara-canary://app",
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers": "authorization, content-type",
            },
          });

          expect(response.status).toBe(204);
          expect(response.headers.get("access-control-allow-origin")).toBe("synara-canary://app");
          expect(response.headers.get("access-control-allow-credentials")).toBe("true");
          expect(response.headers.get("access-control-allow-methods")).toContain("POST");
          const allowedHeaders =
            response.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
          expect(allowedHeaders).toContain("content-type");
          // The mobile shell has no cookie for this origin, so its upload carries a bearer.
          expect(allowedHeaders).toContain("authorization");
        },
        binaryUploadEffectRouteLayer,
      );
    } finally {
      fs.rmSync(config.attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects ambient cookie uploads without an origin and accepts explicit bearer auth", async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-upload-route-"));
    const config = {
      host: "0.0.0.0",
      publicUrl: new URL("https://synara.example.test/"),
      attachmentsDir,
    } as ServerConfigShape;
    try {
      await withAuthEffectServer(
        config,
        makeServerAuth({ count: 0 }),
        async (serverOrigin) => {
          const params = new URLSearchParams({
            type: "image",
            threadId: "thread-1",
            name: "screen.png",
            mimeType: "image/png",
          });
          const url = `${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}?${params.toString()}`;
          const cookieResponse = await fetch(url, {
            method: "POST",
            headers: { Cookie: "synara_session=cookie-token" },
            body: Uint8Array.from([1]),
          });
          expect(cookieResponse.status).toBe(403);
          expect(fs.readdirSync(attachmentsDir)).toEqual([]);

          const oversizedStatus = await new Promise<number>((resolve, reject) => {
            const target = new URL(url);
            const request = http.request(
              {
                hostname: target.hostname,
                port: target.port,
                path: `${target.pathname}${target.search}`,
                method: "POST",
                headers: {
                  Authorization: "Bearer bearer-token",
                  "Content-Length": String(10 * 1024 * 1024 + 1),
                },
              },
              (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode ?? 0));
              },
            );
            request.once("error", reject);
            request.end();
          });
          expect(oversizedStatus).toBe(413);
          expect(fs.readdirSync(attachmentsDir)).toEqual([]);

          const bearerResponse = await fetch(url, {
            method: "POST",
            headers: { Authorization: "Bearer bearer-token" },
            body: Uint8Array.from([1]),
          });
          const bearerPayload = (await bearerResponse.json()) as {
            readonly error?: unknown;
            readonly id?: unknown;
          };
          expect(bearerResponse.status, JSON.stringify(bearerPayload)).toBe(201);
          expect(bearerPayload).toEqual(expect.objectContaining({ type: "image", sizeBytes: 1 }));
          expect(
            fs
              .readdirSync(path.join(attachmentsDir, "objects"), { recursive: true })
              .some((entry) => String(entry).endsWith(`${String(bearerPayload.id)}.png`)),
          ).toBe(true);
          expect(fs.readdirSync(path.join(attachmentsDir, ".staging"))).toEqual([]);

          const cancel = () =>
            fetch(`${serverOrigin}${ATTACHMENT_CANCEL_ROUTE_PATH}`, {
              method: "POST",
              headers: {
                Authorization: "Bearer bearer-token",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ attachmentId: bearerPayload.id }),
            });
          expect((await cancel()).status).toBe(200);
          expect((await cancel()).status).toBe(200);
        },
        binaryUploadEffectRouteLayer,
      );
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns a readable 401 to the mobile shell instead of an opaque failure", async () => {
    // A rejected upload must carry the same CORS headers the success path does. Without
    // Access-Control-Allow-Origin the WebView's fetch() rejects with a network error and never
    // sees the 401 — so the client that should drop a repudiated pairing retries forever instead.
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-upload-401-cors-"));
    const config = {
      host: "0.0.0.0",
      publicUrl: new URL("https://synara.example.test/"),
      attachmentsDir,
    } as ServerConfigShape;
    try {
      await withAuthEffectServer(
        config,
        makeServerAuth({ count: 0 }),
        async (serverOrigin) => {
          const params = new URLSearchParams({
            type: "image",
            threadId: "thread-1",
            name: "screen.png",
            mimeType: "image/png",
          });
          const response = await fetch(
            `${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}?${params.toString()}`,
            {
              method: "POST",
              headers: {
                Origin: SYNARA_MOBILE_APP_ORIGIN,
                Authorization: "Bearer revoked-token",
              },
              body: Uint8Array.from([1]),
            },
          );

          expect(response.status).toBe(401);
          expect(response.headers.get("access-control-allow-origin")).toBe(
            SYNARA_MOBILE_APP_ORIGIN,
          );
          expect(response.headers.get("access-control-allow-credentials")).toBe("true");
          await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
          expect(fs.readdirSync(attachmentsDir)).toEqual([]);
        },
        binaryUploadEffectRouteLayer,
      );
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});

describe("threadExportEffectRouteLayer", () => {
  const exportConfig = {
    host: "0.0.0.0",
    publicUrl: new URL("https://synara.example.test/"),
  } as ServerConfigShape;

  it("refuses a media credential and demands a session", async () => {
    // The media credential is stamped into every <img> URL the mobile shell renders, where query
    // strings leak into logs, screenshots and intermediary caches. A captured favicon URL must not
    // be re-pointable at the transcript archive.
    await withAuthEffectServer(
      exportConfig,
      makeServerAuth({ count: 0 }),
      async (serverOrigin) => {
        const mediaCredentialed = await fetch(
          `${serverOrigin}/api/thread-export?threadId=thread-1&${AUTH_MEDIA_TOKEN_QUERY_PARAM}=media-token`,
          { headers: { Origin: SYNARA_MOBILE_APP_ORIGIN } },
        );
        expect(mediaCredentialed.status).toBe(401);
        // Readable cross-origin, so a revoked device learns it was revoked.
        expect(mediaCredentialed.headers.get("access-control-allow-origin")).toBe(
          SYNARA_MOBILE_APP_ORIGIN,
        );

        const anonymous = await fetch(`${serverOrigin}/api/thread-export?threadId=thread-1`);
        expect(anonymous.status).toBe(401);

        // The same request with a real session gets past the guard — 404 because the stubbed
        // projection holds no threads, which is the point: authentication is no longer the answer.
        const session = await fetch(`${serverOrigin}/api/thread-export?threadId=thread-1`, {
          headers: { Authorization: "Bearer bearer-token" },
        });
        expect(session.status).toBe(404);
      },
      threadExportEffectRouteLayer,
    );
  });
});
