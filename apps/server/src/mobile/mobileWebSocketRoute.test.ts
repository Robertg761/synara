import {
  EnvironmentId,
  MOBILE_PROTOCOL_EPOCH,
  ThreadId,
  type MobileRequestId,
  type MobileServerFrame,
  type MobileSubscriptionId,
} from "@synara/contracts";
import { Duration, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { MobileGatewayError, type MobileGatewayShape } from "./Services/MobileGateway";
import { runMobileConnection, type MobileConnectionSink } from "./mobileWebSocketRoute";

const ENVIRONMENT_ID = EnvironmentId.makeUnsafe("11111111-1111-4111-8111-111111111111");
const SERVER_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const SUBSCRIPTION_A = "33333333-3333-4333-8333-333333333333" as MobileSubscriptionId;
const SUBSCRIPTION_B = "55555555-5555-4555-8555-555555555555" as MobileSubscriptionId;
const REQUEST_A = "44444444-4444-4444-8444-444444444444" as MobileRequestId;
const REQUEST_B = "66666666-6666-4666-8666-666666666666" as MobileRequestId;

const HELLO = {
  type: "hello",
  protocol: MOBILE_PROTOCOL_EPOCH,
  minRevision: 1,
  maxRevision: 1,
  environmentId: ENVIRONMENT_ID,
  serverInstanceId: SERVER_INSTANCE_ID,
  clientBuild: "ios-test",
};

const subscribeShell = (subscriptionId: MobileSubscriptionId) => ({
  type: "subscribe",
  subscriptionId,
  stream: "orchestration.shell",
  params: {},
});

const probeRequest = (requestId: MobileRequestId) => ({
  type: "request",
  requestId,
  method: "connection.probe",
  params: {},
});

const helloAccepted: MobileServerFrame = {
  type: "hello-accepted",
  protocol: MOBILE_PROTOCOL_EPOCH,
  negotiatedRevision: 1,
  environmentId: ENVIRONMENT_ID,
  serverInstanceId: SERVER_INSTANCE_ID,
  serverBuild: "0.0.0-test",
  capabilities: [],
};

const probeSuccess = (requestId: MobileRequestId): MobileServerFrame => ({
  type: "success",
  requestId,
  method: "connection.probe",
  result: {
    environmentId: ENVIRONMENT_ID,
    serverInstanceId: SERVER_INSTANCE_ID,
    negotiatedRevision: 1,
    serverTime: "2026-01-01T00:00:00.000Z",
  },
});

const makeGateway = (overrides: Partial<MobileGatewayShape> = {}): MobileGatewayShape => ({
  getDescriptor: Effect.die("The descriptor is served over HTTP, not this socket."),
  acceptHello: () =>
    Effect.succeed(helloAccepted as Extract<MobileServerFrame, { type: "hello-accepted" }>),
  handleRequest: (request) =>
    Effect.succeed(
      probeSuccess(request.requestId) as Extract<MobileServerFrame, { type: "success" }>,
    ),
  subscribe: () => Stream.never,
  ...overrides,
});

const waitUntil = (predicate: () => boolean): Effect.Effect<void> => {
  const poll: Effect.Effect<void> = Effect.suspend(() =>
    predicate() ? Effect.void : Effect.sleep(Duration.millis(1)).pipe(Effect.andThen(poll)),
  );
  return poll.pipe(
    Effect.timeoutOrElse({ duration: Duration.seconds(2), onTimeout: () => Effect.void }),
  );
};

interface ConnectionResult {
  readonly written: ReadonlyArray<MobileServerFrame>;
  readonly closes: ReadonlyArray<string>;
}

const drive = (input: {
  readonly gateway?: MobileGatewayShape;
  /** Raw strings are sent verbatim; anything else is JSON-encoded first. */
  readonly frames: ReadonlyArray<unknown>;
  readonly until?: (written: ReadonlyArray<MobileServerFrame>) => boolean;
}): Promise<ConnectionResult> => {
  const written: MobileServerFrame[] = [];
  const closes: string[] = [];
  const sink: MobileConnectionSink = {
    write: (frame) =>
      Effect.sync(() => {
        written.push(frame);
      }),
    close: (reason) =>
      Effect.sync(() => {
        closes.push(reason);
      }),
  };

  return runMobileConnection({
    gateway: input.gateway ?? makeGateway(),
    sink,
    receive: (onFrame) =>
      Effect.forEach(
        input.frames,
        (frame) => onFrame(typeof frame === "string" ? frame : JSON.stringify(frame)),
        { discard: true },
      ).pipe(Effect.andThen(input.until ? waitUntil(() => input.until!(written)) : Effect.void)),
  }).pipe(Effect.as<ConnectionResult>({ written, closes }), Effect.runPromise);
};

const failures = (result: ConnectionResult) =>
  result.written.filter((frame) => frame.type === "failure");

describe("runMobileConnection", () => {
  it("requires the handshake before any other frame", async () => {
    const result = await drive({ frames: [subscribeShell(SUBSCRIPTION_A)] });

    expect(result.written).toHaveLength(1);
    expect(result.written[0]).toMatchObject({
      type: "failure",
      requestId: null,
      method: null,
      error: { code: "invalid_request" },
    });
    expect(result.closes).toHaveLength(1);
  });

  it("closes the connection on a frame that is not valid JSON", async () => {
    const result = await drive({ frames: ["{not json"] });

    expect(failures(result)[0]).toMatchObject({ error: { code: "invalid_request" } });
    expect(result.closes).toHaveLength(1);
  });

  it("closes the connection on a method outside the allowlist", async () => {
    // The frame union is the allowlist, so an unknown method cannot decode and
    // never reaches dispatch.
    const result = await drive({
      frames: [
        HELLO,
        { type: "request", requestId: REQUEST_A, method: "terminal.write", params: {} },
      ],
    });

    expect(result.written[0]).toMatchObject({ type: "hello-accepted" });
    expect(failures(result)[0]).toMatchObject({ error: { code: "invalid_request" } });
    expect(result.closes).toHaveLength(1);
  });

  it("closes the connection on a stream outside the allowlist", async () => {
    const result = await drive({
      frames: [
        HELLO,
        {
          type: "subscribe",
          subscriptionId: SUBSCRIPTION_A,
          stream: "terminal.output",
          params: {},
        },
      ],
    });

    expect(failures(result)[0]).toMatchObject({ error: { code: "invalid_request" } });
    expect(result.closes).toHaveLength(1);
  });

  it("reports and closes when the gateway rejects the handshake", async () => {
    const result = await drive({
      gateway: makeGateway({
        acceptHello: () =>
          Effect.fail(
            MobileGatewayError.of("server_instance_changed", "The Synara server restarted.", {
              retryable: true,
            }),
          ),
      }),
      frames: [HELLO],
    });

    expect(result.written).toEqual([
      {
        type: "failure",
        requestId: null,
        method: null,
        error: {
          code: "server_instance_changed",
          message: "The Synara server restarted.",
          retryable: true,
        },
      },
    ]);
    expect(result.closes).toEqual(["The Synara server restarted."]);
  });

  it("rejects a second handshake on the same connection", async () => {
    const result = await drive({ frames: [HELLO, HELLO] });

    expect(result.written[0]).toMatchObject({ type: "hello-accepted" });
    expect(failures(result)[0]).toMatchObject({ error: { code: "invalid_request" } });
    expect(result.closes).toHaveLength(1);
  });

  it("answers an allowlisted request with the gateway's success frame", async () => {
    const result = await drive({
      frames: [HELLO, probeRequest(REQUEST_A)],
      until: (written) => written.length >= 2,
    });

    expect(result.written).toEqual([helloAccepted, probeSuccess(REQUEST_A)]);
    expect(result.closes).toHaveLength(0);
  });

  it("translates a gateway failure into a correlated failure frame", async () => {
    const result = await drive({
      gateway: makeGateway({
        handleRequest: () =>
          Effect.fail(
            MobileGatewayError.of("timeout", "The connection probe timed out.", {
              retryable: true,
            }),
          ),
      }),
      frames: [HELLO, probeRequest(REQUEST_A)],
      until: (written) => written.length >= 2,
    });

    expect(result.written[1]).toMatchObject({
      type: "failure",
      requestId: REQUEST_A,
      method: "connection.probe",
      error: { code: "timeout", retryable: true },
    });
    expect(result.closes).toHaveLength(0);
  });

  it("rejects a duplicate in-flight request id without disturbing the original", async () => {
    const result = await drive({
      gateway: makeGateway({ handleRequest: () => Effect.never }),
      frames: [HELLO, probeRequest(REQUEST_A), probeRequest(REQUEST_A)],
      until: (written) => written.length >= 2,
    });

    expect(result.written[1]).toMatchObject({
      type: "failure",
      requestId: REQUEST_A,
      method: "connection.probe",
      error: { code: "invalid_request" },
    });
    expect(result.closes).toHaveLength(0);
  });

  it("cancels an in-flight request and reports it as cancelled", async () => {
    const result = await drive({
      gateway: makeGateway({ handleRequest: () => Effect.never }),
      frames: [HELLO, probeRequest(REQUEST_A), { type: "cancel-request", requestId: REQUEST_A }],
      until: (written) => written.length >= 2,
    });

    expect(result.written[1]).toMatchObject({
      type: "failure",
      requestId: REQUEST_A,
      method: "connection.probe",
      error: { code: "cancelled" },
    });
  });

  it("ignores a cancel for a request it does not know", async () => {
    const result = await drive({
      frames: [HELLO, { type: "cancel-request", requestId: REQUEST_B }],
    });

    expect(failures(result)).toHaveLength(0);
    expect(result.closes).toHaveLength(0);
  });

  it("forwards subscription frames to the client", async () => {
    const frames: ReadonlyArray<MobileServerFrame> = [
      {
        type: "snapshot",
        subscriptionId: SUBSCRIPTION_A,
        stream: "orchestration.shell",
        snapshot: {
          snapshotSequence: 7,
          updatedAt: "2026-01-01T00:00:00.000Z",
          spaces: [],
          projects: [],
          threads: [],
        },
      },
      {
        type: "synchronized",
        subscriptionId: SUBSCRIPTION_A,
        stream: "orchestration.shell",
        sequence: 7,
      },
    ];
    const result = await drive({
      gateway: makeGateway({ subscribe: () => Stream.fromIterable(frames) }),
      frames: [HELLO, subscribeShell(SUBSCRIPTION_A)],
      until: (written) => written.length >= 3,
    });

    expect(result.written).toEqual([helloAccepted, ...frames]);
  });

  it("reports a subscription failure without ending the connection", async () => {
    const result = await drive({
      gateway: makeGateway({
        subscribe: () =>
          Stream.fail(MobileGatewayError.of("not_found", "Thread thread-1 was not found.")),
      }),
      frames: [
        HELLO,
        {
          type: "subscribe",
          subscriptionId: SUBSCRIPTION_A,
          stream: "orchestration.thread",
          params: { threadId: ThreadId.makeUnsafe("thread-1") },
        },
      ],
      until: (written) => written.length >= 2,
    });

    expect(result.written[1]).toMatchObject({
      type: "failure",
      error: { code: "not_found" },
    });
    expect(result.closes).toHaveLength(0);
  });

  it("rejects a second subscription on the same stream", async () => {
    const result = await drive({
      frames: [HELLO, subscribeShell(SUBSCRIPTION_A), subscribeShell(SUBSCRIPTION_B)],
      until: (written) => written.length >= 2,
    });

    expect(result.written[1]).toMatchObject({
      type: "failure",
      requestId: null,
      method: null,
      error: { code: "stream_limit_exceeded" },
    });
    expect((result.written[1] as { error: { message: string } }).error.message).toContain(
      SUBSCRIPTION_B,
    );
    expect(result.closes).toHaveLength(0);
  });

  it("rejects a reused subscription id", async () => {
    const result = await drive({
      frames: [HELLO, subscribeShell(SUBSCRIPTION_A), subscribeShell(SUBSCRIPTION_A)],
      until: (written) => written.length >= 2,
    });

    expect(result.written[1]).toMatchObject({
      type: "failure",
      error: { code: "invalid_request" },
    });
    expect((result.written[1] as { error: { message: string } }).error.message).toContain(
      SUBSCRIPTION_A,
    );
  });

  it("frees the stream budget when a subscription is cancelled", async () => {
    const result = await drive({
      frames: [
        HELLO,
        subscribeShell(SUBSCRIPTION_A),
        { type: "unsubscribe", subscriptionId: SUBSCRIPTION_A },
        subscribeShell(SUBSCRIPTION_B),
      ],
    });

    expect(failures(result)).toHaveLength(0);
    expect(result.closes).toHaveLength(0);
  });

  it("interrupts an in-flight request when the socket generation ends", async () => {
    let started = false;
    let interrupted = false;
    await drive({
      gateway: makeGateway({
        handleRequest: () =>
          Effect.sync(() => {
            started = true;
          }).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
      }),
      frames: [HELLO, probeRequest(REQUEST_A)],
      until: () => started,
    });

    expect(interrupted).toBe(true);
  });

  it("closes subscription stream scopes when the socket generation ends", async () => {
    let acquired = false;
    let released = false;
    await drive({
      gateway: makeGateway({
        subscribe: () =>
          Stream.unwrap(
            Effect.acquireRelease(
              Effect.sync(() => {
                acquired = true;
              }),
              () =>
                Effect.sync(() => {
                  released = true;
                }),
            ).pipe(Effect.as(Stream.never)),
          ),
      }),
      frames: [HELLO, subscribeShell(SUBSCRIPTION_A)],
      until: () => acquired,
    });

    expect(released).toBe(true);
  });

  it("observes pong without answering it", async () => {
    const result = await drive({ frames: [HELLO, { type: "pong", nonce: "n-1" }] });

    expect(result.written).toEqual([helloAccepted]);
    expect(result.closes).toHaveLength(0);
  });
});
