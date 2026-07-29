/**
 * `mobile.v1` — the language-neutral façade the native iOS client speaks.
 *
 * This module is the single schema source for the mobile protocol. It is a
 * deliberately narrow, versioned slice over existing Synara contracts: where an
 * existing type is the right payload it is imported, never forked. Everything
 * exported here carries a `Mobile` prefix because `index.ts` re-exports every
 * module with `export *`.
 *
 * Decode semantics Swift may rely on: object decoding uses Effect's default
 * `onExcessProperty: "ignore"`, so additive server fields never break an older
 * client. Removing or retyping a field is a revision bump.
 */
import { Schema } from "effect";

import {
  ApprovalRequestId,
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ExecutionEnvironmentDescriptor } from "./environment";
import { GitBranch } from "./git";
import {
  ModelSelection,
  OrchestrationEvent,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderKind,
  ProviderUserInputAnswers,
  RuntimeMode,
  TurnDispatchMode,
} from "./orchestration";
import { ProviderModelDescriptor } from "./providerDiscovery";
import { ServerProviderAuthStatus } from "./server";

export const MOBILE_PROTOCOL_EPOCH = 1;
export const MOBILE_PROTOCOL_MIN_REVISION = 1;
export const MOBILE_PROTOCOL_MAX_REVISION = 1;

export const MOBILE_DESCRIPTOR_PATH = "/api/mobile/v1/descriptor";
export const MOBILE_WEBSOCKET_PATH = "/api/mobile/v1/ws";

/** Session/pairing audience the mobile route requires and browser routes reject. */
export const MOBILE_AUTH_AUDIENCE = "mobile-v1";

export const MOBILE_PAIRING_PAYLOAD_VERSION = 1;

// ── Identifiers ───────────────────────────────────────────────────────

// Any UUID version is accepted: Swift's `UUID().uuidString` is uppercase v4,
// while server-side generators may emit lowercase v4 or v7.
const MobileUuid = Schema.String.check(Schema.isUUID(undefined));

export const MobileRequestId = MobileUuid.pipe(Schema.brand("MobileRequestId"));
export type MobileRequestId = typeof MobileRequestId.Type;

export const MobileSubscriptionId = MobileUuid.pipe(Schema.brand("MobileSubscriptionId"));
export type MobileSubscriptionId = typeof MobileSubscriptionId.Type;

export const MobileOperationId = MobileUuid.pipe(Schema.brand("MobileOperationId"));
export type MobileOperationId = typeof MobileOperationId.Type;

/** Opaque handle for an owner-approved workspace root. iOS never sees the path it resolves to. */
export const MobileRootId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("MobileRootId"),
);
export type MobileRootId = typeof MobileRootId.Type;

export const MOBILE_RELATIVE_PATH_MAX_LENGTH = 512;

// Mobile filesystem inputs are always `rootId` + a normalized relative path: no
// absolute path, no `..` segment, no backslash. The server still resolves and
// re-validates canonically; this check only keeps obvious escapes off the wire.
// The NUL exclusion is deliberate: a NUL byte truncates the path in some syscall
// layers, so it must never survive the schema boundary.
// oxlint-disable-next-line no-control-regex
const MOBILE_RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]*$/;

export const MobileRelativePath = Schema.String.check(
  Schema.isMaxLength(MOBILE_RELATIVE_PATH_MAX_LENGTH),
  Schema.isPattern(MOBILE_RELATIVE_PATH_PATTERN),
);
export type MobileRelativePath = typeof MobileRelativePath.Type;

// ── Method / stream / capability allowlists ───────────────────────────

// The allowlist is the mobile permission boundary: there is no generic method
// passthrough to `NativeApi`. Terminal is deliberately absent in revision 1.
export const MOBILE_METHODS = [
  "connection.probe",
  "project.create",
  "projects.listRoots",
  "projects.listDirectories",
  "provider.listProviders",
  "provider.listModels",
  "git.listBranches",
  "workspaceThread.createAndStart",
  "workspaceThread.getOperation",
  "clientTurn.start",
  "clientTurn.interrupt",
  "clientTurn.respondApproval",
  "clientTurn.respondUserInput",
  "clientThread.update",
] as const;

export const MobileMethod = Schema.Literals(MOBILE_METHODS);
export type MobileMethod = typeof MobileMethod.Type;

export const MOBILE_STREAMS = [
  "orchestration.shell",
  "orchestration.thread",
  "provider.statuses",
] as const;

export const MobileStream = Schema.Literals(MOBILE_STREAMS);
export type MobileStream = typeof MobileStream.Type;

export const MOBILE_CAPABILITIES = [
  "mobile.shell-sync",
  "mobile.thread-sync",
  "mobile.project-browse",
  "mobile.models",
  "mobile.worktree-creation",
  "mobile.interactive-turns",
] as const;

export const MobileCapability = Schema.Literals(MOBILE_CAPABILITIES);
export type MobileCapability = typeof MobileCapability.Type;

// ── HTTP bootstrap ────────────────────────────────────────────────────

export const MobileDescriptor = Schema.Struct({
  protocolEpoch: Schema.Int,
  minRevision: NonNegativeInt,
  maxRevision: NonNegativeInt,
  serverInstanceId: TrimmedNonEmptyString,
  serverBuild: TrimmedNonEmptyString,
  environment: ExecutionEnvironmentDescriptor,
  capabilities: Schema.Array(MobileCapability),
});
export type MobileDescriptor = typeof MobileDescriptor.Type;

/**
 * QR / deep-link pairing payload. The credential is single-use and short lived;
 * it must ride in a URL fragment or the encoded QR body and must never be
 * logged or placed in an HTTP query.
 */
export const MobilePairingPayload = Schema.Struct({
  version: Schema.Int,
  baseUrl: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  credential: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type MobilePairingPayload = typeof MobilePairingPayload.Type;

// ── Owner-facing mobile access configuration ──────────────────────────

/** Persisted by the desktop shell under `<userData>/` with mode 0600. */
export const MOBILE_ACCESS_CONFIG_FILE_NAME = "mobile-access.json";

/** Deep link the pairing QR encodes: `synara://pair#<payload>`. */
export const MOBILE_PAIRING_DEEP_LINK_SCHEME = "synara";
export const MOBILE_PAIRING_DEEP_LINK_HOST = "pair";

/**
 * `trusted-proxy` keeps the Node listener on loopback and publishes only the
 * operator's system-trusted HTTPS endpoint (Tailscale Serve, reverse proxy).
 * `private-lan` binds the plaintext listener to a private interface and is
 * therefore a development-build-only mode.
 */
export const MobileAccessMode = Schema.Literals(["trusted-proxy", "private-lan"]);
export type MobileAccessMode = typeof MobileAccessMode.Type;

export const MobileAccessConfig = Schema.Struct({
  enabled: Schema.Boolean,
  mode: MobileAccessMode,
  publicBaseUrl: Schema.optionalKey(TrimmedNonEmptyString),
  privateBindAddress: Schema.optionalKey(TrimmedNonEmptyString),
  approvedRoots: Schema.Array(TrimmedNonEmptyString),
});
export type MobileAccessConfig = typeof MobileAccessConfig.Type;

export const MobileAccessReachability = Schema.Literals([
  "disabled",
  "loopback-only",
  "trusted-proxy",
  "private-lan-insecure",
]);
export type MobileAccessReachability = typeof MobileAccessReachability.Type;

/** Owner-only view of a root. `path` never leaves the owner surface. */
export const MobileApprovedRoot = Schema.Struct({
  rootId: MobileRootId,
  label: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
});
export type MobileApprovedRoot = typeof MobileApprovedRoot.Type;

export const MobileAccessStatus = Schema.Struct({
  enabled: Schema.Boolean,
  mode: MobileAccessMode,
  reachability: MobileAccessReachability,
  environmentId: EnvironmentId,
  /** Exact base URL a pairing payload may publish. Null whenever pairing is blocked. */
  pairingBaseUrl: Schema.NullOr(TrimmedNonEmptyString),
  pairingBlockedReason: Schema.NullOr(Schema.String),
  /** True only for the development-build private-LAN endpoint. */
  insecureDevelopmentAccess: Schema.Boolean,
  privateLanAvailable: Schema.Boolean,
  /** False for standalone `synara serve` users, who configure this through the CLI. */
  desktopManaged: Schema.Boolean,
  approvedRoots: Schema.Array(MobileApprovedRoot),
});
export type MobileAccessStatus = typeof MobileAccessStatus.Type;

// ── Errors ────────────────────────────────────────────────────────────

export const MobileErrorCode = Schema.Literals([
  "protocol_incompatible",
  "unauthorized",
  "forbidden",
  "environment_mismatch",
  "server_instance_changed",
  "unknown_method",
  "unknown_stream",
  "invalid_request",
  "not_found",
  "conflict",
  "idempotency_conflict",
  "stream_limit_exceeded",
  "resnapshot_required",
  "path_not_authorized",
  "provider_unavailable",
  "model_unavailable",
  "operation_failed",
  "operation_blocked",
  "cancelled",
  "timeout",
  "rate_limited",
  "internal_error",
]);
export type MobileErrorCode = typeof MobileErrorCode.Type;

export const MobileError = Schema.Struct({
  code: MobileErrorCode,
  message: Schema.String,
  retryable: Schema.Boolean,
  retryAfterMs: Schema.optional(NonNegativeInt),
});
export type MobileError = typeof MobileError.Type;

// ── Method inputs and results ─────────────────────────────────────────

export const MobileConnectionProbeInput = Schema.Struct({});
export type MobileConnectionProbeInput = typeof MobileConnectionProbeInput.Type;

export const MobileConnectionProbeResult = Schema.Struct({
  environmentId: EnvironmentId,
  serverInstanceId: TrimmedNonEmptyString,
  negotiatedRevision: NonNegativeInt,
  serverTime: IsoDateTime,
});
export type MobileConnectionProbeResult = typeof MobileConnectionProbeResult.Type;

export const MobileWorkspaceRoot = Schema.Struct({
  rootId: MobileRootId,
  label: TrimmedNonEmptyString,
  displayPath: TrimmedNonEmptyString,
});
export type MobileWorkspaceRoot = typeof MobileWorkspaceRoot.Type;

export const MobileListRootsInput = Schema.Struct({});
export type MobileListRootsInput = typeof MobileListRootsInput.Type;

export const MobileListRootsResult = Schema.Struct({
  roots: Schema.Array(MobileWorkspaceRoot),
});
export type MobileListRootsResult = typeof MobileListRootsResult.Type;

export const MobileDirectoryEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  relativePath: MobileRelativePath,
  isGitRepository: Schema.Boolean,
});
export type MobileDirectoryEntry = typeof MobileDirectoryEntry.Type;

export const MobileListDirectoriesInput = Schema.Struct({
  rootId: MobileRootId,
  relativePath: MobileRelativePath,
});
export type MobileListDirectoriesInput = typeof MobileListDirectoriesInput.Type;

export const MobileListDirectoriesResult = Schema.Struct({
  rootId: MobileRootId,
  relativePath: MobileRelativePath,
  parentRelativePath: Schema.NullOr(MobileRelativePath),
  entries: Schema.Array(MobileDirectoryEntry),
});
export type MobileListDirectoriesResult = typeof MobileListDirectoriesResult.Type;

export const MobileCreateProjectInput = Schema.Struct({
  rootId: MobileRootId,
  relativePath: MobileRelativePath,
  title: TrimmedNonEmptyString,
  defaultModelSelection: Schema.optional(ModelSelection),
});
export type MobileCreateProjectInput = typeof MobileCreateProjectInput.Type;

export const MobileCreateProjectResult = Schema.Struct({
  project: OrchestrationProjectShell,
  acceptedSequence: NonNegativeInt,
});
export type MobileCreateProjectResult = typeof MobileCreateProjectResult.Type;

/**
 * Synthesized from Synara's provider discovery and status services; there is no
 * 1:1 `NativeApi` method behind it. Deliberately omits binary paths and update
 * machinery — a phone has no use for them and they are host-filesystem detail.
 */
export const MobileProviderStatus = Schema.Struct({
  provider: ProviderKind,
  displayName: TrimmedNonEmptyString,
  available: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  defaultModel: Schema.NullOr(TrimmedNonEmptyString),
  supportsAutoRuntimeMode: Schema.Boolean,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type MobileProviderStatus = typeof MobileProviderStatus.Type;

export const MobileProviderStatuses = Schema.Struct({
  providers: Schema.Array(MobileProviderStatus),
  updatedAt: IsoDateTime,
});
export type MobileProviderStatuses = typeof MobileProviderStatuses.Type;

export const MobileListProvidersInput = Schema.Struct({});
export type MobileListProvidersInput = typeof MobileListProvidersInput.Type;

export const MobileListProvidersResult = MobileProviderStatuses;
export type MobileListProvidersResult = typeof MobileListProvidersResult.Type;

export const MobileListModelsInput = Schema.Struct({
  provider: ProviderKind,
});
export type MobileListModelsInput = typeof MobileListModelsInput.Type;

export const MobileListModelsResult = Schema.Struct({
  provider: ProviderKind,
  models: Schema.Array(ProviderModelDescriptor),
  defaultModel: Schema.NullOr(TrimmedNonEmptyString),
  source: Schema.optional(TrimmedNonEmptyString),
  cached: Schema.optional(Schema.Boolean),
});
export type MobileListModelsResult = typeof MobileListModelsResult.Type;

export const MobileListBranchesInput = Schema.Struct({
  projectId: ProjectId,
});
export type MobileListBranchesInput = typeof MobileListBranchesInput.Type;

export const MobileListBranchesResult = Schema.Struct({
  projectId: ProjectId,
  branches: Schema.Array(GitBranch),
  isRepo: Schema.Boolean,
  hasOriginRemote: Schema.Boolean,
});
export type MobileListBranchesResult = typeof MobileListBranchesResult.Type;

export const MobileUserMessage = Schema.Struct({
  text: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
  ),
});
export type MobileUserMessage = typeof MobileUserMessage.Type;

/**
 * Mobile worktrees are created detached at `baseRef`. There is deliberately no
 * branch-name field: named-branch creation from mobile is a follow-up plan.
 */
export const MobileWorkspaceThreadTarget = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("local") }),
  Schema.Struct({ mode: Schema.Literal("worktree"), baseRef: TrimmedNonEmptyString }),
]);
export type MobileWorkspaceThreadTarget = typeof MobileWorkspaceThreadTarget.Type;

/**
 * One durable, idempotent operation covering worktree creation, thread
 * creation, and the first turn. `operationId` is client-generated and persisted
 * before the send so a lost response can be retried safely.
 */
export const MobileCreateWorkspaceThreadInput = Schema.Struct({
  operationId: MobileOperationId,
  projectId: ProjectId,
  target: MobileWorkspaceThreadTarget,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  firstMessage: MobileUserMessage,
});
export type MobileCreateWorkspaceThreadInput = typeof MobileCreateWorkspaceThreadInput.Type;

export const MobileWorkspaceThreadWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  ref: TrimmedNonEmptyString,
  detached: Schema.Literal(true),
});
export type MobileWorkspaceThreadWorktree = typeof MobileWorkspaceThreadWorktree.Type;

export const MobileWorkspaceThreadCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  operationId: MobileOperationId,
  threadId: ThreadId,
  messageId: MessageId,
  commandId: CommandId,
  acceptedSequence: NonNegativeInt,
  thread: OrchestrationThreadShell,
  worktree: Schema.NullOr(MobileWorkspaceThreadWorktree),
  updatedAt: IsoDateTime,
});
export type MobileWorkspaceThreadCompleted = typeof MobileWorkspaceThreadCompleted.Type;

export const MobileCreateWorkspaceThreadResult = MobileWorkspaceThreadCompleted;
export type MobileCreateWorkspaceThreadResult = typeof MobileCreateWorkspaceThreadResult.Type;

export const MobileWorkspaceThreadPhase = Schema.Literals([
  "reserved",
  "creating-worktree",
  "creating-thread",
  "starting-turn",
]);
export type MobileWorkspaceThreadPhase = typeof MobileWorkspaceThreadPhase.Type;

/** Compensation runs in reverse acquisition order. */
export const MobileWorkspaceThreadCompensationPhase = Schema.Literals([
  "reverting-turn",
  "removing-thread",
  "removing-worktree",
]);
export type MobileWorkspaceThreadCompensationPhase =
  typeof MobileWorkspaceThreadCompensationPhase.Type;

export const MobileWorkspaceThreadBlockedReason = Schema.Literals([
  "worktree-ownership-mismatch",
  "worktree-cleanup-failed",
  "thread-cleanup-failed",
  "manual-attention-required",
]);
export type MobileWorkspaceThreadBlockedReason = typeof MobileWorkspaceThreadBlockedReason.Type;

export const MobileWorkspaceThreadOwnedResource = Schema.Struct({
  kind: Schema.Literals(["worktree", "thread"]),
  identifier: TrimmedNonEmptyString,
});
export type MobileWorkspaceThreadOwnedResource = typeof MobileWorkspaceThreadOwnedResource.Type;

export const MobileGetWorkspaceThreadOperationInput = Schema.Struct({
  operationId: MobileOperationId,
});
export type MobileGetWorkspaceThreadOperationInput =
  typeof MobileGetWorkspaceThreadOperationInput.Type;

/**
 * Cancellation only ends the caller's wait: an operation that already owns side
 * effects still reaches a durable terminal state, retrieved with the same id.
 * `failed` and `blocked` are never retried automatically under a new id.
 */
export const MobileWorkspaceThreadOperation = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("not-found"),
    operationId: MobileOperationId,
  }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    operationId: MobileOperationId,
    phase: MobileWorkspaceThreadPhase,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("compensating"),
    operationId: MobileOperationId,
    phase: MobileWorkspaceThreadCompensationPhase,
    error: MobileError,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    operationId: MobileOperationId,
    reason: MobileWorkspaceThreadBlockedReason,
    ownedResources: Schema.Array(MobileWorkspaceThreadOwnedResource),
    error: MobileError,
    updatedAt: IsoDateTime,
  }),
  MobileWorkspaceThreadCompleted,
  Schema.Struct({
    status: Schema.Literal("failed"),
    operationId: MobileOperationId,
    error: MobileError,
    compensationCompleted: Schema.Boolean,
    updatedAt: IsoDateTime,
  }),
]);
export type MobileWorkspaceThreadOperation = typeof MobileWorkspaceThreadOperation.Type;

export const MobileGetWorkspaceThreadOperationResult = MobileWorkspaceThreadOperation;
export type MobileGetWorkspaceThreadOperationResult =
  typeof MobileGetWorkspaceThreadOperationResult.Type;

// `commandId`/`messageId` are client-generated and persisted in the turn outbox
// before the send, so a replayed command is idempotent server-side.
export const MobileStartTurnInput = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
  message: MobileUserMessage,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  dispatchMode: Schema.optional(TurnDispatchMode),
});
export type MobileStartTurnInput = typeof MobileStartTurnInput.Type;

export const MobileInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  turnId: Schema.optional(TurnId),
});
export type MobileInterruptTurnInput = typeof MobileInterruptTurnInput.Type;

export const MobileRespondApprovalInput = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  decision: ProviderApprovalDecision,
});
export type MobileRespondApprovalInput = typeof MobileRespondApprovalInput.Type;

export const MobileRespondUserInputInput = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  answers: ProviderUserInputAnswers,
});
export type MobileRespondUserInputInput = typeof MobileRespondUserInputInput.Type;

export const MobileThreadUpdateOperation = Schema.Literals([
  "rename",
  "pin",
  "archive",
  "delete",
]);
export type MobileThreadUpdateOperation = typeof MobileThreadUpdateOperation.Type;

export const MobileUpdateThreadInput = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  operation: MobileThreadUpdateOperation,
  title: Schema.optional(TrimmedNonEmptyString),
  isPinned: Schema.optional(Schema.Boolean),
  isArchived: Schema.optional(Schema.Boolean),
});
export type MobileUpdateThreadInput = typeof MobileUpdateThreadInput.Type;

export const MobileCommandAccepted = Schema.Struct({
  commandId: CommandId,
  acceptedSequence: NonNegativeInt,
});
export type MobileCommandAccepted = typeof MobileCommandAccepted.Type;

// ── Subscriptions ─────────────────────────────────────────────────────

export const MobileShellSubscribeParams = Schema.Struct({
  sinceSequence: Schema.optional(NonNegativeInt),
});
export type MobileShellSubscribeParams = typeof MobileShellSubscribeParams.Type;

export const MobileThreadSubscribeParams = Schema.Struct({
  threadId: ThreadId,
  sinceSequence: Schema.optional(NonNegativeInt),
});
export type MobileThreadSubscribeParams = typeof MobileThreadSubscribeParams.Type;

export const MobileProviderStatusesSubscribeParams = Schema.Struct({});
export type MobileProviderStatusesSubscribeParams =
  typeof MobileProviderStatusesSubscribeParams.Type;

export const MobileResetReason = Schema.Literals([
  "server-instance-changed",
  "stream-overflow",
  "decode-failure",
  "unknown-event",
  "server-requested",
]);
export type MobileResetReason = typeof MobileResetReason.Type;

// ── Client frames ─────────────────────────────────────────────────────

/**
 * Binds the socket to an environment, a server instance, a client build, and a
 * negotiated revision. `protocol` rides only on the handshake frames: once the
 * socket is bound, per-frame epoch tags would carry no information.
 */
export const MobileHello = Schema.Struct({
  type: Schema.Literal("hello"),
  protocol: Schema.Literal(MOBILE_PROTOCOL_EPOCH),
  minRevision: NonNegativeInt,
  maxRevision: NonNegativeInt,
  environmentId: EnvironmentId,
  serverInstanceId: TrimmedNonEmptyString,
  clientBuild: TrimmedNonEmptyString,
});
export type MobileHello = typeof MobileHello.Type;

const requestFrame = <M extends MobileMethod, P extends Schema.Top>(method: M, params: P) =>
  Schema.Struct({
    type: Schema.Literal("request"),
    requestId: MobileRequestId,
    method: Schema.Literal(method),
    params,
  });

/** Method and params travel together so an unknown or mismatched pair cannot decode. */
export const MobileRequest = Schema.Union([
  requestFrame("connection.probe", MobileConnectionProbeInput),
  requestFrame("project.create", MobileCreateProjectInput),
  requestFrame("projects.listRoots", MobileListRootsInput),
  requestFrame("projects.listDirectories", MobileListDirectoriesInput),
  requestFrame("provider.listProviders", MobileListProvidersInput),
  requestFrame("provider.listModels", MobileListModelsInput),
  requestFrame("git.listBranches", MobileListBranchesInput),
  requestFrame("workspaceThread.createAndStart", MobileCreateWorkspaceThreadInput),
  requestFrame("workspaceThread.getOperation", MobileGetWorkspaceThreadOperationInput),
  requestFrame("clientTurn.start", MobileStartTurnInput),
  requestFrame("clientTurn.interrupt", MobileInterruptTurnInput),
  requestFrame("clientTurn.respondApproval", MobileRespondApprovalInput),
  requestFrame("clientTurn.respondUserInput", MobileRespondUserInputInput),
  requestFrame("clientThread.update", MobileUpdateThreadInput),
]);
export type MobileRequest = typeof MobileRequest.Type;

/**
 * Cancels the caller's wait only. A creation saga that already owns side
 * effects continues to a durable completed, failed, or compensating state.
 */
export const MobileCancelRequest = Schema.Struct({
  type: Schema.Literal("cancel-request"),
  requestId: MobileRequestId,
});
export type MobileCancelRequest = typeof MobileCancelRequest.Type;

const subscribeFrame = <S extends MobileStream, P extends Schema.Top>(stream: S, params: P) =>
  Schema.Struct({
    type: Schema.Literal("subscribe"),
    subscriptionId: MobileSubscriptionId,
    stream: Schema.Literal(stream),
    params,
  });

export const MobileSubscribe = Schema.Union([
  subscribeFrame("orchestration.shell", MobileShellSubscribeParams),
  subscribeFrame("orchestration.thread", MobileThreadSubscribeParams),
  subscribeFrame("provider.statuses", MobileProviderStatusesSubscribeParams),
]);
export type MobileSubscribe = typeof MobileSubscribe.Type;

export const MobileUnsubscribe = Schema.Struct({
  type: Schema.Literal("unsubscribe"),
  subscriptionId: MobileSubscriptionId,
});
export type MobileUnsubscribe = typeof MobileUnsubscribe.Type;

export const MobilePong = Schema.Struct({
  type: Schema.Literal("pong"),
  nonce: TrimmedNonEmptyString,
});
export type MobilePong = typeof MobilePong.Type;

export const MobileClientFrame = Schema.Union([
  MobileHello,
  MobileRequest,
  MobileCancelRequest,
  MobileSubscribe,
  MobileUnsubscribe,
  MobilePong,
]);
export type MobileClientFrame = typeof MobileClientFrame.Type;

// ── Server frames ─────────────────────────────────────────────────────

export const MobileHelloAccepted = Schema.Struct({
  type: Schema.Literal("hello-accepted"),
  protocol: Schema.Literal(MOBILE_PROTOCOL_EPOCH),
  negotiatedRevision: NonNegativeInt,
  environmentId: EnvironmentId,
  serverInstanceId: TrimmedNonEmptyString,
  serverBuild: TrimmedNonEmptyString,
  capabilities: Schema.Array(MobileCapability),
});
export type MobileHelloAccepted = typeof MobileHelloAccepted.Type;

const successFrame = <M extends MobileMethod, R extends Schema.Top>(method: M, result: R) =>
  Schema.Struct({
    type: Schema.Literal("success"),
    requestId: MobileRequestId,
    method: Schema.Literal(method),
    result,
  });

/** Carries `method` so a Codable client can pick the result type without correlating state. */
export const MobileSuccess = Schema.Union([
  successFrame("connection.probe", MobileConnectionProbeResult),
  successFrame("project.create", MobileCreateProjectResult),
  successFrame("projects.listRoots", MobileListRootsResult),
  successFrame("projects.listDirectories", MobileListDirectoriesResult),
  successFrame("provider.listProviders", MobileListProvidersResult),
  successFrame("provider.listModels", MobileListModelsResult),
  successFrame("git.listBranches", MobileListBranchesResult),
  successFrame("workspaceThread.createAndStart", MobileCreateWorkspaceThreadResult),
  successFrame("workspaceThread.getOperation", MobileGetWorkspaceThreadOperationResult),
  successFrame("clientTurn.start", MobileCommandAccepted),
  successFrame("clientTurn.interrupt", MobileCommandAccepted),
  successFrame("clientTurn.respondApproval", MobileCommandAccepted),
  successFrame("clientTurn.respondUserInput", MobileCommandAccepted),
  successFrame("clientThread.update", MobileCommandAccepted),
]);
export type MobileSuccess = typeof MobileSuccess.Type;

/** `requestId`/`method` are null for connection-level failures such as an incompatible hello. */
export const MobileFailure = Schema.Struct({
  type: Schema.Literal("failure"),
  requestId: Schema.NullOr(MobileRequestId),
  method: Schema.NullOr(MobileMethod),
  error: MobileError,
});
export type MobileFailure = typeof MobileFailure.Type;

const snapshotFrame = <S extends MobileStream, P extends Schema.Top>(stream: S, snapshot: P) =>
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    subscriptionId: MobileSubscriptionId,
    stream: Schema.Literal(stream),
    snapshot,
  });

export const MobileSnapshot = Schema.Union([
  snapshotFrame("orchestration.shell", OrchestrationShellSnapshot),
  snapshotFrame("orchestration.thread", OrchestrationThreadDetailSnapshot),
  snapshotFrame("provider.statuses", MobileProviderStatuses),
]);
export type MobileSnapshot = typeof MobileSnapshot.Type;

const eventFrame = <S extends MobileStream, P extends Schema.Top>(stream: S, event: P) =>
  Schema.Struct({
    type: Schema.Literal("event"),
    subscriptionId: MobileSubscriptionId,
    stream: Schema.Literal(stream),
    event,
  });

/**
 * A filtered stream's domain sequence is monotonic but not contiguous: jumps
 * are normal because other aggregates were filtered out. Events at or below the
 * applied sequence are duplicates and must be ignored, never treated as loss.
 */
export const MobileEvent = Schema.Union([
  eventFrame("orchestration.shell", OrchestrationShellStreamEvent),
  eventFrame("orchestration.thread", OrchestrationEvent),
  eventFrame("provider.statuses", MobileProviderStatuses),
]);
export type MobileEvent = typeof MobileEvent.Type;

/**
 * Emitted after the snapshot and the bounded durable replay: every event at or
 * below `sequence` has already been delivered. `null` for unsequenced streams.
 */
export const MobileSynchronized = Schema.Struct({
  type: Schema.Literal("synchronized"),
  subscriptionId: MobileSubscriptionId,
  stream: MobileStream,
  sequence: Schema.NullOr(NonNegativeInt),
});
export type MobileSynchronized = typeof MobileSynchronized.Type;

/** Ends the subscription; the client must resubscribe and resnapshot. */
export const MobileResetRequired = Schema.Struct({
  type: Schema.Literal("reset-required"),
  subscriptionId: MobileSubscriptionId,
  stream: MobileStream,
  reason: MobileResetReason,
  message: Schema.optional(Schema.String),
});
export type MobileResetRequired = typeof MobileResetRequired.Type;

export const MobilePing = Schema.Struct({
  type: Schema.Literal("ping"),
  nonce: TrimmedNonEmptyString,
  sentAt: IsoDateTime,
});
export type MobilePing = typeof MobilePing.Type;

export const MobileServerFrame = Schema.Union([
  MobileHelloAccepted,
  MobileSuccess,
  MobileFailure,
  MobileSnapshot,
  MobileEvent,
  MobileSynchronized,
  MobileResetRequired,
  MobilePing,
]);
export type MobileServerFrame = typeof MobileServerFrame.Type;
