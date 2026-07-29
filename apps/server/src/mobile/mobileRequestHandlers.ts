// FILE: mobileRequestHandlers.ts
// Purpose: Binds every allowlisted `mobile.v1` method to the services the web
//          client already uses. Transport adaptation only: no method here owns
//          business rules of its own.
// Layer: Server mobile transport
// Exports: makeMobileRequestHandlers

import { randomUUID } from "node:crypto";

import {
  CommandId,
  DEFAULT_TURN_DISPATCH_MODE,
  ProjectId,
  type MobileRequest,
  type MobileSuccess,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderKind,
  type ThreadId,
} from "@synara/contracts";
import { DateTime, Effect, Option } from "effect";

import {
  loadAgentGatewayProviderCatalog,
  resolveAgentGatewayTarget,
  type AgentGatewayProviderAvailability,
} from "../agentGateway/targetResolver.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { awaitProjectedValue } from "../orchestration/awaitProjection.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  OrchestrationCommandReceipt,
  OrchestrationCommandReceiptRepositoryShape,
} from "../persistence/Services/OrchestrationCommandReceipts.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import type { ProviderHealthShape } from "../provider/Services/ProviderHealth.ts";
import {
  fromMobileCreateWorkspaceThreadInput,
  toMobileError,
  toMobileWorkspaceThreadCompleted,
  toMobileWorkspaceThreadOperation,
} from "../threadCreation/mobileOperation.ts";
import type { ThreadCreationCoordinatorShape } from "../threadCreation/Services/ThreadCreationCoordinator.ts";
import { mobileInternalError, toMobileDispatchError, toMobileTargetError } from "./mobileErrors.ts";
import { toMobileProviderStatuses } from "./mobileProviderStatuses.ts";
import { MobileGatewayError } from "./Services/MobileGateway.ts";
import type { MobileWorkspaceAccessShape } from "./Services/MobileWorkspaceAccess.ts";

const DEFAULT_PROJECT_SHELL_TIMEOUT_MS = 5_000;

/** Every method except `connection.probe`, which needs only connection state. */
type BoundRequest = Exclude<MobileRequest, { readonly method: "connection.probe" }>;

export interface MobileRequestHandlerDependencies {
  readonly workspaceAccess: MobileWorkspaceAccessShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly commandReceipts: OrchestrationCommandReceiptRepositoryShape;
  readonly providerHealth: Pick<ProviderHealthShape, "getStatuses">;
  readonly providerDiscovery: ProviderDiscoveryServiceShape;
  readonly git: Pick<GitCoreShape, "listBranches">;
  readonly threadCreation: ThreadCreationCoordinatorShape;
  readonly loadProviderAvailabilities: Effect.Effect<
    ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability>,
    unknown
  >;
  readonly projectShellTimeoutMs?: number;
}

const threadWorkingDirectory = (
  thread: OrchestrationThreadShell,
  project: OrchestrationProjectShell,
): string => thread.workingDirectory ?? thread.worktreePath ?? project.workspaceRoot;

export const makeMobileRequestHandlers = (dependencies: MobileRequestHandlerDependencies) => {
  const {
    workspaceAccess,
    orchestrationEngine,
    snapshotQuery,
    commandReceipts,
    providerHealth,
    providerDiscovery,
    git,
    threadCreation,
  } = dependencies;
  const projectShellTimeoutMs =
    dependencies.projectShellTimeoutMs ?? DEFAULT_PROJECT_SHELL_TIMEOUT_MS;

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // ── authoritative reads ─────────────────────────────────────────────

  const requireProject = Effect.fn(function* (projectId: ProjectId) {
    const project = yield* snapshotQuery
      .getProjectShellById(projectId)
      .pipe(
        Effect.mapError((cause) => mobileInternalError(cause, "The project could not be read.")),
      );
    if (Option.isNone(project)) {
      return yield* MobileGatewayError.of("not_found", `Project ${projectId} was not found.`);
    }
    return project.value;
  });

  /**
   * Thread ownership check: a thread is only addressable when it still projects
   * and its project still exists, so a deleted or orphaned thread cannot be
   * driven from a phone whose cache is stale.
   */
  const requireThreadContext = Effect.fn(function* (threadId: ThreadId) {
    const thread = yield* snapshotQuery
      .getThreadShellById(threadId)
      .pipe(
        Effect.mapError((cause) => mobileInternalError(cause, "The thread could not be read.")),
      );
    if (Option.isNone(thread)) {
      return yield* MobileGatewayError.of("not_found", `Thread ${threadId} was not found.`);
    }
    const project = yield* snapshotQuery
      .getProjectShellById(thread.value.projectId)
      .pipe(
        Effect.mapError((cause) => mobileInternalError(cause, "The project could not be read.")),
      );
    if (Option.isNone(project)) {
      return yield* MobileGatewayError.of(
        "not_found",
        `Thread ${threadId} does not belong to a known project.`,
      );
    }
    return { thread: thread.value, project: project.value };
  });

  /**
   * The phone's catalog is a cache. Every provider/model/option a mutation
   * carries is re-resolved here against live discovery before any side effect.
   */
  const resolveModelSelection = Effect.fn(function* (target: ModelSelection, cwd: string) {
    const availabilities = yield* dependencies.loadProviderAvailabilities.pipe(
      Effect.mapError((cause) =>
        mobileInternalError(cause, "Provider availability could not be resolved."),
      ),
    );
    const availability = availabilities.get(target.provider);
    return yield* resolveAgentGatewayTarget({
      target,
      discovery: providerDiscovery,
      ...(availability === undefined ? {} : { availability }),
      cwd,
    }).pipe(Effect.mapError(toMobileTargetError));
  });

  // ── command dispatch ────────────────────────────────────────────────

  /**
   * Client-supplied command ids make a turn command idempotent, but the
   * engine's fingerprint covers `createdAt`, which a retry cannot reproduce.
   * The receipt is therefore consulted first: a replay returns the original
   * accepted sequence, while the same id used for a different aggregate is the
   * conflict it always was.
   */
  const dispatchClientCommand = Effect.fn(function* (input: {
    readonly commandId: CommandId;
    readonly aggregateId: string;
    readonly command: Parameters<OrchestrationEngineShape["dispatch"]>[0];
  }) {
    const existing = yield* commandReceipts
      .getByCommandId({ commandId: input.commandId })
      .pipe(Effect.catch(() => Effect.succeed(Option.none<OrchestrationCommandReceipt>())));
    if (Option.isSome(existing)) {
      const receipt = existing.value;
      if (receipt.aggregateId !== input.aggregateId) {
        return yield* MobileGatewayError.of(
          "idempotency_conflict",
          `Command ${input.commandId} was already used for a different target.`,
        );
      }
      if (receipt.status !== "accepted") {
        return yield* MobileGatewayError.of(
          "conflict",
          receipt.error ?? `Command ${input.commandId} was previously rejected.`,
        );
      }
      return receipt.resultSequence;
    }
    const accepted = yield* orchestrationEngine
      .dispatch(input.command)
      .pipe(Effect.mapError(toMobileDispatchError));
    return accepted.sequence;
  });

  // ── methods ─────────────────────────────────────────────────────────

  const createProject = Effect.fn(function* (
    request: Extract<BoundRequest, { readonly method: "project.create" }>,
  ) {
    const { params } = request;
    const resolved = yield* workspaceAccess.resolveDirectory({
      rootId: params.rootId,
      relativePath: params.relativePath,
    });
    const defaultModelSelection =
      params.defaultModelSelection === undefined
        ? null
        : yield* resolveModelSelection(params.defaultModelSelection, resolved.path);

    const projectId = ProjectId.makeUnsafe(randomUUID());
    const commandId = CommandId.makeUnsafe(randomUUID());
    const createdAt = yield* nowIso;
    const accepted = yield* orchestrationEngine
      .dispatch({
        type: "project.create",
        commandId,
        projectId,
        kind: "project",
        title: params.title,
        workspaceRoot: resolved.path,
        // The root already exists and was canonicalized above; mobile never
        // creates a directory as a side effect of creating a project.
        createWorkspaceRootIfMissing: false,
        defaultModelSelection,
        isPinned: false,
        createdAt,
      })
      .pipe(Effect.mapError(toMobileDispatchError));

    const project = yield* awaitProjectedValue(snapshotQuery.getProjectShellById(projectId), {
      timeoutMs: projectShellTimeoutMs,
    });
    if (project === null) {
      return yield* MobileGatewayError.of(
        "timeout",
        `Project ${projectId} was created but has not projected yet; read it from the shell snapshot.`,
        { retryable: true },
      );
    }
    return { project, acceptedSequence: accepted.sequence };
  });

  const listProviders = Effect.gen(function* () {
    const [providers, updatedAt] = yield* Effect.all([providerHealth.getStatuses, nowIso]);
    return toMobileProviderStatuses(providers, updatedAt);
  });

  const listModels = Effect.fn(function* (provider: ProviderKind) {
    const availabilities = yield* dependencies.loadProviderAvailabilities.pipe(
      Effect.mapError((cause) =>
        mobileInternalError(cause, "Provider availability could not be resolved."),
      ),
    );
    const availability = availabilities.get(provider);
    const catalog = yield* loadAgentGatewayProviderCatalog({
      provider,
      discovery: providerDiscovery,
      ...(availability === undefined ? {} : { availability }),
    });
    if (!catalog.available) {
      return yield* MobileGatewayError.of(
        "provider_unavailable",
        catalog.error ?? `Provider "${provider}" is unavailable.`,
      );
    }
    return {
      provider,
      models: catalog.models,
      defaultModel: catalog.defaultModel,
      ...(catalog.source === undefined ? {} : { source: catalog.source }),
    };
  });

  const listBranches = Effect.fn(function* (projectId: ProjectId) {
    const project = yield* requireProject(projectId);
    const result = yield* git
      .listBranches({ cwd: project.workspaceRoot })
      .pipe(
        Effect.mapError((cause) => mobileInternalError(cause, "Branches could not be listed.")),
      );
    return { projectId, ...result };
  });

  const createWorkspaceThread = Effect.fn(function* (
    request: Extract<BoundRequest, { readonly method: "workspaceThread.createAndStart" }>,
  ) {
    const state = yield* threadCreation
      .createAndStart(fromMobileCreateWorkspaceThreadInput(request.params))
      .pipe(
        Effect.mapError((error) => new MobileGatewayError({ error: toMobileError(error.error) })),
      );

    switch (state.status) {
      case "completed":
        return toMobileWorkspaceThreadCompleted(state);
      case "pending":
        // The saga owns durable state and keeps running; the caller polls the
        // same operation id rather than starting a second creation.
        return yield* MobileGatewayError.of(
          "timeout",
          `Operation ${state.operationId} is still running (${state.phase}); poll workspaceThread.getOperation.`,
          { retryable: true },
        );
      case "compensating":
        return yield* MobileGatewayError.of(
          "operation_failed",
          `${state.error.message} Compensation is in progress (${state.phase}).`,
        );
      case "blocked":
        return yield* MobileGatewayError.of(
          "operation_blocked",
          `${state.error.message} The operation is blocked (${state.reason}).`,
        );
      case "failed":
        return yield* new MobileGatewayError({ error: toMobileError(state.error) });
      case "not-found":
        return yield* MobileGatewayError.of(
          "internal_error",
          `Operation ${state.operationId} vanished before it produced a result.`,
          { retryable: true },
        );
    }
  });

  const startTurn = Effect.fn(function* (
    request: Extract<BoundRequest, { readonly method: "clientTurn.start" }>,
  ) {
    const { params } = request;
    const { thread, project } = yield* requireThreadContext(params.threadId);
    const modelSelection =
      params.modelSelection === undefined
        ? undefined
        : yield* resolveModelSelection(
            params.modelSelection,
            threadWorkingDirectory(thread, project),
          );
    const createdAt = yield* nowIso;
    const acceptedSequence = yield* dispatchClientCommand({
      commandId: params.commandId,
      aggregateId: params.threadId,
      command: {
        type: "thread.turn.start",
        commandId: params.commandId,
        threadId: params.threadId,
        message: {
          messageId: params.messageId,
          role: "user",
          text: params.message.text,
          attachments: [],
        },
        ...(modelSelection === undefined ? {} : { modelSelection }),
        dispatchMode: params.dispatchMode ?? DEFAULT_TURN_DISPATCH_MODE,
        runtimeMode: params.runtimeMode ?? thread.runtimeMode,
        interactionMode: params.interactionMode ?? thread.interactionMode,
        createdAt,
      },
    });
    return { commandId: params.commandId, acceptedSequence };
  });

  const interruptTurn = Effect.fn(function* (
    request: Extract<BoundRequest, { readonly method: "clientTurn.interrupt" }>,
  ) {
    const { params } = request;
    yield* requireThreadContext(params.threadId);
    const createdAt = yield* nowIso;
    const acceptedSequence = yield* dispatchClientCommand({
      commandId: params.commandId,
      aggregateId: params.threadId,
      command: {
        type: "thread.turn.interrupt",
        commandId: params.commandId,
        threadId: params.threadId,
        ...(params.turnId === undefined ? {} : { turnId: params.turnId }),
        createdAt,
      },
    });
    return { commandId: params.commandId, acceptedSequence };
  });

  const respondApproval = Effect.fn(function* (
    request: Extract<BoundRequest, { readonly method: "clientTurn.respondApproval" }>,
  ) {
    const { params } = request;
    yield* requireThreadContext(params.threadId);
    const createdAt = yield* nowIso;
    const acceptedSequence = yield* dispatchClientCommand({
      commandId: params.commandId,
      aggregateId: params.threadId,
      command: {
        type: "thread.approval.respond",
        commandId: params.commandId,
        threadId: params.threadId,
        requestId: params.requestId,
        ...(params.lifecycleGeneration === undefined
          ? {}
          : { lifecycleGeneration: params.lifecycleGeneration }),
        decision: params.decision,
        createdAt,
      },
    });
    return { commandId: params.commandId, acceptedSequence };
  });

  const respondUserInput = Effect.fn(function* (
    request: Extract<BoundRequest, { readonly method: "clientTurn.respondUserInput" }>,
  ) {
    const { params } = request;
    yield* requireThreadContext(params.threadId);
    const createdAt = yield* nowIso;
    const acceptedSequence = yield* dispatchClientCommand({
      commandId: params.commandId,
      aggregateId: params.threadId,
      command: {
        type: "thread.user-input.respond",
        commandId: params.commandId,
        threadId: params.threadId,
        requestId: params.requestId,
        ...(params.lifecycleGeneration === undefined
          ? {}
          : { lifecycleGeneration: params.lifecycleGeneration }),
        answers: params.answers,
        createdAt,
      },
    });
    return { commandId: params.commandId, acceptedSequence };
  });

  const updateThread = Effect.fn(function* (
    request: Extract<BoundRequest, { readonly method: "clientThread.update" }>,
  ) {
    const { params } = request;
    yield* requireThreadContext(params.threadId);
    const command =
      params.operation === "rename"
        ? params.title === undefined
          ? yield* MobileGatewayError.of(
              "invalid_request",
              "A title is required to rename a thread.",
            )
          : {
              type: "thread.meta.update" as const,
              commandId: params.commandId,
              threadId: params.threadId,
              title: params.title,
            }
        : params.operation === "pin"
          ? params.isPinned === undefined
            ? yield* MobileGatewayError.of(
                "invalid_request",
                "A pinned state is required to update a thread.",
              )
            : {
                type: "thread.meta.update" as const,
                commandId: params.commandId,
                threadId: params.threadId,
                isPinned: params.isPinned,
              }
          : params.operation === "archive"
            ? params.isArchived === undefined
              ? yield* MobileGatewayError.of(
                  "invalid_request",
                  "An archived state is required to update a thread.",
              )
              : {
                  type: params.isArchived
                    ? ("thread.archive" as const)
                    : ("thread.unarchive" as const),
                  commandId: params.commandId,
                  threadId: params.threadId,
                }
            : {
                type: "thread.delete" as const,
                commandId: params.commandId,
                threadId: params.threadId,
              };
    const acceptedSequence = yield* dispatchClientCommand({
      commandId: params.commandId,
      aggregateId: params.threadId,
      command,
    });
    return { commandId: params.commandId, acceptedSequence };
  });

  return (request: BoundRequest): Effect.Effect<MobileSuccess, MobileGatewayError> => {
    const { requestId } = request;
    switch (request.method) {
      case "projects.listRoots":
        return workspaceAccess.listRoots.pipe(
          Effect.map(
            (roots): MobileSuccess => ({
              type: "success",
              requestId,
              method: "projects.listRoots",
              result: { roots },
            }),
          ),
        );
      case "projects.listDirectories":
        return workspaceAccess.listDirectories(request.params).pipe(
          Effect.map(
            (result): MobileSuccess => ({
              type: "success",
              requestId,
              method: "projects.listDirectories",
              result,
            }),
          ),
        );
      case "project.create":
        return createProject(request).pipe(
          Effect.map(
            (result): MobileSuccess => ({
              type: "success",
              requestId,
              method: "project.create",
              result,
            }),
          ),
        );
      case "provider.listProviders":
        return listProviders.pipe(
          Effect.map(
            (result): MobileSuccess => ({
              type: "success",
              requestId,
              method: "provider.listProviders",
              result,
            }),
          ),
        );
      case "provider.listModels":
        return listModels(request.params.provider).pipe(
          Effect.map(
            (result): MobileSuccess => ({
              type: "success",
              requestId,
              method: "provider.listModels",
              result,
            }),
          ),
        );
      case "git.listBranches":
        return listBranches(request.params.projectId).pipe(
          Effect.map(
            (result): MobileSuccess => ({
              type: "success",
              requestId,
              method: "git.listBranches",
              result,
            }),
          ),
        );
      case "workspaceThread.createAndStart":
        return createWorkspaceThread(request).pipe(
          Effect.map(
            (result): MobileSuccess => ({
              type: "success",
              requestId,
              method: "workspaceThread.createAndStart",
              result,
            }),
          ),
        );
      case "workspaceThread.getOperation":
        return threadCreation.getOperation(request.params.operationId).pipe(
          Effect.mapError((error) => new MobileGatewayError({ error: toMobileError(error.error) })),
          Effect.map(
            (state): MobileSuccess => ({
              type: "success",
              requestId,
              method: "workspaceThread.getOperation",
              result: toMobileWorkspaceThreadOperation(state),
            }),
          ),
        );
      case "clientTurn.start":
        return startTurn(request).pipe(
          Effect.map(
            (result): MobileSuccess => ({
              type: "success",
              requestId,
              method: "clientTurn.start",
              result,
            }),
          ),
        );
      case "clientTurn.interrupt":
        return interruptTurn(request).pipe(
          Effect.map(
            (result): MobileSuccess => ({
              type: "success",
              requestId,
              method: "clientTurn.interrupt",
              result,
            }),
          ),
        );
      case "clientTurn.respondApproval":
        return respondApproval(request).pipe(
          Effect.map(
            (result): MobileSuccess => ({
              type: "success",
              requestId,
              method: "clientTurn.respondApproval",
              result,
            }),
          ),
        );
      case "clientTurn.respondUserInput":
        return respondUserInput(request).pipe(
          Effect.map(
            (result): MobileSuccess => ({
              type: "success",
              requestId,
              method: "clientTurn.respondUserInput",
              result,
            }),
          ),
        );
      case "clientThread.update":
        return updateThread(request).pipe(
          Effect.map(
            (result): MobileSuccess => ({
              type: "success",
              requestId,
              method: "clientThread.update",
              result,
            }),
          ),
        );
    }
  };
};
