// FILE: mobileErrors.ts
// Purpose: Single translation table from server-side failures to `mobile.v1`
//          error codes, so every bound method rejects the same way.
// Layer: Server mobile transport
// Exports: mobileInternalError, toMobileDispatchError, toMobileTargetError

import type { AgentGatewayTargetError } from "../agentGateway/targetResolver.ts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import { MobileGatewayError } from "./Services/MobileGateway.ts";

export const mobileInternalError = (cause: unknown, fallbackMessage: string): MobileGatewayError =>
  MobileGatewayError.of(
    "internal_error",
    cause instanceof Error && cause.message.length > 0 ? cause.message : fallbackMessage,
    { retryable: true },
  );

/**
 * Orchestration rejections carry the meaning the phone needs: a rejected
 * command is a conflict it must not retry, an overloaded queue is a backoff,
 * and an id collision means the retry did not match its original request.
 */
export const toMobileDispatchError = (error: OrchestrationDispatchError): MobileGatewayError => {
  switch (error._tag) {
    case "OrchestrationCommandAdmissionError":
      return error.reason === "overloaded"
        ? MobileGatewayError.of("rate_limited", error.message, {
            retryable: true,
            retryAfterMs: 1_000,
          })
        : MobileGatewayError.of("internal_error", error.message, { retryable: true });
    case "OrchestrationCommandInvariantError":
      return MobileGatewayError.of("conflict", error.message);
    case "OrchestrationCommandIdentityCollisionError":
      return MobileGatewayError.of("idempotency_conflict", error.message);
    case "OrchestrationCommandPreviouslyRejectedError":
      return MobileGatewayError.of("conflict", error.message);
    case "OrchestrationCommandTimeoutError":
      return MobileGatewayError.of("timeout", error.message, { retryable: true });
    default:
      return mobileInternalError(error, "The command could not be dispatched.");
  }
};

/**
 * The client's catalog is a cache, never an authority: an unresolvable target
 * tells it to refresh rather than to retry the same selection forever.
 */
export const toMobileTargetError = (error: AgentGatewayTargetError): MobileGatewayError =>
  MobileGatewayError.of(
    error.code === "provider_unavailable" ? "provider_unavailable" : "model_unavailable",
    error.message,
  );
