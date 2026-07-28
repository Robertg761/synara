import { CommandId, MessageId, ThreadId } from "@synara/contracts";

import { stableOperationDigest } from "../durableOperations/identity.ts";

export interface ThreadCreationIds {
  readonly threadId: ThreadId;
  readonly threadCreateCommandId: CommandId;
  readonly turnStartCommandId: CommandId;
  readonly messageId: MessageId;
  readonly compensateCommandId: CommandId;
}

/**
 * Every identifier the saga dispatches is derived from the operation id alone,
 * so a resumed operation re-dispatches the exact same commands and the
 * orchestration command receipts make the retry a no-op instead of a duplicate.
 */
export function makeThreadCreationIds(operationId: string): ThreadCreationIds {
  const id = stableOperationDigest({ scope: "thread-creation", operationId }, 32);
  return {
    threadId: ThreadId.makeUnsafe(`thread-${id}`),
    threadCreateCommandId: CommandId.makeUnsafe(`thread-creation:${id}:thread-create`),
    turnStartCommandId: CommandId.makeUnsafe(`thread-creation:${id}:turn-start`),
    messageId: MessageId.makeUnsafe(`thread-creation:${id}:message`),
    compensateCommandId: CommandId.makeUnsafe(`thread-creation:${id}:compensate-delete`),
  };
}

/** Deterministic worktree path segment, derived from the operation id. */
export function makeThreadCreationWorktreeSegment(operationId: string): string {
  return stableOperationDigest({ scope: "thread-creation-worktree", operationId }, 12);
}
