import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  ThreadCreationErrorDetail,
  ThreadCreationOperationState,
  ThreadCreationRequest,
} from "../operationState.ts";

/**
 * The only failure the coordinator raises. It is reserved for rejections that
 * happen *before* the operation owns anything durable (id reuse with a
 * different plan) or for infrastructure failures that make the durable state
 * unreadable. Every other outcome is a `ThreadCreationOperationState`.
 */
export class ThreadCreationCoordinatorError extends Data.TaggedError(
  "ThreadCreationCoordinatorError",
)<{
  readonly error: ThreadCreationErrorDetail;
}> {
  static of(
    code: ThreadCreationErrorDetail["code"],
    message: string,
    options?: { readonly retryable?: boolean; readonly retryAfterMs?: number },
  ): ThreadCreationCoordinatorError {
    return new ThreadCreationCoordinatorError({
      error: {
        code,
        message,
        retryable: options?.retryable ?? false,
        ...(options?.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
      },
    });
  }
}

export interface ThreadCreationCoordinatorShape {
  /**
   * Run — or resume, or replay — the durable operation named by
   * `request.operationId`. Retrying with the same id and the same request is
   * always safe; retrying with a different request is an idempotency conflict.
   */
  readonly createAndStart: (
    request: ThreadCreationRequest,
  ) => Effect.Effect<ThreadCreationOperationState, ThreadCreationCoordinatorError>;
  readonly getOperation: (
    operationId: string,
  ) => Effect.Effect<ThreadCreationOperationState, ThreadCreationCoordinatorError>;
  /** Drive every non-terminal operation to a durable terminal state. */
  readonly recoverInterrupted: Effect.Effect<void>;
}

export class ThreadCreationCoordinator extends ServiceMap.Service<
  ThreadCreationCoordinator,
  ThreadCreationCoordinatorShape
>()("synara/threadCreation/Services/ThreadCreationCoordinator") {}
