import type {
  MobileCreateWorkspaceThreadInput,
  MobileError,
  MobileOperationId,
  MobileWorkspaceThreadCompleted,
  MobileWorkspaceThreadOperation,
} from "@synara/contracts";

import type {
  ThreadCreationErrorCode,
  ThreadCreationErrorDetail,
  ThreadCreationOperationState,
  ThreadCreationRequest,
} from "./operationState.ts";

/**
 * Compile-time proof that the coordinator can only produce codes the mobile
 * wire protocol can carry. If a code is added to one side without the other,
 * this assignment fails to typecheck instead of failing at runtime.
 */
const _errorCodeIsWireRepresentable: MobileError["code"] =
  null as unknown as ThreadCreationErrorCode;
void _errorCodeIsWireRepresentable;

export function toMobileError(error: ThreadCreationErrorDetail): MobileError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  };
}

/** The mobile input is already the coordinator's request shape, minus branding. */
export function fromMobileCreateWorkspaceThreadInput(
  input: MobileCreateWorkspaceThreadInput,
): ThreadCreationRequest {
  return {
    operationId: input.operationId,
    projectId: input.projectId,
    target: input.target,
    ...(input.title === undefined ? {} : { title: input.title }),
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    firstMessage: { text: input.firstMessage.text },
  };
}

/**
 * Total projection of the coordinator's state onto `mobile.v1`. The union is
 * exhaustive by construction: every internal status has exactly one wire
 * status, so a new state cannot silently fall through to a generic failure.
 *
 * `operationId` is carried through verbatim. The mobile bind decodes it as a
 * `MobileOperationId` before it ever reaches the coordinator, so the value is
 * already UUID-shaped by the time it comes back out.
 */
export function toMobileWorkspaceThreadOperation(
  state: ThreadCreationOperationState,
): MobileWorkspaceThreadOperation {
  const operationId = state.operationId as MobileOperationId;
  switch (state.status) {
    case "not-found":
      return { status: "not-found", operationId };
    case "pending":
      return {
        status: "pending",
        operationId,
        phase: state.phase,
        updatedAt: state.updatedAt,
      };
    case "compensating":
      return {
        status: "compensating",
        operationId,
        phase: state.phase,
        error: toMobileError(state.error),
        updatedAt: state.updatedAt,
      };
    case "blocked":
      return {
        status: "blocked",
        operationId,
        reason: state.reason,
        ownedResources: state.ownedResources,
        error: toMobileError(state.error),
        updatedAt: state.updatedAt,
      };
    case "completed":
      return toMobileWorkspaceThreadCompleted(state);
    case "failed":
      return {
        status: "failed",
        operationId,
        error: toMobileError(state.error),
        compensationCompleted: state.compensationCompleted,
        updatedAt: state.updatedAt,
      };
  }
}

export function toMobileWorkspaceThreadCompleted(
  state: Extract<ThreadCreationOperationState, { readonly status: "completed" }>,
): MobileWorkspaceThreadCompleted {
  return {
    status: "completed",
    operationId: state.operationId as MobileOperationId,
    threadId: state.result.threadId,
    messageId: state.result.messageId,
    commandId: state.result.commandId,
    acceptedSequence: state.result.acceptedSequence,
    thread: state.result.thread,
    worktree: state.result.worktree,
    updatedAt: state.updatedAt,
  };
}
