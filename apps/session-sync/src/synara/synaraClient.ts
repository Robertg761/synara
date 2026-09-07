// FILE: synaraClient.ts
// Purpose: Effect-RPC WebSocket client for the Synara server the daemon syncs into.
// Layer: Session-sync transport
//
// Mirrors the browser transport's connect sequence (HTTP negotiate -> feature
// socket) using the same contract constants, so the daemon stays compatible
// with whatever Synara build is running without pinning anything here.
// Authentication uses the loopback owner token (`?token=`); desktop instances
// bound to loopback also accept unauthenticated local sockets when no token is
// configured.

import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { Cause, Effect, Layer, ManagedRuntime, Scope } from "effect";

import {
  ORCHESTRATION_WS_METHODS,
  WS_COMPATIBILITY_QUERY,
  WS_FEATURE_PATH,
  WS_NEGOTIATE_HTTP_PATH,
  WS_NEGOTIATE_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WsFeatureRpcGroup,
  type ClientOrchestrationCommand,
  type ModelSelection,
  type ThreadId,
  type WsBootstrapNegotiateResult,
} from "@synara/contracts";

const makeRpcClient = RpcClient.make(WsFeatureRpcGroup);

type RpcClientEffect = typeof makeRpcClient;
type FeatureRpcClient =
  RpcClientEffect extends Effect.Effect<infer TClient, infer _E, infer _R> ? TClient : never;

export interface SynaraClientOptions {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly clientBuild: string;
  /** Extra capabilities to require; defaults to none so any server build works. */
  readonly requiredCapabilities?: readonly string[];
}

function baseWebSocketOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

export function makeNegotiateUrl(options: SynaraClientOptions): string {
  const url = new URL(`${baseWebSocketOrigin(options.baseUrl)}${WS_NEGOTIATE_HTTP_PATH}`);
  url.searchParams.set(WS_NEGOTIATE_QUERY.clientBuild, options.clientBuild);
  url.searchParams.set(WS_NEGOTIATE_QUERY.protocolEpoch, String(WS_PROTOCOL_EPOCH));
  url.searchParams.set(WS_NEGOTIATE_QUERY.minRevision, String(WS_PROTOCOL_MIN_REVISION));
  url.searchParams.set(WS_NEGOTIATE_QUERY.maxRevision, String(WS_PROTOCOL_MAX_REVISION));
  // Deliberately empty: the daemon only calls unary orchestration RPCs, so it
  // must not demand stream capabilities that older running servers may lack.
  // This is what keeps syncing working across Synara versions.
  for (const capability of options.requiredCapabilities ?? []) {
    url.searchParams.append(WS_NEGOTIATE_QUERY.requiredCapability, capability);
  }
  return url.toString();
}

export function makeAuthenticatedFeatureSocketUrl(
  options: SynaraClientOptions,
  negotiation: WsBootstrapNegotiateResult,
): string {
  const url = new URL(`${baseWebSocketOrigin(options.baseUrl)}${WS_FEATURE_PATH}`);
  url.searchParams.set(WS_COMPATIBILITY_QUERY.clientBuild, options.clientBuild);
  url.searchParams.set(WS_COMPATIBILITY_QUERY.protocolEpoch, String(negotiation.protocolEpoch));
  url.searchParams.set(
    WS_COMPATIBILITY_QUERY.protocolRevision,
    String(negotiation.negotiatedRevision),
  );
  url.searchParams.set(WS_COMPATIBILITY_QUERY.serverInstanceId, negotiation.serverInstanceId);
  if (options.token) url.searchParams.set("token", options.token);
  return url.toString();
}

export async function negotiateSynaraCompatibility(
  options: SynaraClientOptions,
): Promise<WsBootstrapNegotiateResult | null> {
  let response: Response;
  try {
    response = await fetch(makeNegotiateUrl(options), { cache: "no-store" });
  } catch {
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 426) {
    // Compatibility verdicts carry an actionable message; surface it verbatim.
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message?: unknown }).message)
        : `negotiation refused with status ${response.status}`;
    throw new Error(`Synara at ${options.baseUrl} refused the session: ${message}`);
  }
  if (!response.ok) return null;
  if (
    body &&
    typeof body === "object" &&
    "serverInstanceId" in body &&
    typeof (body as { serverInstanceId?: unknown }).serverInstanceId === "string"
  ) {
    return body as WsBootstrapNegotiateResult;
  }
  return null;
}

export interface SynaraConnection {
  readonly shellSnapshot: () => Promise<{
    projects: Array<{
      id: string;
      kind?: string;
      workspaceRoot: string;
      title: string;
      defaultModelSelection?: ModelSelection | null;
    }>;
  }>;
  readonly dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
  readonly importThread: (input: { threadId: ThreadId; externalId: string }) => Promise<{
    threadId: ThreadId;
  }>;
  readonly close: () => Promise<void>;
}

function describeThrown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as { _tag?: unknown; message?: unknown; reason?: unknown };
    // Effect failures arrive either as tagged errors or as full Causes; never
    // assume one shape — squashing a non-Cause crashes deep in Cause internals.
    if (Array.isArray((value as { reasons?: unknown }).reasons)) {
      try {
        return describeThrown(Cause.squash(value as Cause.Cause<unknown>));
      } catch {
        return JSON.stringify(value).slice(0, 300);
      }
    }
    const tag = typeof record._tag === "string" ? record._tag : null;
    const message =
      typeof record.message === "string" && record.message.length > 0
        ? record.message
        : record.reason !== undefined
          ? describeThrown(record.reason)
          : null;
    if (message !== null) return tag ? `${tag}: ${message}` : message;
  }
  return String(value);
}

/**
 * Opens one negotiated feature socket and returns thin promise wrappers around
 * the three orchestration methods the daemon needs. The socket layer re-dials
 * transparently on transient closes; persistent failures surface on the next
 * call and the main loop rebuilds the connection.
 */
export async function connectSynara(options: SynaraClientOptions): Promise<SynaraConnection> {
  const negotiation = await negotiateSynaraCompatibility(options);
  if (!negotiation) {
    throw new Error(
      `Could not negotiate a WebSocket session with Synara at ${options.baseUrl}. Is the instance running?`,
    );
  }

  const socketUrl = makeAuthenticatedFeatureSocketUrl(options, negotiation);
  const runtime = ManagedRuntime.make(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(socketUrl).pipe(
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
          ),
          RpcSerialization.layerJson,
        ),
      ),
    ),
  );
  const scope = runtime.runSync(Scope.make());

  let rawClient: FeatureRpcClient;
  try {
    rawClient = await runtime.runPromise(Scope.provide(scope)(makeRpcClient));
  } catch (cause) {
    await runtime.dispose();
    throw new Error(`Failed to establish the Synara RPC socket: ${describeThrown(cause)}`, {
      cause,
    });
  }

  const runCall = async <TInput, TResult>(method: string, input: TInput): Promise<TResult> => {
    const call = (
      rawClient as unknown as Record<
        string,
        (value: TInput) => Effect.Effect<TResult, unknown, never>
      >
    )[method];
    if (typeof call !== "function") {
      throw new Error(`Synara server does not expose RPC method '${method}'.`);
    }
    try {
      return await runtime.runPromise(call(input));
    } catch (cause) {
      throw new Error(describeThrown(cause), { cause });
    }
  };

  // Effect RPC clients expose one callable property per wire name
  // ("orchestration.*"); dispatchCommand takes the command itself, unwrapped.
  return {
    shellSnapshot: () =>
      runCall<
        Record<string, never>,
        {
          projects: Array<{
            id: string;
            kind?: string;
            workspaceRoot: string;
            title: string;
            defaultModelSelection?: ModelSelection | null;
          }>;
        }
      >(ORCHESTRATION_WS_METHODS.getShellSnapshot, {}),
    dispatchCommand: (command) =>
      runCall<ClientOrchestrationCommand, { sequence: number }>(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        command,
      ),
    importThread: (input) =>
      runCall<{ threadId: ThreadId; externalId: string }, { threadId: ThreadId }>(
        ORCHESTRATION_WS_METHODS.importThread,
        input,
      ),
    close: async () => {
      try {
        await runtime.dispose();
      } catch {
        // Disposal races during teardown are harmless for a fire-and-forget close.
      }
    },
  };
}
