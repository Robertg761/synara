import * as NodeServices from "@effect/platform-node/NodeServices";
import { DateTime, Duration, Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { AuthPairingLinkRepository } from "../../persistence/Services/AuthPairingLinks";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService";
import { BootstrapCredentialServiceLive } from "./BootstrapCredentialService";
import { ServerSecretStoreLive } from "./ServerSecretStore";

const testLayer = BootstrapCredentialServiceLive.pipe(
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "synara-bootstrap-credential-test-" }),
  ),
  Layer.provide(NodeServices.layer),
);

describe("BootstrapCredentialServiceLive", () => {
  it("issues, lists, and consumes one-time pairing credentials", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const issued = yield* service.issueOneTimeToken({ label: "Test device" });
      const active = yield* service.listActive();

      expect(active.map((link) => link.id)).toEqual([issued.id]);
      expect(active[0]?.label).toBe("Test device");

      const grant = yield* service.consume(issued.credential);
      expect(grant.method).toBe("one-time-token");
      expect(grant.role).toBe("client");

      const afterConsume = yield* service.listActive();
      expect(afterConsume).toEqual([]);
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });

  it("rejects consumed credentials", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const issued = yield* service.issueOneTimeToken();
      yield* service.consume(issued.credential);

      const exit = yield* service.consume(issued.credential).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });

  it("stores only a digest and a short hint, never the credential", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const repository = yield* AuthPairingLinkRepository;
      const issued = yield* service.issueOneTimeToken();
      const now = yield* DateTime.now;

      const stored = yield* repository.listActive({ now });
      const record = stored.find((row) => row.id === issued.id);

      expect(record).toBeDefined();
      expect(JSON.stringify(record)).not.toContain(issued.credential);
      expect(issued.credentialHint).toBe(issued.credential.slice(0, 4));
      expect(record?.credentialHint).toBe(issued.credentialHint);
      expect(record?.audience).toBe("interactive");

      const listed = yield* service.listActive();
      expect(JSON.stringify(listed)).not.toContain(issued.credential);
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });

  it("issues credentials for an explicit audience", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const issued = yield* service.issueOneTimeToken({ audience: "mobile-v1" });

      expect(issued.audience).toBe("mobile-v1");
      const grant = yield* service.consume(issued.credential);
      expect(grant.audience).toBe("mobile-v1");
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });

  it("rejects unknown, revoked, and consumed credentials with the same failure", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const consumed = yield* service.issueOneTimeToken();
      yield* service.consume(consumed.credential);
      const revoked = yield* service.issueOneTimeToken();
      yield* service.revoke(revoked.id);

      const failures = yield* Effect.forEach(
        [consumed.credential, revoked.credential, "NEVERISSUED0"],
        (credential) => Effect.flip(service.consume(credential)),
      );

      const messages = new Set(failures.map((failure) => failure.message));
      expect(messages.size).toBe(1);
      expect(failures.every((failure) => failure.status === 401)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });

  it("revokes active pairing links", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const issued = yield* service.issueOneTimeToken();

      expect(yield* service.revoke(issued.id)).toBe(true);
      expect(yield* service.revoke(issued.id)).toBe(false);
      expect(yield* service.listActive()).toEqual([]);
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });

  it("does not list expired pairing links", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const repository = yield* AuthPairingLinkRepository;
      const now = yield* DateTime.now;
      const expiresAt = DateTime.subtractDuration(now, Duration.seconds(1));

      yield* repository.create({
        id: "expired-link",
        credentialDigest: "expired-digest",
        credentialHint: "EXPI",
        audience: "interactive",
        method: "one-time-token",
        role: "client",
        subject: "test",
        label: null,
        createdAt: now,
        expiresAt,
      });

      expect(yield* service.listActive()).toEqual([]);
      expect(
        yield* repository.getByCredentialDigest({ credentialDigest: "expired-digest" }),
      ).toSatisfy(Option.isSome);
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });
});
