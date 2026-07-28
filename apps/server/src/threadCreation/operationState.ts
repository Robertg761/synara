import {
  CommandId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@synara/contracts";
import { Schema } from "effect";

/**
 * Transport-neutral state for the durable "create worktree + thread + first
 * turn" saga. Nothing here knows about MCP or the mobile wire protocol; the
 * total projection onto `mobile.v1` lives in `mobileOperation.ts`.
 */

export const ThreadCreationPhase = Schema.Literals([
  "reserved",
  "creating-worktree",
  "creating-thread",
  "starting-turn",
]);
export type ThreadCreationPhase = typeof ThreadCreationPhase.Type;

/** Compensation runs in reverse acquisition order. */
export const ThreadCreationCompensationPhase = Schema.Literals([
  "reverting-turn",
  "removing-thread",
  "removing-worktree",
]);
export type ThreadCreationCompensationPhase = typeof ThreadCreationCompensationPhase.Type;

export const ThreadCreationBlockedReason = Schema.Literals([
  "worktree-ownership-mismatch",
  "worktree-cleanup-failed",
  "thread-cleanup-failed",
  "manual-attention-required",
]);
export type ThreadCreationBlockedReason = typeof ThreadCreationBlockedReason.Type;

/**
 * Deliberately a subset of the mobile error codes: the coordinator must never
 * invent a code the transport cannot represent, and the mapping stays total
 * without a fallback branch that could hide a new state.
 */
export const ThreadCreationErrorCode = Schema.Literals([
  "invalid_request",
  "not_found",
  "conflict",
  "idempotency_conflict",
  "provider_unavailable",
  "model_unavailable",
  "operation_failed",
  "operation_blocked",
  "internal_error",
]);
export type ThreadCreationErrorCode = typeof ThreadCreationErrorCode.Type;

export const ThreadCreationErrorDetail = Schema.Struct({
  code: ThreadCreationErrorCode,
  message: Schema.String,
  retryable: Schema.Boolean,
  retryAfterMs: Schema.optional(NonNegativeInt),
});
export type ThreadCreationErrorDetail = typeof ThreadCreationErrorDetail.Type;

export const ThreadCreationOwnedResource = Schema.Struct({
  kind: Schema.Literals(["worktree", "thread"]),
  identifier: TrimmedNonEmptyString,
});
export type ThreadCreationOwnedResource = typeof ThreadCreationOwnedResource.Type;

export const ThreadCreationTarget = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("local") }),
  Schema.Struct({ mode: Schema.Literal("worktree"), baseRef: TrimmedNonEmptyString }),
]);
export type ThreadCreationTarget = typeof ThreadCreationTarget.Type;

/**
 * The immutable caller intent. It is persisted verbatim so a restart can resume
 * the operation without the caller being connected, and it is the fingerprint
 * source that makes id reuse with a different plan a hard conflict.
 */
export const ThreadCreationRequest = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  projectId: ProjectId,
  target: ThreadCreationTarget,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  firstMessage: Schema.Struct({ text: Schema.String }),
});
export type ThreadCreationRequest = typeof ThreadCreationRequest.Type;

export const ThreadCreationWorktreeOwnership = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  token: TrimmedNonEmptyString,
  gitDir: TrimmedNonEmptyString,
  head: TrimmedNonEmptyString,
  stateHash: Schema.optional(Schema.String),
  recordedAt: IsoDateTime,
});
export type ThreadCreationWorktreeOwnership = typeof ThreadCreationWorktreeOwnership.Type;

/**
 * The authoritative resolution of the request plus a running record of every
 * completed side effect. Recovery reads only this: it never re-resolves refs or
 * re-validates a provider, because that could silently retarget the operation.
 */
export const ThreadCreationPlan = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  environment: Schema.Literals(["local", "worktree"]),
  requestedRef: Schema.NullOr(TrimmedNonEmptyString),
  worktreeRef: Schema.NullOr(TrimmedNonEmptyString),
  copyChangesFrom: Schema.NullOr(TrimmedNonEmptyString),
  plannedWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  title: TrimmedNonEmptyString,
  ids: Schema.Struct({
    threadId: ThreadId,
    threadCreateCommandId: CommandId,
    turnStartCommandId: CommandId,
    messageId: MessageId,
    compensateCommandId: CommandId,
  }),
  worktreeOwnership: Schema.NullOr(ThreadCreationWorktreeOwnership),
  threadCreated: Schema.Boolean,
  acceptedSequence: Schema.NullOr(NonNegativeInt),
});
export type ThreadCreationPlan = typeof ThreadCreationPlan.Type;

export const ThreadCreationWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  ref: TrimmedNonEmptyString,
  detached: Schema.Literal(true),
});
export type ThreadCreationWorktree = typeof ThreadCreationWorktree.Type;

export const ThreadCreationCompletedResult = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  acceptedSequence: NonNegativeInt,
  thread: OrchestrationThreadShell,
  worktree: Schema.NullOr(ThreadCreationWorktree),
});
export type ThreadCreationCompletedResult = typeof ThreadCreationCompletedResult.Type;

export type ThreadCreationOperationState =
  | { readonly status: "not-found"; readonly operationId: string }
  | {
      readonly status: "pending";
      readonly operationId: string;
      readonly phase: ThreadCreationPhase;
      readonly updatedAt: string;
    }
  | {
      readonly status: "compensating";
      readonly operationId: string;
      readonly phase: ThreadCreationCompensationPhase;
      readonly error: ThreadCreationErrorDetail;
      readonly updatedAt: string;
    }
  | {
      readonly status: "blocked";
      readonly operationId: string;
      readonly reason: ThreadCreationBlockedReason;
      readonly ownedResources: ReadonlyArray<ThreadCreationOwnedResource>;
      readonly error: ThreadCreationErrorDetail;
      readonly updatedAt: string;
    }
  | {
      readonly status: "completed";
      readonly operationId: string;
      readonly result: ThreadCreationCompletedResult;
      readonly updatedAt: string;
    }
  | {
      readonly status: "failed";
      readonly operationId: string;
      readonly error: ThreadCreationErrorDetail;
      readonly compensationCompleted: boolean;
      readonly updatedAt: string;
    };

export type ThreadCreationTerminalState = Extract<
  ThreadCreationOperationState,
  { readonly status: "completed" | "failed" | "blocked" }
>;
