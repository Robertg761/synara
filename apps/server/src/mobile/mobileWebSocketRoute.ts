// FILE: mobileWebSocketRoute.ts
// Purpose: `mobile.v1` WebSocket transport — handshake, frame dispatch, and the
//          subscription budget in front of the MobileGateway.
// Layer: Server mobile transport
// Exports: MobileConnectionSink, runMobileConnection, mobileWebSocketRouteLayer

import {
  MOBILE_AUTH_AUDIENCE,
  MOBILE_WEBSOCKET_PATH,
  MobileClientFrame,
  type MobileError,
  type MobileErrorCode,
  type MobileMethod,
  type MobileRequestId,
  type MobileServerFrame,
  type MobileStream,
  type MobileSubscriptionId,
} from "@synara/contracts";
import { Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Socket } from "effect/unstable/socket";

import { authErrorResponse, makeEffectAuthRequest } from "../auth/effectHttp";
import { ServerAuth } from "../auth/Services/ServerAuth";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { ServerConfig } from "../config";
import { trustedWebSocketRequestUrl } from "../wsUpgradeOrigin";
import {
  MobileGateway,
  MobileGatewayError,
  type MobileConnection,
  type MobileGatewayShape,
} from "./Services/MobileGateway";

/**
 * At most one subscription per stream on a connection. A phone renders one
 * shell and one thread at a time; a second live subscription would double the
 * server-side projection work for a view nobody is looking at.
 */
const MOBILE_SUBSCRIPTION_BUDGET_PER_STREAM = 1;

const CLOSE_CODE_POLICY_VIOLATION = 1008;

const decodeClientFrame = Schema.decodeUnknownEffect(MobileClientFrame);
const textDecoder = new TextDecoder();

const mobileError = (code: MobileErrorCode, message: string, retryable = false): MobileError => ({
  code,
  message,
  retryable,
});

const failureFrame = (
  requestId: MobileRequestId | null,
  method: MobileMethod | null,
  error: MobileError,
): MobileServerFrame => ({ type: "failure", requestId, method, error });

export interface MobileConnectionSink {
  /**
   * Best effort: a write that cannot reach the peer is not an error the
   * protocol can report, and the dead socket already ends the read loop.
   */
  readonly write: (frame: MobileServerFrame) => Effect.Effect<void>;
  readonly close: (reason: string) => Effect.Effect<void>;
}

/**
 * The entry is registered before its fiber is forked, so a fiber that finishes
 * immediately still finds itself in the map and frees the slot. `fiber` is
 * therefore filled in a moment later — always before the read loop can process
 * the next frame, which is the only place it is read.
 */
interface ActiveSubscription {
  readonly stream: MobileStream;
  fiber: Fiber.Fiber<void> | null;
}

interface PendingRequest {
  readonly method: MobileMethod;
  fiber: Fiber.Fiber<void> | null;
}

/**
 * Drives one `mobile.v1` connection. Transport-agnostic on purpose: the route
 * supplies a socket-backed sink and read loop, tests supply their own, and both
 * exercise the same handshake, allowlist, and budget rules.
 */
export const runMobileConnection = <E>(input: {
  readonly gateway: MobileGatewayShape;
  readonly sink: MobileConnectionSink;
  /** Runs until the peer goes away, invoking the handler for each raw frame. */
  readonly receive: (
    onFrame: (data: string | Uint8Array) => Effect.Effect<void>,
  ) => Effect.Effect<void, E>;
}): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const { gateway, sink } = input;
    // Subscriptions and in-flight requests outlive the frame that started them
    // but never the connection, so they are forked into a scope closed below.
    const scope = yield* Scope.make("sequential");
    const subscriptions = new Map<MobileSubscriptionId, ActiveSubscription>();
    const pending = new Map<MobileRequestId, PendingRequest>();
    let connection: MobileConnection | null = null;
    let closed = false;

    const rejectConnection = (error: MobileError) =>
      Effect.suspend(() => {
        if (closed) return Effect.void;
        closed = true;
        return sink
          .write(failureFrame(null, null, error))
          .pipe(Effect.andThen(sink.close(error.message)));
      });

    const handleHello = (frame: Extract<MobileClientFrame, { type: "hello" }>) => {
      if (connection) {
        return rejectConnection(
          mobileError("invalid_request", "This connection already completed its handshake."),
        );
      }
      return gateway.acceptHello(frame).pipe(
        Effect.matchEffect({
          onFailure: (error: MobileGatewayError) => rejectConnection(error.error),
          onSuccess: (accepted) =>
            Effect.sync(() => {
              connection = { negotiatedRevision: accepted.negotiatedRevision };
            }).pipe(Effect.andThen(sink.write(accepted))),
        }),
      );
    };

    const handleRequest = (
      frame: Extract<MobileClientFrame, { type: "request" }>,
      established: MobileConnection,
    ) => {
      if (pending.has(frame.requestId)) {
        return sink.write(
          failureFrame(
            frame.requestId,
            frame.method,
            mobileError("invalid_request", "This request id is already in flight."),
          ),
        );
      }
      // Forked so a slow or timing-out method never stalls the read loop and the
      // client can still cancel it or drive its subscriptions.
      const entry: PendingRequest = { method: frame.method, fiber: null };
      pending.set(frame.requestId, entry);
      return gateway.handleRequest(frame, established).pipe(
        Effect.matchEffect({
          onFailure: (error: MobileGatewayError) =>
            sink.write(failureFrame(frame.requestId, frame.method, error.error)),
          onSuccess: (success) => sink.write(success),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (pending.get(frame.requestId) === entry) pending.delete(frame.requestId);
          }),
        ),
        Effect.forkIn(scope),
        Effect.map((forked) => {
          entry.fiber = forked;
        }),
      );
    };

    const handleCancelRequest = (frame: Extract<MobileClientFrame, { type: "cancel-request" }>) => {
      const entry = pending.get(frame.requestId);
      // Unknown ids are ignored: the request already completed, and a phone that
      // retries a cancel after a reconnect must not be told it did something wrong.
      if (!entry?.fiber) return Effect.void;
      pending.delete(frame.requestId);
      return Fiber.interrupt(entry.fiber).pipe(
        Effect.andThen(
          sink.write(
            failureFrame(
              frame.requestId,
              entry.method,
              mobileError("cancelled", "The request was cancelled by the client."),
            ),
          ),
        ),
      );
    };

    const handleSubscribe = (frame: Extract<MobileClientFrame, { type: "subscribe" }>) => {
      if (subscriptions.has(frame.subscriptionId)) {
        return sink.write(
          failureFrame(
            null,
            null,
            mobileError(
              "invalid_request",
              `Subscription ${frame.subscriptionId} is already active.`,
            ),
          ),
        );
      }
      let active = 0;
      for (const entry of subscriptions.values()) {
        if (entry.stream === frame.stream) active += 1;
      }
      if (active >= MOBILE_SUBSCRIPTION_BUDGET_PER_STREAM) {
        // `failure` carries no subscription id, so the rejected id goes in the
        // message: the client must be able to tell which subscribe was refused.
        return sink.write(
          failureFrame(
            null,
            null,
            mobileError(
              "stream_limit_exceeded",
              `Subscription ${frame.subscriptionId} exceeds the ${frame.stream} budget of ${MOBILE_SUBSCRIPTION_BUDGET_PER_STREAM} for this connection.`,
            ),
          ),
        );
      }

      const entry: ActiveSubscription = { stream: frame.stream, fiber: null };
      subscriptions.set(frame.subscriptionId, entry);
      return gateway.subscribe(frame).pipe(
        Stream.runForEach(sink.write),
        Effect.scoped,
        Effect.catch((error: MobileGatewayError) =>
          sink.write(failureFrame(null, null, error.error)),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (subscriptions.get(frame.subscriptionId) === entry) {
              subscriptions.delete(frame.subscriptionId);
            }
          }),
        ),
        Effect.forkIn(scope),
        Effect.map((forked) => {
          entry.fiber = forked;
        }),
      );
    };

    const handleUnsubscribe = (frame: Extract<MobileClientFrame, { type: "unsubscribe" }>) => {
      const entry = subscriptions.get(frame.subscriptionId);
      if (!entry?.fiber) return Effect.void;
      subscriptions.delete(frame.subscriptionId);
      return Fiber.interrupt(entry.fiber);
    };

    const dispatch = (frame: MobileClientFrame) => {
      if (frame.type === "hello") return handleHello(frame);
      const established = connection;
      if (!established) {
        return rejectConnection(
          mobileError("invalid_request", "The first frame on a mobile connection must be a hello."),
        );
      }
      switch (frame.type) {
        case "request":
          return handleRequest(frame, established);
        case "cancel-request":
          return handleCancelRequest(frame);
        case "subscribe":
          return handleSubscribe(frame);
        case "unsubscribe":
          return handleUnsubscribe(frame);
        case "pong":
          // Liveness is observed, not answered.
          return Effect.void;
      }
    };

    const onFrame = (data: string | Uint8Array) =>
      Effect.suspend(() => {
        if (closed) return Effect.void;
        const text = typeof data === "string" ? data : textDecoder.decode(data);
        return Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (cause) => cause,
        }).pipe(
          Effect.flatMap(decodeClientFrame),
          Effect.matchEffect({
            // A frame that does not decode cannot be correlated to a request or a
            // subscription, and an unknown method never reaches dispatch because
            // the frame union *is* the allowlist. Ending the connection is the
            // only unambiguous answer.
            onFailure: () =>
              rejectConnection(
                mobileError("invalid_request", "The frame is not a valid mobile.v1 client frame."),
              ),
            onSuccess: dispatch,
          }),
        );
      });

    return yield* input.receive(onFrame).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
  });

const makeSocketSink = (
  write: (
    chunk: Uint8Array | string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>,
): MobileConnectionSink => ({
  // Every mobile frame is JSON-plain (the schemas encode to themselves), so the
  // wire form needs no per-frame schema encoding pass.
  write: (frame) => write(JSON.stringify(frame)).pipe(Effect.ignore),
  close: (reason) =>
    write(new Socket.CloseEvent(CLOSE_CODE_POLICY_VIOLATION, reason)).pipe(Effect.ignore),
});

export const mobileWebSocketRouteLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add(
      "GET",
      MOBILE_WEBSOCKET_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const gateway = yield* MobileGateway;

        const url = trustedWebSocketRequestUrl(request, config);
        if (!url) {
          return HttpServerResponse.text("Forbidden", { status: 403 });
        }
        // Single-use ticket or bearer session, one validator, and the mobile
        // audience is the reason a browser credential cannot open this route.
        const session = yield* serverAuth.authenticateWebSocketUpgrade(
          makeEffectAuthRequest(request),
          { requiredAudience: MOBILE_AUTH_AUDIENCE },
        );
        if (session.role !== "client") {
          return HttpServerResponse.text("This session cannot use the mobile endpoint.", {
            status: 403,
            headers: { "Cache-Control": "no-store" },
          });
        }

        // The upgrade happens inside the authenticated connection so a capacity
        // rejection is still an HTTP status the client can read, and a revoked
        // session interrupts this fiber, which closes the socket.
        return yield* sessions.runAuthenticatedConnection(
          session.sessionId,
          Effect.gen(function* () {
            const socket = yield* request.upgrade;
            const write = yield* socket.writer;
            const sink = makeSocketSink(write);
            yield* runMobileConnection({
              gateway,
              sink,
              // The 2 MiB frame ceiling is the shared WebSocket server's
              // `maxPayload`; an oversized frame never reaches this loop.
              receive: (onFrame) => socket.runRaw(onFrame),
            }).pipe(Effect.catchTag("SocketError", () => Effect.void));
            return HttpServerResponse.empty();
          }).pipe(Effect.scoped),
        );
      }).pipe(
        Effect.catchTags({
          AuthError: (error) => Effect.succeed(authErrorResponse(error)),
          HttpServerError: () =>
            Effect.succeed(
              HttpServerResponse.text("Expected a WebSocket upgrade request.", { status: 400 }),
            ),
          SessionCapacityError: (error) =>
            Effect.succeed(
              HttpServerResponse.text(error.message, {
                status: 429,
                headers: {
                  "Cache-Control": "no-store",
                  "Retry-After": String(error.retryAfterSeconds),
                },
              }),
            ),
          SessionCredentialError: (error) =>
            Effect.succeed(HttpServerResponse.text(error.message, { status: 401 })),
        }),
      ),
    );
  }),
);
