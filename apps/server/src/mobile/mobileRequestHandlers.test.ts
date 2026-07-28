import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import {
  MobileRequest,
  ProjectId,
  ThreadId,
  type MobileRequestId,
  type MobileRootId,
  type MobileSuccess,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { Effect, Fiber, Layer, Option, Schema } from "effect";

import type { AgentGatewayProviderAvailability } from "../agentGateway/targetResolver.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationCommandReceipt } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import { ThreadCreationOperationRepositoryLive } from "../threadCreation/Layers/ThreadCreationOperationRepository.ts";
import { makeThreadCreationCoordinator } from "../threadCreation/Layers/ThreadCreationCoordinator.ts";
import { ThreadCreationOperationRepository } from "../threadCreation/Services/ThreadCreationOperationRepository.ts";
import type { ThreadCreationCoordinatorShape } from "../threadCreation/Services/ThreadCreationCoordinator.ts";
import { makeMobileRequestHandlers } from "./mobileRequestHandlers.ts";
import { MobileGatewayError } from "./Services/MobileGateway.ts";
import type { MobileWorkspaceAccessShape } from "./Services/MobileWorkspaceAccess.ts";

const NOW = "2026-07-16T00:00:00.000Z";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444" as MobileRequestId;
// Distinct per test: the durable repository is shared across the block, so a
// reused operation id would replay an earlier test's result.
const OPERATION_COMPLETED = "77777777-7777-4777-8777-777777777771";
const OPERATION_RETRIED = "77777777-7777-4777-8777-777777777772";
const OPERATION_CANCELLED = "77777777-7777-4777-8777-777777777773";
const OPERATION_UNKNOWN = "77777777-7777-4777-8777-777777777779";
const ROOT_ID = "root-0000000000000001" as MobileRootId;
const UNKNOWN_ROOT_ID = "root-000000000000dead" as MobileRootId;
const ROOT_PATH = "/approved/roots/code";
const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-2");
const ORPHAN_THREAD_ID = ThreadId.makeUnsafe("thread-orphan");

type BoundRequest = Exclude<MobileRequest, { readonly method: "connection.probe" }>;

const decodeRequest = Schema.decodeUnknownSync(MobileRequest);

const request = (method: string, params: unknown): BoundRequest =>
  decodeRequest({ type: "request", requestId: REQUEST_ID, method, params }) as BoundRequest;

const projectShell = (id: ProjectId, workspaceRoot: string): OrchestrationProjectShell =>
  ({
    id,
    kind: "project",
    title: "Demo project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  }) as unknown as OrchestrationProjectShell;

/** Complete enough to survive the coordinator's own re-encode of its result. */
const threadShell = (id: ThreadId, projectId: ProjectId): OrchestrationThreadShell =>
  ({
    id,
    projectId,
    title: "Demo thread",
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: null,
    latestUserMessageAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    handoff: null,
    session: null,
    gatewayOperationId: null,
  }) as unknown as OrchestrationThreadShell;

const providerStatus = (): ServerProviderStatus =>
  ({
    provider: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: NOW,
  }) as unknown as ServerProviderStatus;

interface DispatchedCommand {
  readonly type: string;
  readonly commandId: string;
  readonly payload: Record<string, unknown>;
}

interface World {
  readonly dispatches: Array<DispatchedCommand>;
  readonly receipts: Map<string, OrchestrationCommandReceipt>;
  readonly projects: Map<string, OrchestrationProjectShell>;
  readonly threads: Map<string, OrchestrationThreadShell>;
  readonly branchCalls: Array<string>;
  sequence: number;
  models: ReadonlyArray<string>;
  availability: AgentGatewayProviderAvailability;
}

const makeWorld = (): World => ({
  dispatches: [],
  receipts: new Map(),
  projects: new Map([[PROJECT_ID, projectShell(PROJECT_ID, ROOT_PATH)]]),
  threads: new Map([
    [THREAD_ID, threadShell(THREAD_ID, PROJECT_ID)],
    [OTHER_THREAD_ID, threadShell(OTHER_THREAD_ID, PROJECT_ID)],
    [ORPHAN_THREAD_ID, threadShell(ORPHAN_THREAD_ID, ProjectId.makeUnsafe("project-gone"))],
  ]),
  branchCalls: [],
  sequence: 0,
  models: ["gpt-5.5"],
  availability: { enabled: true, available: true },
});

const makeDependencies = (
  world: World,
  overrides: {
    readonly threadCreation?: ThreadCreationCoordinatorShape;
  } = {},
) => {
  const workspaceAccess: MobileWorkspaceAccessShape = {
    listRoots: Effect.succeed([{ rootId: ROOT_ID, label: "code", displayPath: "~/code" }]),
    resolveDirectory: (input) =>
      input.rootId === ROOT_ID
        ? Effect.succeed({
            rootId: ROOT_ID,
            rootPath: ROOT_PATH,
            relativePath: input.relativePath,
            path: input.relativePath === "" ? ROOT_PATH : join(ROOT_PATH, input.relativePath),
          })
        : Effect.fail(
            MobileGatewayError.of("path_not_authorized", "Root is not an approved mobile root."),
          ),
    listDirectories: (input) =>
      input.rootId === ROOT_ID
        ? Effect.succeed({
            rootId: ROOT_ID,
            relativePath: input.relativePath,
            parentRelativePath: null,
            entries: [{ name: "app", relativePath: "app", isGitRepository: true }],
          })
        : Effect.fail(
            MobileGatewayError.of("path_not_authorized", "Root is not an approved mobile root."),
          ),
  };

  const snapshotQuery = {
    getProjectShellById: (projectId: string) =>
      Effect.succeed(Option.fromNullishOr(world.projects.get(projectId) ?? null)),
    getThreadShellById: (threadId: string) =>
      Effect.succeed(Option.fromNullishOr(world.threads.get(threadId) ?? null)),
  } as unknown as ProjectionSnapshotQueryShape;

  const orchestrationEngine = {
    dispatch: (command: Record<string, unknown>) =>
      Effect.sync(() => {
        world.sequence += 1;
        const commandId = String(command["commandId"]);
        const aggregateId = String(command["threadId"] ?? command["projectId"] ?? "");
        world.dispatches.push({
          type: String(command["type"]),
          commandId,
          payload: command,
        });
        // Mirrors the engine's own receipt write so a replayed command id is
        // observable to the handler exactly as it is in production.
        world.receipts.set(commandId, {
          commandId,
          aggregateKind: command["threadId"] === undefined ? "project" : "thread",
          aggregateId,
          acceptedAt: NOW,
          resultSequence: world.sequence,
          status: "accepted",
          error: null,
          fingerprintVersion: 1,
          commandFingerprint: "0".repeat(64),
        } as unknown as OrchestrationCommandReceipt);
        if (command["type"] === "project.create") {
          const projectId = String(command["projectId"]);
          world.projects.set(
            projectId,
            projectShell(
              ProjectId.makeUnsafe(projectId),
              String(command["workspaceRoot"] ?? ROOT_PATH),
            ),
          );
        }
        return { sequence: world.sequence };
      }),
  } as unknown as OrchestrationEngineShape;

  const commandReceipts = {
    getByCommandId: (input: { readonly commandId: string }) =>
      Effect.succeed(Option.fromNullishOr(world.receipts.get(input.commandId) ?? null)),
  } as unknown as Parameters<typeof makeMobileRequestHandlers>[0]["commandReceipts"];

  const providerDiscovery = {
    listModels: () =>
      Effect.succeed({
        models: world.models.map((slug) => ({ slug, name: slug })),
        source: "test",
      }),
  } as unknown as ProviderDiscoveryServiceShape;

  const git = {
    listBranches: (input: { readonly cwd: string }) =>
      Effect.sync(() => {
        world.branchCalls.push(input.cwd);
        return {
          branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
          isRepo: true,
          hasOriginRemote: true,
        };
      }),
  } as unknown as Pick<GitCoreShape, "listBranches">;

  const threadCreation =
    overrides.threadCreation ??
    ({
      createAndStart: () => Effect.die("Thread creation is not used by this test."),
      getOperation: () => Effect.die("Thread creation is not used by this test."),
      recoverInterrupted: Effect.void,
    } as ThreadCreationCoordinatorShape);

  return {
    workspaceAccess,
    orchestrationEngine,
    snapshotQuery,
    commandReceipts,
    providerHealth: { getStatuses: Effect.succeed([providerStatus()]) },
    providerDiscovery,
    git,
    threadCreation,
    loadProviderAvailabilities: Effect.succeed(
      new Map<ProviderKind, AgentGatewayProviderAvailability>([["codex", world.availability]]),
    ),
    projectShellTimeoutMs: 0,
  } as const;
};

const handlersFor = (world: World, overrides?: Parameters<typeof makeDependencies>[1]) =>
  makeMobileRequestHandlers(makeDependencies(world, overrides));

const resultOf = (success: MobileSuccess): Record<string, unknown> =>
  success.result as unknown as Record<string, unknown>;

const failureOf = (error: unknown): MobileGatewayError => {
  assert.instanceOf(error, MobileGatewayError);
  return error as MobileGatewayError;
};

const startTurnParams = (overrides: Record<string, unknown> = {}) => ({
  threadId: THREAD_ID,
  commandId: "command-1",
  messageId: "message-1",
  message: { text: "Fix the flaky test" },
  ...overrides,
});

it.effect("projects.listRoots answers with opaque root handles only", () =>
  Effect.gen(function* () {
    const handlers = handlersFor(makeWorld());
    const success = yield* handlers(request("projects.listRoots", {}));

    assert.equal(success.method, "projects.listRoots");
    assert.deepStrictEqual(resultOf(success)["roots"], [
      { rootId: ROOT_ID, label: "code", displayPath: "~/code" },
    ]);
    assert.notInclude(JSON.stringify(success), ROOT_PATH);
  }),
);

it.effect("projects.listDirectories delegates to the workspace access boundary", () =>
  Effect.gen(function* () {
    const handlers = handlersFor(makeWorld());
    const success = yield* handlers(
      request("projects.listDirectories", { rootId: ROOT_ID, relativePath: "" }),
    );

    assert.deepStrictEqual(resultOf(success)["entries"], [
      { name: "app", relativePath: "app", isGitRepository: true },
    ]);
  }),
);

it.effect("projects.listDirectories rejects a root the owner never approved", () =>
  Effect.gen(function* () {
    const handlers = handlersFor(makeWorld());
    const error = yield* handlers(
      request("projects.listDirectories", { rootId: UNKNOWN_ROOT_ID, relativePath: "" }),
    ).pipe(Effect.flip);

    assert.equal(failureOf(error).error.code, "path_not_authorized");
  }),
);

it.effect("project.create resolves the root server-side and never creates a directory", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    const success = yield* handlers(
      request("project.create", { rootId: ROOT_ID, relativePath: "app", title: "App" }),
    );

    const dispatched = world.dispatches[0]!;
    assert.equal(dispatched.type, "project.create");
    assert.equal(dispatched.payload["workspaceRoot"], join(ROOT_PATH, "app"));
    assert.equal(dispatched.payload["createWorkspaceRootIfMissing"], false);
    assert.equal(resultOf(success)["acceptedSequence"], 1);
    assert.equal(
      (resultOf(success)["project"] as OrchestrationProjectShell).workspaceRoot,
      join(ROOT_PATH, "app"),
    );
  }),
);

it.effect("project.create rejects an unknown root without dispatching", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    const error = yield* handlers(
      request("project.create", { rootId: UNKNOWN_ROOT_ID, relativePath: "", title: "App" }),
    ).pipe(Effect.flip);

    assert.equal(failureOf(error).error.code, "path_not_authorized");
    assert.lengthOf(world.dispatches, 0);
  }),
);

it.effect("project.create revalidates the default model before dispatching", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    const error = yield* handlers(
      request("project.create", {
        rootId: ROOT_ID,
        relativePath: "",
        title: "App",
        defaultModelSelection: { provider: "codex", model: "retired-model" },
      }),
    ).pipe(Effect.flip);

    assert.equal(failureOf(error).error.code, "model_unavailable");
    assert.lengthOf(world.dispatches, 0);
  }),
);

it.effect("provider.listProviders synthesizes the status projection", () =>
  Effect.gen(function* () {
    const handlers = handlersFor(makeWorld());
    const success = yield* handlers(request("provider.listProviders", {}));

    const providers = resultOf(success)["providers"] as ReadonlyArray<Record<string, unknown>>;
    assert.equal(providers[0]?.["provider"], "codex");
    assert.equal(providers[0]?.["available"], true);
    assert.isString(resultOf(success)["updatedAt"]);
  }),
);

it.effect("provider.listModels returns the discovered catalog", () =>
  Effect.gen(function* () {
    const handlers = handlersFor(makeWorld());
    const success = yield* handlers(request("provider.listModels", { provider: "codex" }));

    const models = resultOf(success)["models"] as ReadonlyArray<{ readonly slug: string }>;
    assert.deepStrictEqual(
      models.map((model) => model.slug),
      ["gpt-5.5"],
    );
  }),
);

it.effect("provider.listModels rejects a provider that is not available", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    world.availability = { enabled: false };
    const handlers = handlersFor(world);
    const error = yield* handlers(request("provider.listModels", { provider: "codex" })).pipe(
      Effect.flip,
    );

    assert.equal(failureOf(error).error.code, "provider_unavailable");
  }),
);

it.effect("git.listBranches runs in the project's own workspace root", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    const success = yield* handlers(request("git.listBranches", { projectId: PROJECT_ID }));

    assert.deepStrictEqual(world.branchCalls, [ROOT_PATH]);
    assert.equal(resultOf(success)["projectId"], PROJECT_ID);
    assert.equal(resultOf(success)["isRepo"], true);
  }),
);

it.effect("git.listBranches rejects a project the server does not know", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    const error = yield* handlers(
      request("git.listBranches", { projectId: ProjectId.makeUnsafe("project-gone") }),
    ).pipe(Effect.flip);

    assert.equal(failureOf(error).error.code, "not_found");
    assert.lengthOf(world.branchCalls, 0);
  }),
);

it.effect("clientTurn.start revalidates the thread, its project, and the model", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    const success = yield* handlers(
      request(
        "clientTurn.start",
        startTurnParams({ modelSelection: { provider: "codex", model: "gpt-5.5" } }),
      ),
    );

    const dispatched = world.dispatches[0]!;
    assert.equal(dispatched.type, "thread.turn.start");
    assert.equal(dispatched.payload["threadId"], THREAD_ID);
    assert.equal(resultOf(success)["acceptedSequence"], 1);
    assert.equal(resultOf(success)["commandId"], "command-1");
  }),
);

it.effect("clientTurn.start rejects a thread that does not exist", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    const error = yield* handlers(
      request("clientTurn.start", startTurnParams({ threadId: "thread-missing" })),
    ).pipe(Effect.flip);

    assert.equal(failureOf(error).error.code, "not_found");
    assert.lengthOf(world.dispatches, 0);
  }),
);

it.effect("clientTurn.start rejects a thread whose project is gone", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    const error = yield* handlers(
      request("clientTurn.start", startTurnParams({ threadId: ORPHAN_THREAD_ID })),
    ).pipe(Effect.flip);

    assert.equal(failureOf(error).error.code, "not_found");
    assert.lengthOf(world.dispatches, 0);
  }),
);

it.effect("clientTurn.start rejects a stale model selection without side effects", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    const error = yield* handlers(
      request(
        "clientTurn.start",
        startTurnParams({ modelSelection: { provider: "codex", model: "retired-model" } }),
      ),
    ).pipe(Effect.flip);

    assert.equal(failureOf(error).error.code, "model_unavailable");
    assert.lengthOf(world.dispatches, 0);
  }),
);

it.effect("clientTurn.start rejects a selection whose provider went unavailable", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    world.availability = { enabled: true, available: false, message: "codex is signed out" };
    const handlers = handlersFor(world);
    const error = yield* handlers(
      request(
        "clientTurn.start",
        startTurnParams({ modelSelection: { provider: "codex", model: "gpt-5.5" } }),
      ),
    ).pipe(Effect.flip);

    assert.equal(failureOf(error).error.code, "provider_unavailable");
    assert.lengthOf(world.dispatches, 0);
  }),
);

it.effect("a replayed commandId returns the original accepted sequence exactly once", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    const first = yield* handlers(request("clientTurn.start", startTurnParams()));
    const second = yield* handlers(request("clientTurn.start", startTurnParams()));

    assert.equal(resultOf(second)["acceptedSequence"], resultOf(first)["acceptedSequence"]);
    assert.lengthOf(world.dispatches, 1);
  }),
);

it.effect("a commandId reused for a different thread is an idempotency conflict", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    yield* handlers(request("clientTurn.start", startTurnParams()));
    const error = yield* handlers(
      request("clientTurn.start", startTurnParams({ threadId: OTHER_THREAD_ID })),
    ).pipe(Effect.flip);

    assert.equal(failureOf(error).error.code, "idempotency_conflict");
    assert.lengthOf(world.dispatches, 1);
  }),
);

it.effect("clientTurn.interrupt dispatches the interrupt command for the thread", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    const success = yield* handlers(
      request("clientTurn.interrupt", { threadId: THREAD_ID, commandId: "command-2" }),
    );

    assert.equal(world.dispatches[0]?.type, "thread.turn.interrupt");
    assert.equal(resultOf(success)["acceptedSequence"], 1);
  }),
);

it.effect("clientTurn.respondApproval dispatches the approval decision", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    yield* handlers(
      request("clientTurn.respondApproval", {
        threadId: THREAD_ID,
        commandId: "command-3",
        requestId: "approval-1",
        decision: "accept",
      }),
    );

    assert.equal(world.dispatches[0]?.type, "thread.approval.respond");
    assert.equal(world.dispatches[0]?.payload["decision"], "accept");
  }),
);

it.effect("clientTurn.respondUserInput dispatches the collected answers", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    yield* handlers(
      request("clientTurn.respondUserInput", {
        threadId: THREAD_ID,
        commandId: "command-4",
        requestId: "input-1",
        answers: { question: "yes" },
      }),
    );

    assert.equal(world.dispatches[0]?.type, "thread.user-input.respond");
    assert.deepStrictEqual(world.dispatches[0]?.payload["answers"], { question: "yes" });
  }),
);

it.effect("clientTurn.respondApproval rejects an unknown thread without dispatching", () =>
  Effect.gen(function* () {
    const world = makeWorld();
    const handlers = handlersFor(world);
    const error = yield* handlers(
      request("clientTurn.respondApproval", {
        threadId: "thread-missing",
        commandId: "command-5",
        requestId: "approval-1",
        decision: "accept",
      }),
    ).pipe(Effect.flip);

    assert.equal(failureOf(error).error.code, "not_found");
    assert.lengthOf(world.dispatches, 0);
  }),
);

it.effect("a non-UUID operation id never reaches the coordinator", () =>
  Effect.sync(() => {
    assert.throws(() =>
      decodeRequest({
        type: "request",
        requestId: REQUEST_ID,
        method: "workspaceThread.getOperation",
        params: { operationId: "not-a-uuid" },
      }),
    );
  }),
);

// ── workspaceThread.* against the real durable coordinator ────────────

const coordinatorLayer = it.layer(
  ThreadCreationOperationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

interface CoordinatorWorld {
  readonly worktreesDir: string;
  readonly threads: Map<string, OrchestrationThreadShell>;
  /** Called when the saga reaches its one interruptible step, the setup script. */
  onSetupScript: (() => void) | null;
  /** When set, the setup script never settles, so the caller can cancel there. */
  stallSetupScript: boolean;
}

const buildCoordinator = (coordinatorWorld: CoordinatorWorld) =>
  Effect.gen(function* () {
    const operationRepository = yield* ThreadCreationOperationRepository;
    const snapshotQuery = {
      getProjectShellById: () => Effect.succeed(Option.some(projectShell(PROJECT_ID, ROOT_PATH))),
      getShellSnapshot: () => Effect.succeed({ projects: [projectShell(PROJECT_ID, ROOT_PATH)] }),
      getThreadShellById: (threadId: string) =>
        Effect.succeed(Option.fromNullishOr(coordinatorWorld.threads.get(threadId) ?? null)),
    } as unknown as ProjectionSnapshotQueryShape;

    const orchestrationEngine = {
      dispatch: (command: Record<string, unknown>) =>
        Effect.sync(() => {
          if (command["type"] === "thread.create") {
            const threadId = String(command["threadId"]);
            coordinatorWorld.threads.set(
              threadId,
              threadShell(ThreadId.makeUnsafe(threadId), PROJECT_ID),
            );
            return { sequence: 1 };
          }
          return { sequence: 2 };
        }),
    } as unknown as OrchestrationEngineShape;

    const git = {
      withMutation: <A, E, R>(_cwd: string, effect: Effect.Effect<A, E, R>) => effect,
      execute: () => Effect.succeed({ code: 0, stdout: "commit-abc\n", stderr: "" }),
      createDetachedWorktree: (input: { readonly path: string; readonly ref: string }) =>
        Effect.succeed({ worktree: { path: input.path, ref: input.ref, branch: null } }),
      recordWorktreeOwnership: (input: { readonly token: string }) =>
        Effect.succeed({
          token: input.token,
          gitDir: "/git",
          branch: null,
          head: "commit-abc",
          stateHash: "state-1",
        }),
      verifyWorktreeOwnership: () => Effect.succeed({ verified: true, reason: null }),
      removeWorktree: () => Effect.void,
    } as unknown as GitCoreShape;

    const providerDiscovery = {
      listModels: () => Effect.succeed({ models: [{ slug: "gpt-5.5", name: "gpt-5.5" }] }),
    } as unknown as ProviderDiscoveryServiceShape;

    return yield* makeThreadCreationCoordinator({
      operationRepository,
      snapshotQuery,
      orchestrationEngine,
      git,
      providerDiscovery,
      serverConfig: { worktreesDir: coordinatorWorld.worktreesDir },
      loadProviderAvailabilities: Effect.succeed(
        new Map<ProviderKind, AgentGatewayProviderAvailability>([
          ["codex", { enabled: true, available: true }],
        ]),
      ),
      runSetupScript: () => {
        coordinatorWorld.onSetupScript?.();
        return coordinatorWorld.stallSetupScript ? new Promise<void>(() => {}) : Promise.resolve();
      },
      threadShellTimeoutMs: 0,
    });
  });

const makeCoordinatorWorld = (): CoordinatorWorld => ({
  worktreesDir: mkdtempSync(join(tmpdir(), "synara-mobile-handlers-")),
  threads: new Map(),
  onSetupScript: null,
  stallSetupScript: false,
});

const createAndStartRequest = (operationId: string) =>
  request("workspaceThread.createAndStart", {
    operationId,
    projectId: PROJECT_ID,
    target: { mode: "worktree", baseRef: "main" },
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    firstMessage: { text: "Fix the flaky test" },
  });

coordinatorLayer("workspaceThread against the durable coordinator", (it) => {
  it.effect("createAndStart returns the completed operation for a detached worktree", () =>
    Effect.gen(function* () {
      const coordinatorWorld = makeCoordinatorWorld();
      const threadCreation = yield* buildCoordinator(coordinatorWorld);
      const handlers = handlersFor(makeWorld(), { threadCreation });

      const success = yield* handlers(createAndStartRequest(OPERATION_COMPLETED));
      const result = resultOf(success);

      assert.equal(result["status"], "completed");
      assert.equal(result["operationId"], OPERATION_COMPLETED);
      assert.equal((result["worktree"] as { readonly detached: boolean } | null)?.detached, true);
      rmSync(coordinatorWorld.worktreesDir, { recursive: true, force: true });
    }),
  );

  it.effect("a retry with the same operationId returns the identical result", () =>
    Effect.gen(function* () {
      const coordinatorWorld = makeCoordinatorWorld();
      const threadCreation = yield* buildCoordinator(coordinatorWorld);
      const handlers = handlersFor(makeWorld(), { threadCreation });

      const first = yield* handlers(createAndStartRequest(OPERATION_RETRIED));
      const second = yield* handlers(createAndStartRequest(OPERATION_RETRIED));

      assert.deepStrictEqual(resultOf(second), resultOf(first));
      rmSync(coordinatorWorld.worktreesDir, { recursive: true, force: true });
    }),
  );

  it.effect("cancelling the caller's wait still leaves a durable operation to poll", () =>
    Effect.gen(function* () {
      const coordinatorWorld = makeCoordinatorWorld();
      const enteredSetup = Promise.withResolvers<void>();
      coordinatorWorld.onSetupScript = () => enteredSetup.resolve();
      coordinatorWorld.stallSetupScript = true;

      const threadCreation = yield* buildCoordinator(coordinatorWorld);
      const handlers = handlersFor(makeWorld(), { threadCreation });

      const fiber = yield* Effect.forkChild(handlers(createAndStartRequest(OPERATION_CANCELLED)));
      yield* Effect.promise(() => enteredSetup.promise);
      yield* Fiber.interrupt(fiber);

      const polled = yield* handlers(
        request("workspaceThread.getOperation", { operationId: OPERATION_CANCELLED }),
      );
      // The saga owns durable state: the cancelled wait must not erase it.
      assert.notEqual(resultOf(polled)["status"], "not-found");
      assert.equal(resultOf(polled)["operationId"], OPERATION_CANCELLED);
      rmSync(coordinatorWorld.worktreesDir, { recursive: true, force: true });
    }),
  );

  it.effect("getOperation reports an operation the server has never seen", () =>
    Effect.gen(function* () {
      const coordinatorWorld = makeCoordinatorWorld();
      const threadCreation = yield* buildCoordinator(coordinatorWorld);
      const handlers = handlersFor(makeWorld(), { threadCreation });

      const success = yield* handlers(
        request("workspaceThread.getOperation", {
          operationId: OPERATION_UNKNOWN,
        }),
      );

      assert.equal(resultOf(success)["status"], "not-found");
      rmSync(coordinatorWorld.worktreesDir, { recursive: true, force: true });
    }),
  );
});
