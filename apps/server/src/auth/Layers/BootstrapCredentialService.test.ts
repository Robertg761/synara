import * as NodeServices from "@effect/platform-node/NodeServices";
import { DateTime, Duration, Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import { AuthPairingLinkRepository } from "../../persistence/Services/AuthPairingLinks";
import { BootstrapCredentialService } from "../Services/BootstrapCredentialService";
import {
  BootstrapCredentialServiceLive,
  DESKTOP_BOOTSTRAP_GRANT_SUBJECT,
} from "./BootstrapCredentialService";

const makeTestLayer = (configOverrides?: {
  readonly mode?: "web" | "desktop";
  readonly desktopBootstrapCredential?: string;
}) => {
  const configLayer = configOverrides
    ? Layer.effect(
        ServerConfig,
        Effect.map(ServerConfig.asEffect(), (config) => ({ ...config, ...configOverrides })),
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "synara-bootstrap-credential-test-" }),
        ),
        Layer.provide(NodeServices.layer),
      )
    : ServerConfig.layerTest(process.cwd(), { prefix: "synara-bootstrap-credential-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      );
  return BootstrapCredentialServiceLive.pipe(
    Layer.provide(configLayer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );
};

const testLayer = makeTestLayer();

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
        credential: "EXPIREDTOKEN",
        method: "one-time-token",
        role: "client",
        subject: "test",
        label: null,
        createdAt: now,
        expiresAt,
      });

      expect(yield* service.listActive()).toEqual([]);
      expect(yield* repository.getByCredential({ credential: "EXPIREDTOKEN" })).toSatisfy(
        Option.isSome,
      );
    }).pipe(Effect.provide(testLayer), Effect.runPromise);
  });

  it("seeds a reusable desktop-bootstrap owner grant from the config credential", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;

      // Reusable within the launch: the desktop window re-bootstraps after reloads.
      for (let i = 0; i < 2; i += 1) {
        const grant = yield* service.consume("desktop-launch-credential");
        expect(grant.method).toBe("desktop-bootstrap");
        expect(grant.role).toBe("owner");
        expect(grant.subject).toBe(DESKTOP_BOOTSTRAP_GRANT_SUBJECT);
      }

      // Seeded grants never appear in the user-visible pairing-link list.
      expect(yield* service.listActive()).toEqual([]);
    }).pipe(
      Effect.provide(
        makeTestLayer({ mode: "desktop", desktopBootstrapCredential: "desktop-launch-credential" }),
      ),
      Effect.runPromise,
    );
  });

  it("does not seed the desktop-bootstrap grant outside desktop mode", async () => {
    await Effect.gen(function* () {
      const service = yield* BootstrapCredentialService;
      const exit = yield* service.consume("desktop-launch-credential").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(
      Effect.provide(
        makeTestLayer({ mode: "web", desktopBootstrapCredential: "desktop-launch-credential" }),
      ),
      Effect.runPromise,
    );
  });
});
