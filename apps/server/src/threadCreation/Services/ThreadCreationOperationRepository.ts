import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  ThreadCreationBlockedReason,
  ThreadCreationCompensationPhase,
  ThreadCreationPhase,
} from "../operationState.ts";

export type ThreadCreationOperationStatus =
  | ThreadCreationPhase
  | "compensating"
  | "blocked"
  | "completed"
  | "failed";

export interface ThreadCreationOperationRecord {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly projectId: string;
  readonly status: ThreadCreationOperationStatus;
  readonly compensationPhase: ThreadCreationCompensationPhase | null;
  readonly blockedReason: ThreadCreationBlockedReason | null;
  readonly ownedResourcesJson: string | null;
  readonly requestJson: string;
  readonly planJson: string | null;
  readonly resultJson: string | null;
  readonly errorJson: string | null;
  readonly compensationCompleted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ReserveThreadCreationOperationResult = {
  readonly kind: "reserved" | "replay" | "idempotency_conflict";
  readonly operation: ThreadCreationOperationRecord;
};

export interface ThreadCreationOperationRepositoryShape {
  /**
   * Insert-or-read the operation keyed by the client-generated id alone. The
   * caller thread/turn plays no part in identity: a mobile outbox item owns its
   * id across reconnects and process restarts.
   */
  readonly reserve: (input: {
    readonly operationId: string;
    readonly fingerprint: string;
    readonly projectId: string;
    readonly requestJson: string;
    readonly now: string;
  }) => Effect.Effect<ReserveThreadCreationOperationResult, Error>;
  /**
   * Single compare-and-set progress primitive. Every durable step names the
   * status and plan it expects to replace, so a concurrent or resumed writer
   * can never overwrite a newer side-effect record.
   */
  readonly recordProgress: (input: {
    readonly operationId: string;
    readonly expectedStatus: ThreadCreationOperationStatus;
    readonly expectedPlanJson: string | null;
    readonly status: ThreadCreationOperationStatus;
    readonly planJson: string;
    readonly now: string;
  }) => Effect.Effect<boolean, Error>;
  readonly markCompensating: (input: {
    readonly operationId: string;
    readonly phase: ThreadCreationCompensationPhase;
    readonly errorJson: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly block: (input: {
    readonly operationId: string;
    readonly reason: ThreadCreationBlockedReason;
    readonly ownedResourcesJson: string;
    readonly errorJson: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly complete: (input: {
    readonly operationId: string;
    readonly resultJson: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly fail: (input: {
    readonly operationId: string;
    readonly errorJson: string;
    readonly compensationCompleted: boolean;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly getById: (
    operationId: string,
  ) => Effect.Effect<ThreadCreationOperationRecord | null, Error>;
  readonly listNonTerminal: () => Effect.Effect<
    ReadonlyArray<ThreadCreationOperationRecord>,
    Error
  >;
}

export class ThreadCreationOperationRepository extends ServiceMap.Service<
  ThreadCreationOperationRepository,
  ThreadCreationOperationRepositoryShape
>()("synara/threadCreation/Services/ThreadCreationOperationRepository") {}
