import {
  EnvironmentId,
  MOBILE_PROTOCOL_EPOCH,
  MOBILE_PROTOCOL_MAX_REVISION,
  ThreadId,
  type MobileHello,
  type MobileRequestId,
  type MobileRootId,
  type MobileSubscriptionId,
  type OrchestrationEvent,
  type ServerProviderStatus,
} from "@synara/contracts";
import { Duration, Effect, Layer, Option, Stream, type Scope } from "effect";
import { describe, expect, it } from "vitest";

import { ServerEnvironment } from "../../environment/Services/ServerEnvironment";
import { GitCore } from "../../git/Services/GitCore";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService";
import { ProviderHealth } from "../../provider/Services/ProviderHealth";
import { ServerInstanceIdentity } from "../../server/Services/ServerInstanceIdentity";
import { ServerSettingsService } from "../../serverSettings";
import { ThreadCreationCoordinator } from "../../threadCreation/Services/ThreadCreationCoordinator";
import { ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT } from "../../wsSnapshotLiveStream";
import { MobileGatewayError, type MobileGatewayShape } from "../Services/MobileGateway";
import { MobileWorkspaceAccess } from "../Services/MobileWorkspaceAccess";
import { makeMobileGateway } from "./MobileGateway";

const ENVIRONMENT_ID = EnvironmentId.makeUnsafe("11111111-1111-4111-8111-111111111111");
const OTHER_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("99999999-9999-4999-8999-999999999999");
const SERVER_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const SUBSCRIPTION_ID = "33333333-3333-4333-8333-333333333333" as MobileSubscriptionId;
const REQUEST_ID = "44444444-4444-4444-8444-444444444444" as MobileRequestId;
const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const ROOT_ID = "root-0000000000000001" as MobileRootId;

const projectDeleted = (sequence: number, projectId: string): OrchestrationEvent =>
  ({
    sequence,
    type: "project.deleted",
    aggregateKind: "project",
    aggregateId: projectId,
    payload: { projectId },
  }) as unknown as OrchestrationEvent;

const providerStatus = (available: boolean): ServerProviderStatus =>
  ({
    provider: "codex",
    status: "ready",
    available,
    authStatus: "authenticated",
    checkedAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as ServerProviderStatus;

interface HarnessOptions {
  readonly environmentId?: EnvironmentId;
  readonly serverInstanceId?: string;
  /** Stalls the probe's only IO so the server-side timeout is the sole exit. */
  readonly hangEnvironmentId?: boolean;
  readonly snapshotSequence?: number;
  readonly highWaterSequence?: number;
  readonly replay?: ReadonlyArray<OrchestrationEvent>;
  readonly providerStatuses?: ReadonlyArray<ServerProviderStatus>;
  readonly providerChanges?: Stream.Stream<ReadonlyArray<ServerProviderStatus>>;
}

const makeHarnessLayer = (options: HarnessOptions) => {
  const snapshotSequence = options.snapshotSequence ?? 0;
  const statuses = options.providerStatuses ?? [providerStatus(true)];

  const environmentLayer = Layer.succeed(ServerEnvironment, {
    getEnvironmentId: options.hangEnvironmentId
      ? Effect.never
      : Effect.succeed(options.environmentId ?? ENVIRONMENT_ID),
    getDescriptor: Effect.succeed({
      environmentId: options.environmentId ?? ENVIRONMENT_ID,
      label: "Test environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: false },
    }),
  } as unknown as (typeof ServerEnvironment)["Service"]);

  const identityLayer = Layer.succeed(ServerInstanceIdentity, {
    getServerInstanceId: Effect.succeed(options.serverInstanceId ?? SERVER_INSTANCE_ID),
    getServerBuild: Effect.succeed("0.0.0-test"),
  });

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    subscribeDomainEvents: Effect.succeed(Stream.never),
    getEventHighWaterSequence: Effect.succeed(options.highWaterSequence ?? snapshotSequence),
    readEventsThrough: () => Stream.fromIterable(options.replay ?? []),
  } as unknown as (typeof OrchestrationEngineService)["Service"]);

  const snapshotLayer = Layer.succeed(ProjectionSnapshotQuery, {
    getShellSnapshot: () =>
      Effect.succeed({ snapshotSequence, spaces: [], projects: [], threads: [] }),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence }),
    // Every thread case here targets an unknown thread; a hydrated thread
    // snapshot needs the real projection and is covered by projection tests.
    getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
  } as unknown as (typeof ProjectionSnapshotQuery)["Service"]);

  const providerHealthLayer = Layer.succeed(ProviderHealth, {
    getStatuses: Effect.succeed(statuses),
    refresh: Effect.succeed(statuses),
    updateProvider: () => Effect.die("Provider updates are not used by gateway tests."),
    streamChanges: options.providerChanges ?? Stream.never,
  } as unknown as (typeof ProviderHealth)["Service"]);

  // The bound methods have their own suite; here they only need to resolve so
  // the gateway can be constructed and its dispatch table exercised.
  const workspaceAccessLayer = Layer.succeed(MobileWorkspaceAccess, {
    listRoots: Effect.succeed([
      { rootId: ROOT_ID, label: "code", displayPath: "~/code" },
    ]) as unknown as (typeof MobileWorkspaceAccess)["Service"]["listRoots"],
    resolveDirectory: () => Effect.die("Not used by gateway tests."),
    listDirectories: () => Effect.die("Not used by gateway tests."),
  } as unknown as (typeof MobileWorkspaceAccess)["Service"]);

  const supportingLayer = Layer.mergeAll(
    Layer.succeed(ProviderDiscoveryService, {
      listModels: () => Effect.succeed({ models: [] }),
    } as unknown as (typeof ProviderDiscoveryService)["Service"]),
    Layer.succeed(OrchestrationCommandReceiptRepository, {
      getByCommandId: () => Effect.succeed(Option.none()),
    } as unknown as (typeof OrchestrationCommandReceiptRepository)["Service"]),
    Layer.succeed(ThreadCreationCoordinator, {
      createAndStart: () => Effect.die("Not used by gateway tests."),
      getOperation: () => Effect.die("Not used by gateway tests."),
      recoverInterrupted: Effect.void,
    } as unknown as (typeof ThreadCreationCoordinator)["Service"]),
    Layer.succeed(GitCore, {
      listBranches: () => Effect.die("Not used by gateway tests."),
    } as unknown as (typeof GitCore)["Service"]),
    Layer.succeed(ServerSettingsService, {
      get: Effect.succeed({ providers: {} }),
    } as unknown as (typeof ServerSettingsService)["Service"]),
  );

  return Layer.mergeAll(
    environmentLayer,
    identityLayer,
    engineLayer,
    snapshotLayer,
    providerHealthLayer,
    workspaceAccessLayer,
    supportingLayer,
  );
};

const runGateway = <A>(
  options: HarnessOptions,
  use: (gateway: MobileGatewayShape) => Effect.Effect<A, unknown, Scope.Scope>,
  gatewayOptions: { readonly probeTimeout?: Duration.Duration } = {},
): Promise<A> =>
  makeMobileGateway(gatewayOptions).pipe(
    Effect.flatMap(use),
    Effect.provide(makeHarnessLayer(options)),
    Effect.scoped,
    Effect.orDie,
    Effect.runPromise,
  );

const hello = (overrides: Partial<MobileHello> = {}): MobileHello => ({
  type: "hello",
  protocol: MOBILE_PROTOCOL_EPOCH,
  minRevision: 1,
  maxRevision: 1,
  environmentId: ENVIRONMENT_ID,
  serverInstanceId: SERVER_INSTANCE_ID,
  clientBuild: "ios-test",
  ...overrides,
});

const gatewayError = (error: unknown): MobileGatewayError => {
  expect(error).toBeInstanceOf(MobileGatewayError);
  return error as MobileGatewayError;
};

describe("MobileGateway", () => {
  it("advertises a descriptor carrying no secrets", async () => {
    const descriptor = await runGateway({}, (gateway) => gateway.getDescriptor);

    expect(descriptor.protocolEpoch).toBe(MOBILE_PROTOCOL_EPOCH);
    expect(descriptor.maxRevision).toBe(MOBILE_PROTOCOL_MAX_REVISION);
    expect(descriptor.serverInstanceId).toBe(SERVER_INSTANCE_ID);
    expect(descriptor.environment.environmentId).toBe(ENVIRONMENT_ID);
    expect(descriptor.capabilities).toContain("mobile.shell-sync");
    const serialized = JSON.stringify(descriptor).toLowerCase();
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("secret");
  });

  it("accepts a compatible hello and negotiates the highest shared revision", async () => {
    const accepted = await runGateway({}, (gateway) =>
      gateway.acceptHello(hello({ minRevision: 1, maxRevision: 9 })),
    );

    expect(accepted.type).toBe("hello-accepted");
    expect(accepted.negotiatedRevision).toBe(MOBILE_PROTOCOL_MAX_REVISION);
    expect(accepted.serverInstanceId).toBe(SERVER_INSTANCE_ID);
    expect(accepted.environmentId).toBe(ENVIRONMENT_ID);
  });

  it("rejects a hello whose revision range does not overlap the server", async () => {
    const error = await runGateway({}, (gateway) =>
      gateway.acceptHello(hello({ minRevision: 7, maxRevision: 9 })).pipe(Effect.flip),
    );

    expect(gatewayError(error).error.code).toBe("protocol_incompatible");
  });

  it("rejects a hello with an inverted revision range", async () => {
    const error = await runGateway({}, (gateway) =>
      gateway.acceptHello(hello({ minRevision: 4, maxRevision: 2 })).pipe(Effect.flip),
    );

    expect(gatewayError(error).error.code).toBe("protocol_incompatible");
  });

  it("rejects a hello paired with a different environment", async () => {
    const error = await runGateway({}, (gateway) =>
      gateway.acceptHello(hello({ environmentId: OTHER_ENVIRONMENT_ID })).pipe(Effect.flip),
    );

    expect(gatewayError(error).error.code).toBe("environment_mismatch");
  });

  it("rejects a hello bound to a previous server instance", async () => {
    const error = await runGateway({}, (gateway) =>
      gateway
        .acceptHello(hello({ serverInstanceId: "00000000-0000-4000-8000-000000000000" }))
        .pipe(Effect.flip),
    );

    expect(gatewayError(error).error.code).toBe("server_instance_changed");
    expect(gatewayError(error).error.retryable).toBe(true);
  });

  it("answers connection.probe with the negotiated connection identity", async () => {
    const success = await runGateway({}, (gateway) =>
      gateway.handleRequest(
        { type: "request", requestId: REQUEST_ID, method: "connection.probe", params: {} },
        { negotiatedRevision: 1 },
      ),
    );

    expect(success.method).toBe("connection.probe");
    expect(success.requestId).toBe(REQUEST_ID);
    expect(success.result).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      serverInstanceId: SERVER_INSTANCE_ID,
      negotiatedRevision: 1,
    });
  });

  it("times out connection.probe instead of hanging the client", async () => {
    const error = await runGateway(
      { hangEnvironmentId: true },
      (gateway) =>
        gateway
          .handleRequest(
            { type: "request", requestId: REQUEST_ID, method: "connection.probe", params: {} },
            { negotiatedRevision: 1 },
          )
          .pipe(Effect.flip),
      { probeTimeout: Duration.millis(20) },
    );

    expect(gatewayError(error).error.code).toBe("timeout");
    expect(gatewayError(error).error.retryable).toBe(true);
  });

  it("routes an allowlisted method to its bound handler", async () => {
    const success = await runGateway({}, (gateway) =>
      gateway.handleRequest(
        { type: "request", requestId: REQUEST_ID, method: "projects.listRoots", params: {} },
        { negotiatedRevision: 1 },
      ),
    );

    expect(success.method).toBe("projects.listRoots");
    expect(success.result).toEqual({
      roots: [{ rootId: ROOT_ID, label: "code", displayPath: "~/code" }],
    });
  });

  it("emits snapshot, fenced replay, then the synchronized marker on the shell stream", async () => {
    const frames = await runGateway(
      {
        snapshotSequence: 1,
        highWaterSequence: 3,
        replay: [projectDeleted(2, "project-2"), projectDeleted(3, "project-3")],
      },
      (gateway) =>
        gateway
          .subscribe({
            type: "subscribe",
            subscriptionId: SUBSCRIPTION_ID,
            stream: "orchestration.shell",
            params: {},
          })
          .pipe(Stream.take(4), Stream.runCollect),
    );

    const collected = Array.from(frames);
    expect(collected.map((frame) => frame.type)).toEqual([
      "snapshot",
      "event",
      "event",
      "synchronized",
    ]);
    expect(collected.at(-1)).toEqual({
      type: "synchronized",
      subscriptionId: SUBSCRIPTION_ID,
      stream: "orchestration.shell",
      sequence: 3,
    });
  });

  it("ends a hopelessly stale shell subscription with reset-required", async () => {
    const frames = await runGateway(
      { snapshotSequence: 0, highWaterSequence: ORCHESTRATION_SNAPSHOT_REPLAY_LIMIT + 1 },
      (gateway) =>
        gateway
          .subscribe({
            type: "subscribe",
            subscriptionId: SUBSCRIPTION_ID,
            stream: "orchestration.shell",
            params: {},
          })
          .pipe(Stream.runCollect),
    );

    const collected = Array.from(frames);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      type: "reset-required",
      subscriptionId: SUBSCRIPTION_ID,
      stream: "orchestration.shell",
      reason: "stream-overflow",
    });
  });

  it("fails a thread subscription for a thread that does not exist", async () => {
    const error = await runGateway({}, (gateway) =>
      gateway
        .subscribe({
          type: "subscribe",
          subscriptionId: SUBSCRIPTION_ID,
          stream: "orchestration.thread",
          params: { threadId: THREAD_ID },
        })
        .pipe(Stream.runCollect, Effect.flip),
    );

    expect(gatewayError(error).error.code).toBe("not_found");
  });

  it("marks the unsequenced provider stream synchronized with a null sequence", async () => {
    const frames = await runGateway(
      { providerChanges: Stream.succeed([providerStatus(false)]) },
      (gateway) =>
        gateway
          .subscribe({
            type: "subscribe",
            subscriptionId: SUBSCRIPTION_ID,
            stream: "provider.statuses",
            params: {},
          })
          .pipe(Stream.take(3), Stream.runCollect),
    );

    const collected = Array.from(frames);
    expect(collected.map((frame) => frame.type)).toEqual(["snapshot", "synchronized", "event"]);
    expect(collected[1]).toEqual({
      type: "synchronized",
      subscriptionId: SUBSCRIPTION_ID,
      stream: "provider.statuses",
      sequence: null,
    });
    expect(collected[0]).toMatchObject({
      snapshot: { providers: [{ provider: "codex", available: true }] },
    });
    expect(collected[2]).toMatchObject({
      event: { providers: [{ provider: "codex", available: false }] },
    });
  });
});
