import type {
  MobileDescriptor,
  MobileError,
  MobileErrorCode,
  MobileHello,
  MobileHelloAccepted,
  MobileRequest,
  MobileServerFrame,
  MobileSubscribe,
  MobileSuccess,
} from "@synara/contracts";
import { Data, ServiceMap, type Effect, type Scope, type Stream } from "effect";

/**
 * The only failure type the gateway raises. It always carries a wire-ready
 * `MobileError`, so the transport never invents codes or messages of its own.
 */
export class MobileGatewayError extends Data.TaggedError("MobileGatewayError")<{
  readonly error: MobileError;
}> {
  static of(
    code: MobileErrorCode,
    message: string,
    options?: { readonly retryable?: boolean; readonly retryAfterMs?: number },
  ): MobileGatewayError {
    return new MobileGatewayError({
      error: {
        code,
        message,
        retryable: options?.retryable ?? false,
        ...(options?.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
      },
    });
  }
}

/** Per-connection state the handshake established, needed by bound methods. */
export interface MobileConnection {
  readonly negotiatedRevision: number;
}

export interface MobileGatewayShape {
  readonly getDescriptor: Effect.Effect<MobileDescriptor>;
  /**
   * Validates the handshake against this server generation. A rejection is
   * terminal for the connection: the client must re-bootstrap the descriptor.
   */
  readonly acceptHello: (
    hello: MobileHello,
  ) => Effect.Effect<MobileHelloAccepted, MobileGatewayError>;
  readonly handleRequest: (
    request: MobileRequest,
    connection: MobileConnection,
  ) => Effect.Effect<MobileSuccess, MobileGatewayError>;
  /**
   * Frames for one subscription, already tagged with its `subscriptionId`.
   * Recoverable desynchronization ends the stream with a `reset-required`
   * frame; everything else fails so the transport can report it once.
   */
  readonly subscribe: (
    frame: MobileSubscribe,
  ) => Stream.Stream<MobileServerFrame, MobileGatewayError, Scope.Scope>;
}

export class MobileGateway extends ServiceMap.Service<MobileGateway, MobileGatewayShape>()(
  "synara/mobile/Services/MobileGateway",
) {}
