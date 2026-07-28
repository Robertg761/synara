import { CommandId, MessageId, ThreadId } from "@synara/contracts";

import {
  canonicalJson,
  operationIsoNow,
  stableOperationDigest,
} from "../durableOperations/identity.ts";

export { canonicalJson };

export function slugifyAgentTask(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

export function gatewayIsoNow(): string {
  return operationIsoNow();
}

export function stableGatewayDigest(value: unknown, length = 32): string {
  return stableOperationDigest(value, length);
}

export function makeAgentCreationIds(operationId: string, index: number) {
  const id = stableGatewayDigest({ operationId, index }, 32);
  return {
    threadId: ThreadId.makeUnsafe(`agent-${id}`),
    threadCreateCommandId: CommandId.makeUnsafe(`agent:${id}:thread-create`),
    turnStartCommandId: CommandId.makeUnsafe(`agent:${id}:turn-start`),
    messageId: MessageId.makeUnsafe(`agent:${id}:message`),
    compensateCommandId: CommandId.makeUnsafe(`agent:${id}:compensate-delete`),
  };
}
