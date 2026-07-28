import { assert, it } from "@effect/vitest";
import type { AuthSessionId, EnvironmentId } from "@synara/contracts";
import { resolveMobileAccess } from "@synara/shared/mobileAccess";
import { Effect } from "effect";

import { DISABLED_MOBILE_ACCESS, type ServerMobileAccessConfig } from "./config";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "./managedAttachmentPrincipal";
import { toMobileAccessStatus } from "./mobile/mobileAccessStatus";
import { provideWsConnectionSession, type WsConnectionSession } from "./wsConnectionSessions";
import { currentWsAuthSessionId, requireWsOwnerRole } from "./wsRpc";

const ENVIRONMENT_ID = "env-local" as EnvironmentId;

function connectionSession(input: {
  readonly role: "owner" | "client";
  readonly authSessionId?: AuthSessionId;
}): WsConnectionSession {
  return {
    role: input.role,
    attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
    ...(input.authSessionId ? { authSessionId: input.authSessionId } : {}),
  };
}

it.effect("admits an owner session to the auth control plane", () =>
  Effect.gen(function* () {
    yield* provideWsConnectionSession(requireWsOwnerRole, connectionSession({ role: "owner" }));
  }),
);

it.effect("rejects a client session with a typed error", () =>
  Effect.gen(function* () {
    const error = yield* provideWsConnectionSession(
      requireWsOwnerRole,
      connectionSession({ role: "client" }),
    ).pipe(Effect.flip);

    assert.equal(error.message, "Owner authorization is required for this operation.");
  }),
);

it.effect("rejects a connection with no session at all", () =>
  Effect.gen(function* () {
    const error = yield* provideWsConnectionSession(requireWsOwnerRole, undefined).pipe(
      Effect.flip,
    );

    assert.equal(error.message, "Owner authorization is required for this operation.");
  }),
);

it.effect("resolves the caller's own auth session for listings and revocation", () =>
  Effect.gen(function* () {
    const sessionId = yield* provideWsConnectionSession(
      currentWsAuthSessionId,
      connectionSession({ role: "owner", authSessionId: "session-42" as AuthSessionId }),
    );

    assert.equal(sessionId, "session-42");
  }),
);

it.effect("substitutes a non-matching sentinel for the unauthenticated loopback owner", () =>
  Effect.gen(function* () {
    const sessionId = yield* provideWsConnectionSession(
      currentWsAuthSessionId,
      connectionSession({ role: "owner" }),
    );

    assert.equal(sessionId, "ws-unauthenticated-loopback-owner");
  }),
);

it("reports a disabled policy as loopback-only with no pairing endpoint", () => {
  const status = toMobileAccessStatus(DISABLED_MOBILE_ACCESS, ENVIRONMENT_ID);

  assert.equal(status.enabled, false);
  assert.equal(status.reachability, "disabled");
  assert.equal(status.pairingBaseUrl, null);
  assert.equal(status.insecureDevelopmentAccess, false);
  assert.deepStrictEqual(status.approvedRoots, []);
});

it("publishes only the operator's HTTPS endpoint in trusted-proxy mode", () => {
  const config = {
    enabled: true,
    mode: "trusted-proxy" as const,
    publicBaseUrl: "https://mac.tail1234.ts.net",
    approvedRoots: ["/Users/owner/code"],
  };
  const mobileAccess: ServerMobileAccessConfig = {
    config,
    resolution: resolveMobileAccess({ config, allowPrivateLan: false, port: 3773 }),
    approvedRoots: [{ rootId: "root-1" as never, label: "code", path: "/Users/owner/code" }],
    desktopManaged: true,
    privateLanAvailable: false,
  };

  const status = toMobileAccessStatus(mobileAccess, ENVIRONMENT_ID);

  assert.equal(status.reachability, "trusted-proxy");
  assert.equal(status.pairingBaseUrl, "https://mac.tail1234.ts.net");
  assert.equal(status.insecureDevelopmentAccess, false);
  assert.equal(status.environmentId, ENVIRONMENT_ID);
});

it("blocks pairing when a release build stores a private-LAN policy", () => {
  const config = {
    enabled: true,
    mode: "private-lan" as const,
    privateBindAddress: "192.168.1.24",
    approvedRoots: [],
  };
  const mobileAccess: ServerMobileAccessConfig = {
    config,
    resolution: resolveMobileAccess({ config, allowPrivateLan: false, port: 3773 }),
    approvedRoots: [],
    desktopManaged: true,
    privateLanAvailable: false,
  };

  const status = toMobileAccessStatus(mobileAccess, ENVIRONMENT_ID);

  assert.equal(status.reachability, "loopback-only");
  assert.equal(status.pairingBaseUrl, null);
  assert.isString(status.pairingBlockedReason);
});
