import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ProjectId, type ProviderKind, type ThreadId } from "@synara/contracts";
import { buildPromptThreadTitleFallback } from "@synara/shared/chatThreads";
import { Cause, Effect, Layer, Option, Schema } from "effect";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { loadProviderAvailabilities } from "../../provider/providerAvailability.ts";
import {
  resolveAgentGatewayTarget,
  type AgentGatewayProviderAvailability,
} from "../../agentGateway/targetResolver.ts";
import { awaitProjectedValue } from "../../orchestration/awaitProjection.ts";
import { makeKeyedLock } from "../../concurrency/keyedLock.ts";
import { describeError } from "../../durableOperations/errors.ts";
import { operationIsoNow, stableOperationDigest } from "../../durableOperations/identity.ts";
import { runWorktreeSetupScript } from "../../worktreeSetup.ts";
import {
  ThreadCreationCoordinator,
  ThreadCreationCoordinatorError,
  type ThreadCreationCoordinatorShape,
} from "../Services/ThreadCreationCoordinator.ts";
import {
  ThreadCreationOperationRepository,
  type ThreadCreationOperationRecord,
  type ThreadCreationOperationRepositoryShape,
  type ThreadCreationOperationStatus,
} from "../Services/ThreadCreationOperationRepository.ts";
import { makeThreadCreationIds, makeThreadCreationWorktreeSegment } from "../operationIdentity.ts";
import { recoverInterruptedThreadCreationOperations } from "../startupRecovery.ts";
import {
  ThreadCreationCompletedResult,
  ThreadCreationErrorDetail,
  ThreadCreationOwnedResource,
  ThreadCreationPlan,
  ThreadCreationRequest,
  type ThreadCreationBlockedReason,
  type ThreadCreationOperationState,
} from "../operationState.ts";

const DEFAULT_THREAD_SHELL_TIMEOUT_MS = 5_000;
const THREAD_SHELL_POLL_MS = 25;

const decodeRequest = Schema.decodeUnknownSync(ThreadCreationRequest);
const decodePlan = Schema.decodeUnknownSync(ThreadCreationPlan);
const decodeResult = Schema.decodeUnknownSync(ThreadCreationCompletedResult);
const decodeErrorDetail = Schema.decodeUnknownSync(ThreadCreationErrorDetail);
const decodeOwnedResources = Schema.decodeUnknownSync(Schema.Array(ThreadCreationOwnedResource));

const detail = (
  code: ThreadCreationErrorDetail["code"],
  message: string,
  retryable = false,
): ThreadCreationErrorDetail => ({ code, message, retryable });

const internalDetail = (message: string): ThreadCreationErrorDetail =>
  detail("internal_error", message, true);

const parseErrorDetail = (errorJson: string | null): ThreadCreationErrorDetail => {
  if (errorJson === null) return internalDetail("The operation recorded no error detail.");
  try {
    return decodeErrorDetail(JSON.parse(errorJson));
  } catch {
    return internalDetail("The operation recorded an undecodable error detail.");
  }
};

const parseOwnedResources = (
  ownedResourcesJson: string | null,
): ReadonlyArray<ThreadCreationOwnedResource> => {
  if (ownedResourcesJson === null) return [];
  try {
    return decodeOwnedResources(JSON.parse(ownedResourcesJson));
  } catch {
    return [];
  }
};

/** Total, throwing-on-corruption projection of a durable row onto the state union. */
function recordToState(record: ThreadCreationOperationRecord): ThreadCreationOperationState {
  const operationId = record.operationId;
  const updatedAt = record.updatedAt;
  switch (record.status) {
    case "reserved":
    case "creating-worktree":
    case "creating-thread":
    case "starting-turn":
      return { status: "pending", operationId, phase: record.status, updatedAt };
    case "compensating":
      return {
        status: "compensating",
        operationId,
        phase: record.compensationPhase ?? "removing-worktree",
        error: parseErrorDetail(record.errorJson),
        updatedAt,
      };
    case "blocked":
      return {
        status: "blocked",
        operationId,
        reason: record.blockedReason ?? "manual-attention-required",
        ownedResources: parseOwnedResources(record.ownedResourcesJson),
        error: parseErrorDetail(record.errorJson),
        updatedAt,
      };
    case "completed":
      return {
        status: "completed",
        operationId,
        result: decodeResult(JSON.parse(record.resultJson ?? "null")),
        updatedAt,
      };
    case "failed":
      return {
        status: "failed",
        operationId,
        error: parseErrorDetail(record.errorJson),
        compensationCompleted: record.compensationCompleted,
        updatedAt,
      };
  }
}

export interface ThreadCreationCoordinatorDependencies {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly git: GitCoreShape;
  readonly providerDiscovery: ProviderDiscoveryServiceShape;
  readonly operationRepository: ThreadCreationOperationRepositoryShape;
  readonly serverConfig: Pick<ServerConfigShape, "worktreesDir">;
  readonly loadProviderAvailabilities: Effect.Effect<
    ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability>,
    unknown
  >;
  readonly runSetupScript?: typeof runWorktreeSetupScript;
  readonly threadShellTimeoutMs?: number;
}

/**
 * Durable, exactly-once "worktree + thread + first turn" saga.
 *
 * The unit of identity is the client-generated operation id: it is reserved
 * with a fingerprint of the request, every completed side effect is persisted
 * before the next one starts, and every dispatched command id is derived from
 * the operation. That combination makes a retry either a replay, a resume, or
 * an idempotency conflict — never a duplicate creation.
 */
export const makeThreadCreationCoordinator = Effect.fn(function* (
  dependencies: ThreadCreationCoordinatorDependencies,
) {
  const {
    snapshotQuery,
    orchestrationEngine,
    git,
    providerDiscovery,
    operationRepository,
    serverConfig,
  } = dependencies;
  const runSetupScript = dependencies.runSetupScript ?? runWorktreeSetupScript;
  const threadShellTimeoutMs = dependencies.threadShellTimeoutMs ?? DEFAULT_THREAD_SHELL_TIMEOUT_MS;
  const operationLock = yield* makeKeyedLock;

  const failInternal = (message: string) =>
    new ThreadCreationCoordinatorError({ error: internalDetail(message) });

  const readRecord = (operationId: string) =>
    operationRepository
      .getById(operationId)
      .pipe(Effect.mapError((error) => failInternal(describeError(error))));

  const stateOf = (record: ThreadCreationOperationRecord) =>
    Effect.try({
      try: () => recordToState(record),
      catch: (cause) =>
        failInternal(`Durable operation state could not be decoded: ${describeError(cause)}`),
    });

  // ── planning ───────────────────────────────────────────────────────────

  const resolvePlan = (request: ThreadCreationRequest) =>
    Effect.gen(function* () {
      const projectId = ProjectId.makeUnsafe(request.projectId);
      const project = yield* snapshotQuery.getProjectShellById(projectId).pipe(
        Effect.mapError((error) => internalDetail(describeError(error))),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(detail("not_found", `Project "${projectId}" was not found.`)),
            onSome: Effect.succeed,
          }),
        ),
      );

      // Authoritative before any side effect: a stale mobile catalog must never
      // decide which provider, model, or option a new thread runs with.
      const availabilities = yield* dependencies.loadProviderAvailabilities.pipe(
        Effect.mapError((error) => internalDetail(describeError(error))),
      );
      const availability = availabilities.get(request.modelSelection.provider);
      const modelSelection = yield* resolveAgentGatewayTarget({
        target: request.modelSelection,
        discovery: providerDiscovery,
        ...(availability !== undefined ? { availability } : {}),
        cwd: project.workspaceRoot,
      }).pipe(
        Effect.mapError((error) =>
          detail(
            error.code === "provider_unavailable" ? "provider_unavailable" : "model_unavailable",
            error.message,
          ),
        ),
      );

      const title = request.title ?? buildPromptThreadTitleFallback(request.firstMessage.text);
      const ids = makeThreadCreationIds(request.operationId);

      if (request.target.mode === "local") {
        return {
          workspaceRoot: project.workspaceRoot,
          environment: "local",
          requestedRef: null,
          worktreeRef: null,
          copyChangesFrom: null,
          plannedWorktreePath: null,
          modelSelection,
          runtimeMode: request.runtimeMode,
          interactionMode: request.interactionMode,
          title,
          ids,
          worktreeOwnership: null,
          threadCreated: false,
          acceptedSequence: null,
        } satisfies ThreadCreationPlan;
      }

      const requestedRef = request.target.baseRef;
      const worktreeRef = yield* git
        .execute({
          operation: "ThreadCreation.resolveWorktreeRef",
          cwd: project.workspaceRoot,
          args: ["rev-parse", "--verify", "--end-of-options", `${requestedRef}^{commit}`],
          timeoutMs: 5_000,
        })
        .pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.filterOrFail(
            (ref) => ref.length > 0,
            () => new Error("git returned an empty commit id"),
          ),
          Effect.mapError((error) =>
            detail(
              "invalid_request",
              `Git revision "${requestedRef}" is unavailable: ${describeError(error)}`,
            ),
          ),
        );
      const plannedWorktreePath = join(
        serverConfig.worktreesDir,
        makeThreadCreationWorktreeSegment(request.operationId),
      );
      if (existsSync(plannedWorktreePath)) {
        return yield* Effect.fail(
          detail(
            "conflict",
            `Worktree path "${plannedWorktreePath}" already exists. Synara will not reuse or remove a pre-existing path.`,
          ),
        );
      }
      return {
        workspaceRoot: project.workspaceRoot,
        environment: "worktree",
        requestedRef,
        worktreeRef,
        copyChangesFrom: null,
        plannedWorktreePath,
        modelSelection,
        runtimeMode: request.runtimeMode,
        interactionMode: request.interactionMode,
        title,
        ids,
        worktreeOwnership: null,
        threadCreated: false,
        acceptedSequence: null,
      } satisfies ThreadCreationPlan;
    });

  const projectScriptsFor = (workspaceRoot: string) =>
    snapshotQuery.getShellSnapshot().pipe(
      Effect.map(
        (snapshot) =>
          snapshot.projects.find((project) => project.workspaceRoot === workspaceRoot)?.scripts ??
          [],
      ),
      Effect.catch(() => Effect.succeed([] as ReadonlyArray<never>)),
    );

  // ── side effects ───────────────────────────────────────────────────────

  const verifyWorktreeStillOwned = (plan: ThreadCreationPlan) =>
    Effect.gen(function* () {
      const ownership = plan.worktreeOwnership;
      if (ownership === null || plan.plannedWorktreePath === null) return;
      if (!existsSync(plan.plannedWorktreePath)) {
        return yield* Effect.fail({
          reason: "worktree-ownership-mismatch" as ThreadCreationBlockedReason,
          error: detail(
            "operation_blocked",
            `The operation-owned worktree ${plan.plannedWorktreePath} is missing; Synara will not recreate it under the same operation.`,
          ),
        });
      }
      const verification = yield* git
        .verifyWorktreeOwnership({
          path: plan.plannedWorktreePath,
          proof: {
            token: ownership.token,
            gitDir: ownership.gitDir,
            branch: ownership.branch,
            head: ownership.head,
            ...(ownership.stateHash ? { stateHash: ownership.stateHash } : {}),
          },
        })
        .pipe(
          Effect.mapError((error) => ({
            reason: "worktree-ownership-mismatch" as ThreadCreationBlockedReason,
            error: detail("operation_blocked", describeError(error)),
          })),
        );
      if (!verification.verified) {
        return yield* Effect.fail({
          reason: "worktree-ownership-mismatch" as ThreadCreationBlockedReason,
          error: detail(
            "operation_blocked",
            `Refusing to continue operation-owned worktree ${plan.plannedWorktreePath}: ${verification.reason ?? "ownership verification failed"}.`,
          ),
        });
      }
    });

  const readThreadShell = (threadId: ThreadId) =>
    awaitProjectedValue(snapshotQuery.getThreadShellById(threadId), {
      timeoutMs: threadShellTimeoutMs,
      pollMs: THREAD_SHELL_POLL_MS,
    });

  // ── compensation ───────────────────────────────────────────────────────

  interface CompensationTargets {
    readonly worktree: { readonly workspaceRoot: string; readonly path: string } | null;
    readonly worktreeOwnership: ThreadCreationPlan["worktreeOwnership"];
    readonly threadId: ThreadId | null;
    readonly compensateCommandId: ThreadCreationPlan["ids"]["compensateCommandId"] | null;
    readonly turnDispatched: boolean;
  }

  const compensationTargetsFor = (
    plan: ThreadCreationPlan | null,
    live: { readonly worktreeCreated: boolean; readonly threadCreated: boolean },
  ): CompensationTargets => {
    if (plan === null) {
      return {
        worktree: null,
        worktreeOwnership: null,
        threadId: null,
        compensateCommandId: null,
        turnDispatched: false,
      };
    }
    const worktreeExists =
      plan.plannedWorktreePath !== null &&
      (plan.worktreeOwnership !== null ||
        live.worktreeCreated ||
        existsSync(plan.plannedWorktreePath));
    const threadCreated = plan.threadCreated || live.threadCreated;
    return {
      worktree: worktreeExists
        ? { workspaceRoot: plan.workspaceRoot, path: plan.plannedWorktreePath! }
        : null,
      worktreeOwnership: plan.worktreeOwnership,
      threadId: threadCreated ? plan.ids.threadId : null,
      compensateCommandId: threadCreated ? plan.ids.compensateCommandId : null,
      turnDispatched: plan.acceptedSequence !== null,
    };
  };

  /**
   * Release owned resources in reverse acquisition order: turn, then thread,
   * then worktree. Anything that cannot be released is reported as a durable
   * `blocked` operation naming the resource — an orphan is never silent, and a
   * blocked operation is never retried automatically under a new id.
   */
  const compensate = (input: {
    readonly operationId: string;
    readonly targets: CompensationTargets;
    readonly failure: ThreadCreationErrorDetail;
  }) =>
    Effect.gen(function* () {
      const { operationId, targets } = input;
      const ownedResources: Array<ThreadCreationOwnedResource> = [];
      let blockedReason: ThreadCreationBlockedReason | null = null;
      const errors: string[] = [];

      const markPhase = (phase: "reverting-turn" | "removing-thread" | "removing-worktree") =>
        operationRepository
          .markCompensating({
            operationId,
            phase,
            errorJson: JSON.stringify(input.failure),
            now: operationIsoNow(),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("thread creation could not persist compensating status", {
                operationId,
                phase,
                error: describeError(error),
              }),
            ),
          );

      if (targets.turnDispatched) {
        // A dispatched turn is not individually reversible: deleting the thread
        // below is the compensation. The phase still exists so a crash here is
        // observable to the client that is polling the operation.
        yield* markPhase("reverting-turn");
      }

      if (targets.threadId !== null && targets.compensateCommandId !== null) {
        yield* markPhase("removing-thread");
        const threadId = targets.threadId;
        yield* Effect.gen(function* () {
          const projected = yield* snapshotQuery.getThreadShellById(threadId);
          if (Option.isNone(projected)) {
            return yield* Effect.fail(
              new Error(
                `Cleanup remains pending for thread ${threadId}: its durable creation may still be awaiting projection.`,
              ),
            );
          }
          if (projected.value.gatewayOperationId !== operationId) {
            return yield* Effect.fail(
              new Error(
                `Refusing to delete thread ${threadId}: it is not owned by operation ${operationId}.`,
              ),
            );
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.delete",
            commandId: targets.compensateCommandId!,
            threadId,
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              blockedReason ??= "thread-cleanup-failed";
              ownedResources.push({ kind: "thread", identifier: threadId });
              errors.push(describeError(error));
            }),
          ),
        );
      }

      if (targets.worktree !== null) {
        yield* markPhase("removing-worktree");
        const worktree = targets.worktree;
        const ownership = targets.worktreeOwnership;
        yield* git
          .withMutation(
            worktree.workspaceRoot,
            Effect.gen(function* () {
              if (!existsSync(worktree.path)) return;
              if (ownership !== null) {
                const verification = yield* git.verifyWorktreeOwnership({
                  path: worktree.path,
                  proof: {
                    token: ownership.token,
                    gitDir: ownership.gitDir,
                    branch: ownership.branch,
                    head: ownership.head,
                    ...(ownership.stateHash ? { stateHash: ownership.stateHash } : {}),
                  },
                });
                if (!verification.verified) {
                  return yield* Effect.fail(
                    new Error(
                      `Refusing to remove worktree ${worktree.path}: ${verification.reason ?? "ownership verification failed"}.`,
                    ),
                  );
                }
              }
              // The checkout is a verified operation-owned baseline that may
              // contain setup-script output, so git requires force even here.
              yield* git.removeWorktree({
                cwd: worktree.workspaceRoot,
                path: worktree.path,
                force: true,
              });
            }),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                blockedReason ??=
                  ownership === null
                    ? "worktree-cleanup-failed"
                    : describeError(error).includes("Refusing to remove worktree")
                      ? "worktree-ownership-mismatch"
                      : "worktree-cleanup-failed";
                ownedResources.push({ kind: "worktree", identifier: worktree.path });
                errors.push(describeError(error));
              }),
            ),
          );
      }

      const now = operationIsoNow();
      if (blockedReason !== null) {
        const blockedError = detail(
          "operation_blocked",
          `${input.failure.message} Cleanup could not finish: ${errors.join("; ")}`,
        );
        yield* operationRepository
          .block({
            operationId,
            reason: blockedReason,
            ownedResourcesJson: JSON.stringify(ownedResources),
            errorJson: JSON.stringify(blockedError),
            now,
          })
          .pipe(Effect.catch((error) => Effect.fail(failInternal(describeError(error)))));
        yield* Effect.logWarning("thread creation operation is blocked", {
          operationId,
          reason: blockedReason,
          errors,
        });
        return {
          status: "blocked",
          operationId,
          reason: blockedReason,
          ownedResources,
          error: blockedError,
          updatedAt: now,
        } satisfies ThreadCreationOperationState;
      }

      yield* operationRepository
        .fail({
          operationId,
          errorJson: JSON.stringify(input.failure),
          compensationCompleted: true,
          now,
        })
        .pipe(Effect.catch((error) => Effect.fail(failInternal(describeError(error)))));
      return {
        status: "failed",
        operationId,
        error: input.failure,
        compensationCompleted: true,
        updatedAt: now,
      } satisfies ThreadCreationOperationState;
    });

  // ── saga ───────────────────────────────────────────────────────────────

  const advance = (record: ThreadCreationOperationRecord) =>
    Effect.gen(function* () {
      const operationId = record.operationId;
      const request = yield* Effect.try({
        try: () => decodeRequest(JSON.parse(record.requestJson)),
        catch: (cause) =>
          failInternal(`Durable operation request could not be decoded: ${describeError(cause)}`),
      });

      let status: ThreadCreationOperationStatus = record.status;
      let planJson: string | null = record.planJson;
      let plan: ThreadCreationPlan | null = yield* Effect.try({
        try: () => (record.planJson === null ? null : decodePlan(JSON.parse(record.planJson))),
        catch: (cause) =>
          failInternal(`Durable operation plan could not be decoded: ${describeError(cause)}`),
      });
      const live = { worktreeCreated: false, threadCreated: false };

      const persist = (nextStatus: ThreadCreationOperationStatus, nextPlan: ThreadCreationPlan) =>
        Effect.gen(function* () {
          const nextJson = JSON.stringify(nextPlan);
          const recorded = yield* operationRepository
            .recordProgress({
              operationId,
              expectedStatus: status,
              expectedPlanJson: planJson,
              status: nextStatus,
              planJson: nextJson,
              now: operationIsoNow(),
            })
            .pipe(Effect.mapError((error) => internalDetail(describeError(error))));
          if (!recorded) {
            return yield* Effect.fail(
              internalDetail(
                `Durable progress for operation ${operationId} could not be recorded; another writer advanced it.`,
              ),
            );
          }
          status = nextStatus;
          planJson = nextJson;
          plan = nextPlan;
        });

      const persistFirst = (resolved: ThreadCreationPlan) =>
        persist(
          resolved.environment === "worktree" ? "creating-worktree" : "creating-thread",
          resolved,
        );

      // Phase 1 — resolve and validate. Nothing is owned yet, so a failure here
      // is terminal without compensation.
      if (status === "reserved") {
        const planning = yield* Effect.result(
          resolvePlan(request).pipe(Effect.tap((resolved) => persistFirst(resolved))),
        );
        if (planning._tag === "Failure") {
          const failure = planning.failure;
          const now = operationIsoNow();
          yield* operationRepository
            .fail({
              operationId,
              errorJson: JSON.stringify(failure),
              compensationCompleted: true,
              now,
            })
            .pipe(Effect.mapError((error) => failInternal(describeError(error))));
          return {
            status: "failed",
            operationId,
            error: failure,
            compensationCompleted: true,
            updatedAt: now,
          } satisfies ThreadCreationOperationState;
        }
      }

      if (plan === null) {
        return yield* Effect.fail(
          failInternal(`Operation ${operationId} reached ${status} without a durable plan.`),
        );
      }

      if (status === "compensating") {
        return yield* compensate({
          operationId,
          targets: compensationTargetsFor(plan, live),
          failure: parseErrorDetail(record.errorJson),
        });
      }

      // Phases 2-4 run under one compensation boundary. Only the setup script is
      // interruptible: everything else must reach a durable decision even if the
      // caller disconnects mid-flight.
      const sideEffects = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (status === "creating-worktree") {
            const current = plan!;
            const worktreePath = current.plannedWorktreePath!;
            if (existsSync(worktreePath)) {
              // A crash between `git worktree add` and the durable ownership
              // record. The path is derived from the operation id and was
              // verified absent when the plan was written, so it can only be
              // this operation's partial checkout.
              yield* git
                .withMutation(
                  current.workspaceRoot,
                  git.removeWorktree({
                    cwd: current.workspaceRoot,
                    path: worktreePath,
                    force: true,
                  }),
                )
                .pipe(
                  Effect.mapError((error) =>
                    detail(
                      "operation_blocked",
                      `A partial worktree at ${worktreePath} could not be removed before resuming: ${describeError(error)}`,
                    ),
                  ),
                );
            }
            const created = yield* git
              .createDetachedWorktree({
                cwd: current.workspaceRoot,
                ref: current.worktreeRef!,
                path: worktreePath,
                ...(current.copyChangesFrom ? { copyChangesFrom: current.copyChangesFrom } : {}),
              })
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    live.worktreeCreated = true;
                  }),
                ),
                Effect.mapError((error) =>
                  detail("operation_failed", `Worktree creation failed: ${describeError(error)}`),
                ),
              );

            const scripts = yield* projectScriptsFor(current.workspaceRoot);
            yield* restore(
              Effect.tryPromise({
                try: (signal) => runSetupScript(scripts, created.worktree.path, signal),
                catch: (cause) =>
                  detail(
                    "operation_failed",
                    `Worktree setup script failed: ${describeError(cause)}`,
                  ),
              }),
            );

            const proof = yield* git
              .recordWorktreeOwnership({
                path: created.worktree.path,
                branch: created.worktree.branch,
                token: randomUUID(),
              })
              .pipe(
                Effect.mapError((error) =>
                  detail(
                    "operation_failed",
                    `Worktree ownership could not be recorded: ${describeError(error)}`,
                  ),
                ),
              );
            yield* persist("creating-thread", {
              ...current,
              plannedWorktreePath: created.worktree.path,
              worktreeRef: created.worktree.ref,
              worktreeOwnership: {
                operationId,
                path: created.worktree.path,
                branch: created.worktree.branch,
                token: proof.token,
                gitDir: proof.gitDir,
                head: proof.head,
                ...(proof.stateHash ? { stateHash: proof.stateHash } : {}),
                recordedAt: operationIsoNow(),
              },
            });
          }

          if (status === "creating-thread") {
            const current = plan!;
            if (!live.worktreeCreated) {
              yield* verifyWorktreeStillOwned(current).pipe(
                Effect.mapError((blocked) => blocked.error),
              );
            }
            yield* orchestrationEngine
              .dispatch({
                type: "thread.create",
                commandId: current.ids.threadCreateCommandId,
                threadId: current.ids.threadId,
                projectId: ProjectId.makeUnsafe(request.projectId),
                title: current.title,
                modelSelection: current.modelSelection,
                runtimeMode: current.runtimeMode,
                interactionMode: current.interactionMode,
                envMode: current.environment,
                branch: null,
                worktreePath: current.plannedWorktreePath,
                gatewayOperationId: operationId,
                gatewayOperationIndex: 0,
                ...(current.plannedWorktreePath !== null
                  ? {
                      associatedWorktreePath: current.plannedWorktreePath,
                      associatedWorktreeBranch: null,
                      associatedWorktreeRef: current.worktreeRef,
                    }
                  : {}),
                createdAt: operationIsoNow(),
              })
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    live.threadCreated = true;
                  }),
                ),
                Effect.mapError((error) =>
                  detail("operation_failed", `Thread creation failed: ${describeError(error)}`),
                ),
              );
            yield* persist("starting-turn", { ...current, threadCreated: true });
          }

          const current = plan!;
          if (current.acceptedSequence !== null) return current;
          const accepted = yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.start",
              commandId: current.ids.turnStartCommandId,
              threadId: current.ids.threadId,
              message: {
                messageId: current.ids.messageId,
                role: "user",
                text: request.firstMessage.text,
                attachments: [],
              },
              modelSelection: current.modelSelection,
              dispatchMode: "queue",
              runtimeMode: current.runtimeMode,
              interactionMode: current.interactionMode,
              createdAt: operationIsoNow(),
            })
            .pipe(
              Effect.mapError((error) =>
                detail("operation_failed", `First turn could not start: ${describeError(error)}`),
              ),
            );
          yield* persist("starting-turn", { ...current, acceptedSequence: accepted.sequence });
          return plan!;
        }),
      );

      const dispatched = yield* sideEffects.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const failure = Cause.hasInterrupts(cause)
              ? detail("operation_failed", "The creation operation was interrupted.", true)
              : Option.getOrElse(Cause.findErrorOption(cause), () =>
                  internalDetail(describeError(Cause.squash(cause))),
                );
            yield* compensate({
              operationId,
              targets: compensationTargetsFor(plan, live),
              failure,
            });
            return null;
          }).pipe(Effect.uninterruptible),
        ),
      );

      if (dispatched === null) {
        const compensatedRecord = yield* readRecord(operationId);
        if (compensatedRecord === null) {
          return yield* Effect.fail(
            failInternal(`Operation ${operationId} vanished during compensation.`),
          );
        }
        return yield* stateOf(compensatedRecord);
      }

      // Commit point: every deterministic dispatch succeeded, so nothing past
      // here may roll the operation back. The shell read stays interruptible —
      // shutdown must not wait on a projection — while the terminal write does
      // not, so a completed operation is never recorded half way.
      const shell = yield* readThreadShell(dispatched.ids.threadId);
      if (shell === null) {
        // The thread exists but has not projected yet. Leave the operation
        // resumable rather than inventing a result.
        return {
          status: "pending",
          operationId,
          phase: "starting-turn",
          updatedAt: operationIsoNow(),
        } satisfies ThreadCreationOperationState;
      }
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const result = {
            threadId: dispatched.ids.threadId,
            messageId: dispatched.ids.messageId,
            commandId: dispatched.ids.turnStartCommandId,
            acceptedSequence: dispatched.acceptedSequence!,
            thread: shell,
            worktree:
              dispatched.plannedWorktreePath === null
                ? null
                : {
                    path: dispatched.plannedWorktreePath,
                    ref: dispatched.worktreeRef!,
                    detached: true as const,
                  },
          } satisfies ThreadCreationCompletedResult;
          const now = operationIsoNow();
          const resultJson = JSON.stringify(result);
          yield* operationRepository
            .complete({ operationId, resultJson, now })
            .pipe(Effect.mapError((error) => failInternal(describeError(error))));
          return {
            status: "completed",
            operationId,
            // Decoded from the persisted JSON so the first response and every
            // later replay are byte-identical.
            result: decodeResult(JSON.parse(resultJson)),
            updatedAt: now,
          } satisfies ThreadCreationOperationState;
        }),
      );
    });

  // ── public surface ─────────────────────────────────────────────────────

  const createAndStart: ThreadCreationCoordinatorShape["createAndStart"] = (request) =>
    operationLock.withLock(
      request.operationId,
      Effect.gen(function* () {
        const fingerprint = stableOperationDigest({ ...request, operationId: undefined }, 64);
        const reservation = yield* operationRepository
          .reserve({
            operationId: request.operationId,
            fingerprint,
            projectId: request.projectId,
            requestJson: JSON.stringify(request),
            now: operationIsoNow(),
          })
          .pipe(Effect.mapError((error) => failInternal(describeError(error))));

        if (reservation.kind === "idempotency_conflict") {
          return yield* Effect.fail(
            ThreadCreationCoordinatorError.of(
              "idempotency_conflict",
              `Operation id "${request.operationId}" was already used with a different request.`,
            ),
          );
        }

        const operation = reservation.operation;
        if (
          operation.status === "completed" ||
          operation.status === "failed" ||
          operation.status === "blocked"
        ) {
          return yield* stateOf(operation);
        }
        return yield* advance(operation);
      }),
    );

  const getOperation: ThreadCreationCoordinatorShape["getOperation"] = (operationId) =>
    Effect.gen(function* () {
      const record = yield* readRecord(operationId);
      if (record === null) return { status: "not-found", operationId } as const;
      return yield* stateOf(record);
    });

  const resume = (operationId: string) =>
    operationLock.withLock(
      operationId,
      Effect.gen(function* () {
        const record = yield* readRecord(operationId);
        if (record === null) {
          return yield* Effect.fail(
            failInternal(`Operation ${operationId} disappeared before it could be resumed.`),
          );
        }
        if (
          record.status === "completed" ||
          record.status === "failed" ||
          record.status === "blocked"
        ) {
          return yield* stateOf(record);
        }
        return yield* advance(record);
      }),
    );

  const recoverInterrupted = recoverInterruptedThreadCreationOperations({
    operationRepository,
    resume,
  }).pipe(Effect.asVoid);

  return {
    createAndStart,
    getOperation,
    recoverInterrupted,
  } satisfies ThreadCreationCoordinatorShape;
});

export const ThreadCreationCoordinatorLive = Layer.effect(
  ThreadCreationCoordinator,
  Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const git = yield* GitCore;
    const providerDiscovery = yield* ProviderDiscoveryService;
    const operationRepository = yield* ThreadCreationOperationRepository;
    const serverConfig = yield* ServerConfig;
    const providerHealth = yield* ProviderHealth;
    const settings = yield* ServerSettingsService;
    const coordinator = yield* makeThreadCreationCoordinator({
      snapshotQuery,
      orchestrationEngine,
      git,
      providerDiscovery,
      operationRepository,
      serverConfig,
      loadProviderAvailabilities: loadProviderAvailabilities({ settings, providerHealth }),
    });
    // Recovery runs during layer construction so no client-facing surface that
    // depends on this layer can accept a creation request while an interrupted
    // operation still owns a worktree path.
    yield* coordinator.recoverInterrupted;
    return coordinator;
  }),
);
