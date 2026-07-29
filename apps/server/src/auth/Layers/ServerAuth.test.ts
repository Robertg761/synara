import * as NodeServices from "@effect/platform-node/NodeServices";
import { MOBILE_AUTH_AUDIENCE } from "@synara/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { AuthControlPlaneLive } from "./AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./BootstrapCredentialService";
import { ServerAuthLive, toBootstrapExchangeAuthError } from "./ServerAuth";
import { ServerAuthPolicyLive } from "./ServerAuthPolicy";
import { ServerSecretStoreLive } from "./ServerSecretStore";
import { SessionCredentialServiceLive } from "./SessionCredentialService";
import { BootstrapCredentialError } from "../Services/BootstrapCredentialService";
import { AuthError, ServerAuth, type AuthRequest } from "../Services/ServerAuth";
import { authenticateRpcWebSocketUpgrade } from "../../wsRpc";

const sessionCredentialLayer = SessionCredentialServiceLive.pipe(
  Layer.provide(ServerSecretStoreLive),
);
const authControlPlaneLayer = AuthControlPlaneLive.pipe(
  Layer.provide(BootstrapCredentialServiceLive),
  Layer.provide(sessionCredentialLayer),
);
const testLayer = ServerAuthLive.pipe(
  Layer.provide(ServerAuthPolicyLive),
  Layer.provide(BootstrapCredentialServiceLive),
  Layer.provide(sessionCredentialLayer),
  Layer.provide(authControlPlaneLayer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-auth-server-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

function makeCookieRequest(sessionToken: string): AuthRequest {
  return {
    headers: {},
    cookies: {
      synara_session: sessionToken,
    },
  };
}

const runServerAuthTest = (effect: Effect.Effect<void, AuthError, ServerAuth>) =>
  effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);

describe("ServerAuthLive", () => {
  it("maps invalid bootstrap credential failures to 401", () => {
    const error = toBootstrapExchangeAuthError(
      new BootstrapCredentialError({
        message: "Unknown bootstrap credential.",
        status: 401,
      }),
    );

    expect(error.status).toBe(401);
    expect(error.message).toBe("Invalid bootstrap credential.");
  });

  it("maps unexpected bootstrap failures to 500", () => {
    const error = toBootstrapExchangeAuthError(
      new BootstrapCredentialError({
        message: "Failed to consume bootstrap credential.",
        status: 500,
        cause: new Error("sqlite is unavailable"),
      }),
    );

    expect(error.status).toBe(500);
    expect(error.message).toBe("Failed to validate bootstrap credential.");
  });

  it("issues client pairing credentials by default", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;

        const pairingCredential = yield* serverAuth.issuePairingCredential();
        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          pairingCredential.credential,
          requestMetadata,
        );
        const verified = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(exchanged.sessionToken),
        );

        expect(verified.sessionId.length).toBeGreaterThan(0);
        expect(verified.role).toBe("client");
        expect(verified.subject).toBe("one-time-token");
      }),
    );
  });

  it("issues startup pairing URLs that bootstrap owner sessions", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;

        const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
        const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
        const listedPairingLinks = yield* serverAuth.listPairingLinks();

        expect(token).toBeTruthy();
        expect(
          listedPairingLinks.some((pairingLink) => pairingLink.subject === "owner-bootstrap"),
        ).toBe(false);

        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          token ?? "",
          requestMetadata,
        );
        const verified = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(exchanged.sessionToken),
        );

        expect(verified.role).toBe("owner");
        expect(verified.subject).toBe("owner-bootstrap");
      }),
    );
  });

  it("lists client sessions with the current owner marked", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;

        const ownerPairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
        const ownerToken =
          new URLSearchParams(new URL(ownerPairingUrl).hash.slice(1)).get("token") ?? "";
        const ownerExchange = yield* serverAuth.exchangeBootstrapCredential(
          ownerToken,
          requestMetadata,
        );
        const ownerSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(ownerExchange.sessionToken),
        );

        const pairingCredential = yield* serverAuth.issuePairingCredential({ label: "CI phone" });
        const clientExchange = yield* serverAuth.exchangeBootstrapCredential(
          pairingCredential.credential,
          {
            ...requestMetadata,
            deviceType: "mobile",
            os: "iOS",
            browser: "Safari",
          },
        );
        const clientSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(clientExchange.sessionToken),
        );
        const clients = yield* serverAuth.listClientSessions(ownerSession.sessionId);

        expect(clients).toHaveLength(2);
        expect(clients.find((entry) => entry.sessionId === ownerSession.sessionId)?.current).toBe(
          true,
        );
        expect(clients.find((entry) => entry.sessionId === clientSession.sessionId)?.current).toBe(
          false,
        );
        expect(
          clients.find((entry) => entry.sessionId === clientSession.sessionId)?.client.label,
        ).toBe("CI phone");
      }),
    );
  });

  it("authenticates websocket upgrade tokens issued for a session", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;

        const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
        const bootstrapToken =
          new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token") ?? "";
        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          bootstrapToken,
          requestMetadata,
        );
        const session = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(exchanged.sessionToken),
        );
        const websocketToken = yield* serverAuth.issueWebSocketToken(session);
        const upgraded = yield* serverAuth.authenticateWebSocketUpgrade({
          headers: {},
          cookies: {},
          url: new URL(`ws://127.0.0.1:3773/?wsToken=${websocketToken.token}`),
        });

        expect(upgraded.sessionId).toBe(session.sessionId);
        expect(upgraded.role).toBe("owner");
      }),
    );
  });

  it("prefers an explicit bearer credential and reports its request provenance", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const cookieCredential = yield* serverAuth.issuePairingCredential();
        const cookieSession = yield* serverAuth.exchangeBootstrapCredential(
          cookieCredential.credential,
          requestMetadata,
        );
        const bearerCredential = yield* serverAuth.issuePairingCredential();
        const bearerSession = yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
          bearerCredential.credential,
          requestMetadata,
        );

        const authenticated = yield* serverAuth.authenticateHttpRequest({
          headers: { authorization: `Bearer ${bearerSession.sessionToken}` },
          cookies: { synara_session: cookieSession.sessionToken },
        });

        expect(authenticated.credentialSource).toBe("bearer");
        expect(authenticated.sessionId).not.toBe(
          (yield* serverAuth.authenticateHttpRequest(makeCookieRequest(cookieSession.sessionToken)))
            .sessionId,
        );
      }),
    );
  });

  it("logs out the current session, invalidates its websocket ticket, and preserves others", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const currentCredential = yield* serverAuth.issuePairingCredential();
        const currentExchange = yield* serverAuth.exchangeBootstrapCredential(
          currentCredential.credential,
          requestMetadata,
        );
        const currentSession = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(currentExchange.sessionToken),
        );
        const websocketToken = yield* serverAuth.issueWebSocketToken(currentSession);

        const otherCredential = yield* serverAuth.issuePairingCredential();
        const otherExchange = yield* serverAuth.exchangeBootstrapCredential(
          otherCredential.credential,
          requestMetadata,
        );

        expect(yield* serverAuth.logoutSession(currentSession.sessionId)).toBe(true);
        expect(
          (yield* Effect.flip(
            serverAuth.authenticateHttpRequest(makeCookieRequest(currentExchange.sessionToken)),
          ).pipe(Effect.orDie)).status,
        ).toBe(401);
        expect(
          (yield* Effect.flip(
            serverAuth.authenticateWebSocketUpgrade({
              headers: {},
              cookies: {},
              url: new URL(`ws://127.0.0.1:3773/?wsToken=${websocketToken.token}`),
            }),
          ).pipe(Effect.orDie)).status,
        ).toBe(401);
        expect(
          (yield* serverAuth.authenticateHttpRequest(makeCookieRequest(otherExchange.sessionToken)))
            .credentialSource,
        ).toBe("cookie");
      }),
    );
  });

  it("bootstraps a remote owner session without accepting the legacy websocket token", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const config = {
          host: "0.0.0.0",
          authToken: "remote-startup-secret",
          publicUrl: undefined,
        } as const;

        const legacyError = yield* authenticateRpcWebSocketUpgrade({
          config,
          legacyToken: "remote-startup-secret",
          request: {
            headers: {},
            cookies: {},
            url: new URL("ws://192.168.1.50:3773/ws?token=remote-startup-secret"),
          },
          serverAuth,
        }).pipe(Effect.flip, Effect.orDie);
        expect(legacyError.status).toBe(401);

        const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://192.168.1.50:3773");
        const bootstrapToken =
          new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token") ?? "";
        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          bootstrapToken,
          requestMetadata,
        );
        const upgraded = yield* authenticateRpcWebSocketUpgrade({
          config,
          legacyToken: "remote-startup-secret",
          request: {
            ...makeCookieRequest(exchanged.sessionToken),
            url: new URL("ws://192.168.1.50:3773/ws?token=remote-startup-secret"),
          },
          serverAuth,
        });

        expect(upgraded?.role).toBe("owner");
        expect(upgraded?.subject).toBe("owner-bootstrap");
      }),
    );
  });

  it("carries the pairing audience into the session and admits it only on the mobile route", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const pairing = yield* serverAuth.issuePairingCredential({
          audience: MOBILE_AUTH_AUDIENCE,
          label: "iPhone",
        });
        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          pairing.credential,
          requestMetadata,
        );
        const session = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(exchanged.sessionToken),
        );
        expect(session.audience).toBe(MOBILE_AUTH_AUDIENCE);

        const ticket = yield* serverAuth.issueWebSocketToken(session);
        const upgraded = yield* serverAuth.authenticateWebSocketUpgrade(
          // The ticket rides in the header, never in the URL, so it cannot leak
          // through access logs or a Referer.
          { headers: { authorization: `SynaraTicket ${ticket.token}` }, cookies: {} },
          { requiredAudience: MOBILE_AUTH_AUDIENCE },
        );
        expect(upgraded.sessionId).toBe(session.sessionId);

        const rpcError = yield* authenticateRpcWebSocketUpgrade({
          config: { host: "0.0.0.0", authToken: "remote-startup-secret", publicUrl: undefined },
          legacyToken: null,
          request: makeCookieRequest(exchanged.sessionToken),
          serverAuth,
        }).pipe(Effect.flip, Effect.orDie);
        expect(rpcError.status).toBe(403);
      }),
    );
  });

  it("accepts the legacy Bearer ticket scheme only on the mobile route", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const pairing = yield* serverAuth.issuePairingCredential({
          audience: MOBILE_AUTH_AUDIENCE,
          label: "Legacy iPhone",
        });
        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          pairing.credential,
          requestMetadata,
        );
        const session = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(exchanged.sessionToken),
        );
        const ticket = yield* serverAuth.issueWebSocketToken(session);

        const upgraded = yield* serverAuth.authenticateWebSocketUpgrade(
          { headers: { authorization: `Bearer ${ticket.token}` }, cookies: {} },
          { requiredAudience: MOBILE_AUTH_AUDIENCE },
        );

        expect(upgraded.sessionId).toBe(session.sessionId);
      }),
    );
  });

  it("rejects an interactive credential on the mobile audience", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const pairing = yield* serverAuth.issuePairingCredential();
        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          pairing.credential,
          requestMetadata,
        );
        const session = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(exchanged.sessionToken),
        );
        expect(session.audience).toBe("interactive");

        const ticket = yield* serverAuth.issueWebSocketToken(session);
        const error = yield* serverAuth
          .authenticateWebSocketUpgrade(
            { headers: { authorization: `SynaraTicket ${ticket.token}` }, cookies: {} },
            { requiredAudience: MOBILE_AUTH_AUDIENCE },
          )
          .pipe(Effect.flip, Effect.orDie);

        expect(error.status).toBe(403);
      }),
    );
  });

  it("burns a websocket ticket on its first upgrade", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const pairing = yield* serverAuth.issuePairingCredential({
          audience: MOBILE_AUTH_AUDIENCE,
        });
        const exchanged = yield* serverAuth.exchangeBootstrapCredential(
          pairing.credential,
          requestMetadata,
        );
        const session = yield* serverAuth.authenticateHttpRequest(
          makeCookieRequest(exchanged.sessionToken),
        );
        const ticket = yield* serverAuth.issueWebSocketToken(session);
        const request = {
          headers: { authorization: `SynaraTicket ${ticket.token}` },
          cookies: {},
        };

        yield* serverAuth.authenticateWebSocketUpgrade(request, {
          requiredAudience: MOBILE_AUTH_AUDIENCE,
        });
        const replay = yield* serverAuth
          .authenticateWebSocketUpgrade(request, { requiredAudience: MOBILE_AUTH_AUDIENCE })
          .pipe(Effect.flip, Effect.orDie);

        expect(replay.status).toBe(401);
      }),
    );
  });

  it("never exposes a pairing credential after it is created", async () => {
    await runServerAuthTest(
      Effect.gen(function* () {
        const serverAuth = yield* ServerAuth;
        const pairing = yield* serverAuth.issuePairingCredential({ label: "Listed device" });
        const listed = yield* serverAuth.listPairingLinks();
        const link = listed.find((entry) => entry.id === pairing.id);

        expect(link).toBeDefined();
        expect(JSON.stringify(listed)).not.toContain(pairing.credential);
        expect(link?.credentialHint).toBe(pairing.credentialHint);
      }),
    );
  });
});
