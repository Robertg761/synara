import { Effect } from "effect";

import { describeError } from "../durableOperations/errors.ts";
import type {
  ThreadCreationOperationRecord,
  ThreadCreationOperationStatus,
} from "./Services/ThreadCreationOperationRepository.ts";
import type { ThreadCreationCoordinatorError } from "./Services/ThreadCreationCoordinator.ts";
import type { ThreadCreationOperationState } from "./operationState.ts";

export interface ThreadCreationRecoverySummary {
  readonly inspected: number;
  readonly resumed: number;
  readonly completed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly stillPending: number;
  readonly unrecoverable: number;
}

const EMPTY_SUMMARY: ThreadCreationRecoverySummary = {
  inspected: 0,
  resumed: 0,
  completed: 0,
  failed: 0,
  blocked: 0,
  stillPending: 0,
  unrecoverable: 0,
};

/**
 * How each interrupted phase is driven forward. Every non-terminal phase is
 * resumable because the coordinator persisted its plan and derives every
 * command id from the operation id — the differences below are what the
 * coordinator's resume path does, restated here so the policy is auditable in
 * one place.
 */
const RESUME_INTENT: Record<ThreadCreationOperationStatus, string | null> = {
  // No side effect has been attempted; validation and planning run from scratch.
  reserved: "resume before side effects",
  // A checkout may exist at the operation-derived path without a durable
  // ownership proof; it is removed and recreated.
  "creating-worktree": "resume after discarding any unproven partial worktree",
  // Ownership is durable: the worktree is validated before the thread command.
  "creating-thread": "resume after worktree ownership validation",
  // The thread exists: the first turn is re-dispatched under the same command id.
  "starting-turn": "resume turn dispatch",
  // Cleanup was already in progress; continue releasing in reverse order.
  compensating: "continue reverse compensation",
  blocked: null,
  completed: null,
  failed: null,
};

export interface ThreadCreationRecoveryInput {
  readonly operationRepository: {
    readonly listNonTerminal: () => Effect.Effect<
      ReadonlyArray<Pick<ThreadCreationOperationRecord, "operationId" | "status">>,
      Error
    >;
  };
  readonly resume: (
    operationId: string,
  ) => Effect.Effect<ThreadCreationOperationState, ThreadCreationCoordinatorError>;
}

/**
 * Drive every thread-creation operation that a restart interrupted towards a
 * durable terminal state. This must run before mobile commands become
 * reachable: until it does, a resumed operation and a client retry could race
 * on the same worktree path.
 *
 * Recovery never fails the caller. An operation that cannot be resumed is left
 * non-terminal and logged, so the next startup retries it rather than leaving a
 * worktree orphaned by an aborted boot.
 */
export function recoverInterruptedThreadCreationOperations(
  input: ThreadCreationRecoveryInput,
): Effect.Effect<ThreadCreationRecoverySummary> {
  return Effect.gen(function* () {
    const interrupted = yield* input.operationRepository.listNonTerminal().pipe(
      Effect.catch((error) =>
        Effect.logWarning("thread creation recovery could not list interrupted operations", {
          error: describeError(error),
        }).pipe(
          Effect.as(
            [] as ReadonlyArray<Pick<ThreadCreationOperationRecord, "operationId" | "status">>,
          ),
        ),
      ),
    );
    if (interrupted.length === 0) return EMPTY_SUMMARY;

    let summary: ThreadCreationRecoverySummary = {
      ...EMPTY_SUMMARY,
      inspected: interrupted.length,
    };
    const bump = (key: keyof ThreadCreationRecoverySummary) => {
      summary = { ...summary, [key]: summary[key] + 1 };
    };

    // Sequential on purpose: concurrent resumes would contend on the same git
    // work tree lock and make startup latency unpredictable under a backlog.
    yield* Effect.forEach(
      interrupted,
      (operation) =>
        Effect.gen(function* () {
          const intent = RESUME_INTENT[operation.status];
          if (intent === null) return;
          yield* Effect.logInfo("resuming interrupted thread creation operation", {
            operationId: operation.operationId,
            status: operation.status,
            intent,
          });
          const state = yield* input.resume(operation.operationId);
          bump("resumed");
          switch (state.status) {
            case "completed":
              bump("completed");
              return;
            case "failed":
              bump("failed");
              return;
            case "blocked":
              bump("blocked");
              yield* Effect.logWarning(
                "thread creation operation needs manual attention after recovery",
                {
                  operationId: operation.operationId,
                  reason: state.reason,
                  ownedResources: state.ownedResources,
                },
              );
              return;
            default:
              bump("stillPending");
              yield* Effect.logWarning(
                "thread creation operation is still pending after recovery",
                {
                  operationId: operation.operationId,
                  status: state.status,
                },
              );
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              bump("unrecoverable");
            }).pipe(
              Effect.andThen(
                Effect.logWarning("thread creation operation could not be recovered", {
                  operationId: operation.operationId,
                  status: operation.status,
                  error: error.error.message,
                }),
              ),
            ),
          ),
        ),
      { concurrency: 1, discard: true },
    );

    return summary;
  });
}
