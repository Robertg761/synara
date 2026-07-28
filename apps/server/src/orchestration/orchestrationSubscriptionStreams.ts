// FILE: orchestrationSubscriptionStreams.ts
// Purpose: The single shell/thread subscription algorithm shared by every transport.
// Layer: Server orchestration
// Exports: isShellRelevantEvent, isThreadDetailEventFor, makeShellStreamEventProjector,
//          loadThreadDetailSnapshot, makeShellSubscriptionStream, makeThreadSubscriptionStream

import {
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationThreadDetailSnapshot,
  type WsRpcError,
} from "@synara/contracts";
import { Effect, Option, Stream, type Scope } from "effect";

import {
  makeCursorSafeSnapshotLiveStream,
  type SnapshotLiveStreamItem,
} from "../wsSnapshotLiveStream";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery";
import { shouldPublishThreadShellForEvent } from "./threadShellEvents";

// Must mirror the cases of the shell projector: events rejected here are dropped
// before the live buffer so the sliding window only holds events that can
// actually project to a shell update.
export function isShellRelevantEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "space.created" ||
    event.type === "space.meta-updated" ||
    event.type === "space.order-updated" ||
    event.type === "space.deleted" ||
    event.type === "project.created" ||
    event.type === "project.meta-updated" ||
    event.type === "project.deleted" ||
    event.type === "thread.deleted" ||
    (event.aggregateKind === "thread" && shouldPublishThreadShellForEvent(event))
  );
}

export function isThreadDetailEventFor(threadId: ThreadId, event: OrchestrationEvent): boolean {
  return (
    event.aggregateKind === "thread" &&
    event.aggregateId === threadId &&
    (event.type === "thread.message-sent" ||
      event.type === "thread.proposed-plan-upserted" ||
      event.type === "thread.activity-appended" ||
      event.type === "thread.turn-diff-completed" ||
      event.type === "thread.reverted" ||
      event.type === "thread.conversation-rolled-back" ||
      event.type === "thread.session-set" ||
      event.type === "thread.meta-updated" ||
      event.type === "thread.pinned-message-added" ||
      event.type === "thread.pinned-message-removed" ||
      event.type === "thread.pinned-message-done-set" ||
      event.type === "thread.pinned-message-label-set" ||
      event.type === "thread.marker-added" ||
      event.type === "thread.marker-removed" ||
      event.type === "thread.marker-done-set" ||
      event.type === "thread.marker-label-set" ||
      event.type === "thread.archived" ||
      event.type === "thread.unarchived")
  );
}

/**
 * Projects a domain event into the shell delta a client applies on top of its
 * snapshot. A read that cannot be resolved collapses to `none` rather than
 * failing the subscription: the row was concurrently removed, and the removal
 * arrives as its own event.
 */
export function makeShellStreamEventProjector(
  snapshotQuery: ProjectionSnapshotQueryShape,
): (event: OrchestrationEvent) => Effect.Effect<Option.Option<OrchestrationShellStreamEvent>> {
  return (event) => {
    switch (event.type) {
      case "space.created":
      case "space.meta-updated":
        return snapshotQuery.getSpaceShellById(event.payload.spaceId).pipe(
          Effect.map((space) =>
            Option.map(space, (nextSpace) => ({
              kind: "space-upserted" as const,
              sequence: event.sequence,
              space: nextSpace,
            })),
          ),
          Effect.catch(() => Effect.succeed(Option.none())),
        );
      case "space.order-updated":
        return Effect.succeed(
          Option.some({
            kind: "space-order-updated" as const,
            sequence: event.sequence,
            orderedSpaceIds: event.payload.orderedSpaceIds,
          }),
        );
      case "space.deleted":
        return Effect.succeed(
          Option.some({
            kind: "space-removed" as const,
            sequence: event.sequence,
            spaceId: event.payload.spaceId,
            updatedAt: event.payload.deletedAt,
          }),
        );
      case "project.created":
      case "project.meta-updated":
        return snapshotQuery.getProjectShellById(event.payload.projectId).pipe(
          Effect.map((project) =>
            Option.map(project, (nextProject) => ({
              kind: "project-upserted" as const,
              sequence: event.sequence,
              project: nextProject,
            })),
          ),
          Effect.catch(() => Effect.succeed(Option.none())),
        );
      case "project.deleted":
        return Effect.succeed(
          Option.some({
            kind: "project-removed" as const,
            sequence: event.sequence,
            projectId: event.payload.projectId,
          }),
        );
      case "thread.deleted":
        return Effect.succeed(
          Option.some({
            kind: "thread-removed" as const,
            sequence: event.sequence,
            threadId: event.payload.threadId,
          }),
        );
      default:
        if (event.aggregateKind !== "thread") return Effect.succeed(Option.none());
        return snapshotQuery
          .getThreadShellById(ThreadId.makeUnsafe(String(event.aggregateId)))
          .pipe(
            Effect.map((thread) =>
              Option.map(thread, (nextThread) => ({
                kind: "thread-upserted" as const,
                sequence: event.sequence,
                thread: nextThread,
              })),
            ),
            Effect.catch(() => Effect.succeed(Option.none())),
          );
    }
  };
}

/**
 * A missing thread still carries the projection cursor: the subscription must
 * report "no detail at sequence N" rather than an unsequenced absence.
 */
export interface ThreadDetailSnapshotResult {
  readonly detail: Option.Option<OrchestrationThreadDetailSnapshot>;
  readonly snapshotSequence: number;
}

export function loadThreadDetailSnapshot(
  snapshotQuery: ProjectionSnapshotQueryShape,
  threadId: ThreadId,
) {
  return snapshotQuery.getThreadDetailSnapshotById(threadId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          snapshotQuery.getSnapshotSequence().pipe(
            Effect.map(
              ({ snapshotSequence }): ThreadDetailSnapshotResult => ({
                detail: Option.none(),
                snapshotSequence,
              }),
            ),
          ),
        onSome: (detail) =>
          Effect.succeed<ThreadDetailSnapshotResult>({
            detail: Option.some(detail),
            snapshotSequence: detail.snapshotSequence,
          }),
      }),
    ),
  );
}

export interface OrchestrationSubscriptionDeps<E> {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly toError: (cause: unknown, fallbackMessage: string) => E;
  /**
   * Transport-owned slow-consumer policy applied to the live tail before the
   * cursor-safe handoff. Each transport decides whether a drop restarts the
   * subscription or is reported to the client.
   */
  readonly bufferLive: (
    stream: Stream.Stream<OrchestrationEvent>,
  ) => Stream.Stream<OrchestrationEvent, E>;
  readonly onResnapshotRequired?: (report: {
    readonly snapshotSequence: number;
    readonly highWaterSequence: number;
    readonly replayCount: number;
    readonly replayLimit: number;
  }) => Effect.Effect<void>;
}

export function makeShellSubscriptionStream<E>(
  deps: OrchestrationSubscriptionDeps<E>,
): Stream.Stream<SnapshotLiveStreamItem<OrchestrationShellSnapshot>, E | WsRpcError, Scope.Scope> {
  const { orchestrationEngine, snapshotQuery, toError } = deps;
  return makeCursorSafeSnapshotLiveStream({
    ...(deps.onResnapshotRequired ? { onResnapshotRequired: deps.onResnapshotRequired } : {}),
    subscribeLive: orchestrationEngine.subscribeDomainEvents.pipe(
      Effect.map((stream) => deps.bufferLive(stream.pipe(Stream.filter(isShellRelevantEvent)))),
    ),
    snapshot: snapshotQuery
      .getShellSnapshot()
      .pipe(Effect.mapError((cause) => toError(cause, "Failed to load shell snapshot"))),
    snapshotSequence: (snapshot) => snapshot.snapshotSequence,
    getHighWaterSequence: orchestrationEngine.getEventHighWaterSequence.pipe(
      Effect.mapError((cause) =>
        toError(cause, "Failed to capture orchestration high-water sequence"),
      ),
    ),
    replay: (fromSequenceExclusive, throughSequenceInclusive) =>
      orchestrationEngine.readEventsThrough(fromSequenceExclusive, throughSequenceInclusive).pipe(
        Stream.filter(isShellRelevantEvent),
        Stream.mapError((cause) => toError(cause, "Failed to replay shell events")),
      ),
  });
}

export function makeThreadSubscriptionStream<E>(
  threadId: ThreadId,
  deps: OrchestrationSubscriptionDeps<E>,
): Stream.Stream<SnapshotLiveStreamItem<ThreadDetailSnapshotResult>, E | WsRpcError, Scope.Scope> {
  const { orchestrationEngine, snapshotQuery, toError } = deps;
  return makeCursorSafeSnapshotLiveStream({
    ...(deps.onResnapshotRequired ? { onResnapshotRequired: deps.onResnapshotRequired } : {}),
    subscribeLive: orchestrationEngine.subscribeDomainEvents.pipe(
      Effect.map((stream) =>
        deps.bufferLive(
          stream.pipe(Stream.filter((event) => isThreadDetailEventFor(threadId, event))),
        ),
      ),
    ),
    snapshot: loadThreadDetailSnapshot(snapshotQuery, threadId).pipe(
      Effect.mapError((cause) => toError(cause, "Failed to load thread snapshot")),
    ),
    snapshotSequence: (snapshot) => snapshot.snapshotSequence,
    getHighWaterSequence: orchestrationEngine.getEventHighWaterSequence.pipe(
      Effect.mapError((cause) =>
        toError(cause, "Failed to capture orchestration high-water sequence"),
      ),
    ),
    replay: (fromSequenceExclusive, throughSequenceInclusive) =>
      orchestrationEngine.readEventsThrough(fromSequenceExclusive, throughSequenceInclusive).pipe(
        Stream.filter((event) => isThreadDetailEventFor(threadId, event)),
        Stream.mapError((cause) => toError(cause, "Failed to replay thread events")),
      ),
  });
}
