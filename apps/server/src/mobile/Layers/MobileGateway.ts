import {
  MOBILE_CAPABILITIES,
  MOBILE_PROTOCOL_EPOCH,
  MOBILE_PROTOCOL_MAX_REVISION,
  MOBILE_PROTOCOL_MIN_REVISION,
  type MobileServerFrame,
  type MobileStream,
  type MobileSubscribe,
  type MobileSubscriptionId,
  type ServerProviderStatus,
  WsRpcError,
} from "@synara/contracts";
import { DateTime, Duration, Effect, Layer, Option, Schema, Stream, type Scope } from "effect";

import { ServerEnvironment } from "../../environment/Services/ServerEnvironment";
import { GitCore } from "../../git/Services/GitCore";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery";
import {
  makeShellStreamEventProjector,
  makeShellSubscriptionStream,
  makeThreadSubscriptionStream,
} from "../../orchestration/orchestrationSubscriptionStreams";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService";
import { ProviderHealth } from "../../provider/Services/ProviderHealth";
import { loadProviderAvailabilities } from "../../provider/providerAvailability";
import { ServerInstanceIdentity } from "../../server/Services/ServerInstanceIdentity";
import { ServerSettingsService } from "../../serverSettings";
import { ThreadCreationCoordinator } from "../../threadCreation/Services/ThreadCreationCoordinator";
import { bufferLiveUiStream } from "../../wsStreamBackpressure";
import { mobileInternalError } from "../mobileErrors";
import { toMobileProviderStatuses } from "../mobileProviderStatuses";
import {
  makeMobileRequestHandlers,
  type MobileRequestHandlerDependencies,
} from "../mobileRequestHandlers";
import {
  MobileGateway,
  MobileGatewayError,
  type MobileGatewayShape,
} from "../Services/MobileGateway";
import { MobileWorkspaceAccess } from "../Services/MobileWorkspaceAccess";

/** A probe must never hang a client's reachability check on server-side IO. */
export const MOBILE_PROBE_TIMEOUT = Duration.seconds(5);

// A drop or an over-limit replay is recoverable by resubscribing, so it ends the
// subscription with a reset marker instead of failing the whole connection.
const STREAM_OVERFLOW_SENTINEL = Symbol.for("synara/mobile/stream-overflow");
type StreamOverflow = { readonly [STREAM_OVERFLOW_SENTINEL]: true; readonly message: string };

const streamOverflow = (message: string): StreamOverflow => ({
  [STREAM_OVERFLOW_SENTINEL]: true,
  message,
});

const isStreamOverflow = (value: unknown): value is StreamOverflow =>
  typeof value === "object" && value !== null && STREAM_OVERFLOW_SENTINEL in value;

const internalError = mobileInternalError;

const resetRequired = (
  subscriptionId: MobileSubscriptionId,
  stream: MobileStream,
  message: string,
): MobileServerFrame => ({
  type: "reset-required",
  subscriptionId,
  stream,
  reason: "stream-overflow",
  message,
});

export const makeMobileGateway = (
  options: {
    readonly probeTimeout?: Duration.Duration;
    readonly projectShellTimeoutMs?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const environment = yield* ServerEnvironment;
    const identity = yield* ServerInstanceIdentity;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const providerHealth = yield* ProviderHealth;
    const providerDiscovery = yield* ProviderDiscoveryService;
    const commandReceipts = yield* OrchestrationCommandReceiptRepository;
    const workspaceAccess = yield* MobileWorkspaceAccess;
    const threadCreation = yield* ThreadCreationCoordinator;
    const git = yield* GitCore;
    const settings = yield* ServerSettingsService;
    const probeTimeout = options.probeTimeout ?? MOBILE_PROBE_TIMEOUT;

    const requestHandlers = makeMobileRequestHandlers({
      workspaceAccess,
      orchestrationEngine,
      snapshotQuery,
      commandReceipts,
      providerHealth,
      providerDiscovery,
      git,
      threadCreation,
      loadProviderAvailabilities: loadProviderAvailabilities({ settings, providerHealth }),
      ...(options.projectShellTimeoutMs === undefined
        ? {}
        : { projectShellTimeoutMs: options.projectShellTimeoutMs }),
    } satisfies MobileRequestHandlerDependencies);

    const serverInstanceId = yield* identity.getServerInstanceId;
    const serverBuild = yield* identity.getServerBuild;
    const toShellStreamEvent = makeShellStreamEventProjector(snapshotQuery);

    const getDescriptor: MobileGatewayShape["getDescriptor"] = Effect.map(
      environment.getDescriptor,
      (descriptor) => ({
        protocolEpoch: MOBILE_PROTOCOL_EPOCH,
        minRevision: MOBILE_PROTOCOL_MIN_REVISION,
        maxRevision: MOBILE_PROTOCOL_MAX_REVISION,
        serverInstanceId,
        serverBuild,
        environment: descriptor,
        capabilities: [...MOBILE_CAPABILITIES],
      }),
    );

    const acceptHello: MobileGatewayShape["acceptHello"] = (hello) =>
      Effect.gen(function* () {
        if (hello.minRevision > hello.maxRevision) {
          return yield* MobileGatewayError.of(
            "protocol_incompatible",
            "The client sent an invalid mobile protocol revision range.",
          );
        }
        const negotiatedRevision = Math.min(hello.maxRevision, MOBILE_PROTOCOL_MAX_REVISION);
        if (negotiatedRevision < Math.max(hello.minRevision, MOBILE_PROTOCOL_MIN_REVISION)) {
          return yield* MobileGatewayError.of(
            "protocol_incompatible",
            `Mobile protocol revisions ${hello.minRevision}-${hello.maxRevision} do not overlap server revisions ${MOBILE_PROTOCOL_MIN_REVISION}-${MOBILE_PROTOCOL_MAX_REVISION}.`,
          );
        }

        const environmentId = yield* environment.getEnvironmentId;
        if (hello.environmentId !== environmentId) {
          return yield* MobileGatewayError.of(
            "environment_mismatch",
            "This client is paired with a different Synara environment.",
          );
        }
        // A restarted server has new in-memory state; resuming against the
        // instance the client negotiated with is the only safe outcome.
        if (hello.serverInstanceId !== serverInstanceId) {
          return yield* MobileGatewayError.of(
            "server_instance_changed",
            "The Synara server restarted; re-read the descriptor before reconnecting.",
            { retryable: true },
          );
        }

        return {
          type: "hello-accepted" as const,
          protocol: MOBILE_PROTOCOL_EPOCH,
          negotiatedRevision,
          environmentId,
          serverInstanceId,
          serverBuild,
          capabilities: [...MOBILE_CAPABILITIES],
        };
      });

    const probe = (negotiatedRevision: number) =>
      Effect.gen(function* () {
        const environmentId = yield* environment.getEnvironmentId;
        const now = yield* DateTime.now;
        return {
          environmentId,
          serverInstanceId,
          negotiatedRevision,
          serverTime: DateTime.formatIso(now),
        };
      }).pipe(
        Effect.timeoutOrElse({
          duration: probeTimeout,
          onTimeout: () =>
            Effect.fail(
              MobileGatewayError.of("timeout", "The connection probe timed out.", {
                retryable: true,
              }),
            ),
        }),
      );

    const handleRequest: MobileGatewayShape["handleRequest"] = (request, connection) => {
      if (request.method === "connection.probe") {
        return probe(connection.negotiatedRevision).pipe(
          Effect.map((result) => ({
            type: "success" as const,
            requestId: request.requestId,
            method: "connection.probe" as const,
            result,
          })),
        );
      }
      return requestHandlers(request);
    };

    const subscribeShell = (frame: Extract<MobileSubscribe, { stream: "orchestration.shell" }>) =>
      makeShellSubscriptionStream<MobileGatewayError | StreamOverflow>({
        orchestrationEngine,
        snapshotQuery,
        toError: (cause, fallbackMessage) => internalError(cause, fallbackMessage),
        bufferLive: (stream) =>
          bufferLiveUiStream(stream, {
            label: "mobile.orchestration.shell",
            onDroppedEvents: (report) => Effect.fail(streamOverflow(report.message)),
          }),
      }).pipe(
        Stream.mapEffect((item) => {
          switch (item.kind) {
            case "snapshot":
              return Effect.succeed(
                Option.some<MobileServerFrame>({
                  type: "snapshot",
                  subscriptionId: frame.subscriptionId,
                  stream: "orchestration.shell",
                  snapshot: item.snapshot,
                }),
              );
            case "synchronized":
              return Effect.succeed(
                Option.some<MobileServerFrame>({
                  type: "synchronized",
                  subscriptionId: frame.subscriptionId,
                  stream: "orchestration.shell",
                  sequence: item.sequence,
                }),
              );
            case "event":
              return toShellStreamEvent(item.event).pipe(
                Effect.map(
                  Option.map(
                    (event): MobileServerFrame => ({
                      type: "event",
                      subscriptionId: frame.subscriptionId,
                      stream: "orchestration.shell",
                      event,
                    }),
                  ),
                ),
              );
          }
        }),
        Stream.flatMap((frameOption) =>
          Option.isSome(frameOption) ? Stream.succeed(frameOption.value) : Stream.empty,
        ),
      );

    const subscribeThread = (frame: Extract<MobileSubscribe, { stream: "orchestration.thread" }>) =>
      makeThreadSubscriptionStream<MobileGatewayError | StreamOverflow>(frame.params.threadId, {
        orchestrationEngine,
        snapshotQuery,
        toError: (cause, fallbackMessage) => internalError(cause, fallbackMessage),
        bufferLive: (stream) =>
          bufferLiveUiStream(stream, {
            label: "mobile.orchestration.thread",
            onDroppedEvents: (report) => Effect.fail(streamOverflow(report.message)),
          }),
      }).pipe(
        Stream.flatMap((item) => {
          switch (item.kind) {
            case "snapshot":
              // A silently empty snapshot would leave the client waiting forever
              // for thread history; fail identifiably so it can surface the state.
              return Option.isSome(item.snapshot.detail)
                ? Stream.succeed<MobileServerFrame>({
                    type: "snapshot",
                    subscriptionId: frame.subscriptionId,
                    stream: "orchestration.thread",
                    snapshot: item.snapshot.detail.value,
                  })
                : Stream.fail(
                    MobileGatewayError.of(
                      "not_found",
                      `Thread ${frame.params.threadId} was not found.`,
                    ),
                  );
            case "synchronized":
              return Stream.succeed<MobileServerFrame>({
                type: "synchronized",
                subscriptionId: frame.subscriptionId,
                stream: "orchestration.thread",
                sequence: item.sequence,
              });
            case "event":
              return Stream.succeed<MobileServerFrame>({
                type: "event",
                subscriptionId: frame.subscriptionId,
                stream: "orchestration.thread",
                event: item.event,
              });
          }
        }),
      );

    const subscribeProviderStatuses = (
      frame: Extract<MobileSubscribe, { stream: "provider.statuses" }>,
    ) => {
      const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const toFrame = (
        type: "snapshot" | "event",
        providers: ReadonlyArray<ServerProviderStatus>,
      ) =>
        nowIso.pipe(
          Effect.map(
            (updatedAt): MobileServerFrame =>
              type === "snapshot"
                ? {
                    type: "snapshot",
                    subscriptionId: frame.subscriptionId,
                    stream: "provider.statuses",
                    snapshot: toMobileProviderStatuses(providers, updatedAt),
                  }
                : {
                    type: "event",
                    subscriptionId: frame.subscriptionId,
                    stream: "provider.statuses",
                    event: toMobileProviderStatuses(providers, updatedAt),
                  },
          ),
        );

      // Whole-state stream: there is no durable sequence to fence against, so
      // the marker carries `null` and every frame supersedes the previous one.
      return Stream.concat(
        Stream.concat(
          Stream.fromEffect(
            providerHealth.getStatuses.pipe(
              Effect.flatMap((providers) => toFrame("snapshot", providers)),
            ),
          ),
          Stream.succeed<MobileServerFrame>({
            type: "synchronized",
            subscriptionId: frame.subscriptionId,
            stream: "provider.statuses",
            sequence: null,
          }),
        ),
        bufferLiveUiStream(providerHealth.streamChanges, {
          label: "mobile.provider.statuses",
          onDroppedEvents: (report) => Effect.fail(streamOverflow(report.message)),
        }).pipe(Stream.mapEffect((providers) => toFrame("event", providers))),
      );
    };

    const subscribe: MobileGatewayShape["subscribe"] = (frame) => {
      const stream: Stream.Stream<MobileServerFrame, unknown, Scope.Scope> = (() => {
        switch (frame.stream) {
          case "orchestration.shell":
            return subscribeShell(frame);
          case "orchestration.thread":
            return subscribeThread(frame);
          case "provider.statuses":
            return subscribeProviderStatuses(frame);
        }
      })();

      return stream.pipe(
        Stream.catch((cause) => {
          if (isStreamOverflow(cause)) {
            return Stream.succeed(resetRequired(frame.subscriptionId, frame.stream, cause.message));
          }
          // The bounded replay limit is the same recoverable desync as a drop.
          if (Schema.is(WsRpcError)(cause) && cause.code === "ORCHESTRATION_RESNAPSHOT_REQUIRED") {
            return Stream.succeed(resetRequired(frame.subscriptionId, frame.stream, cause.message));
          }
          if (cause instanceof MobileGatewayError) {
            return Stream.fail(cause);
          }
          return Stream.fail(internalError(cause, "The subscription failed."));
        }),
      );
    };

    return {
      getDescriptor,
      acceptHello,
      handleRequest,
      subscribe,
    } satisfies MobileGatewayShape;
  });

export const MobileGatewayLive = Layer.effect(MobileGateway, makeMobileGateway());
