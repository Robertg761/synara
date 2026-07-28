import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderKind,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { AgentGatewayProviderAvailability } from "../../agentGateway/targetResolver.ts";
import type { GitCoreShape } from "../../git/Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderDiscoveryServiceShape } from "../../provider/Services/ProviderDiscoveryService.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadCreationOperationRepository } from "../Services/ThreadCreationOperationRepository.ts";
import { ThreadCreationOperationRepositoryLive } from "./ThreadCreationOperationRepository.ts";
import { makeThreadCreationIds, makeThreadCreationWorktreeSegment } from "../operationIdentity.ts";
import { ThreadCreationRequest } from "../operationState.ts";
import { makeThreadCreationCoordinator } from "./ThreadCreationCoordinator.ts";

const NOW = "2026-07-16T00:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const WORKSPACE_ROOT = "/tmp/thread-creation-workspace";

const layer = it.layer(
  ThreadCreationOperationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const projectShell: OrchestrationProjectShell = {
  id: PROJECT_ID,
  kind: "project",
  title: "Demo project",
  workspaceRoot: WORKSPACE_ROOT,
  defaultModelSelection: null,
  scripts: [],
  isPinned: false,
  createdAt: NOW,
  updatedAt: NOW,
};

function makeThreadShell(id: string, operationId: string): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: PROJECT_ID,
    title: "Demo thread",
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "worktree",
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
    gatewayOperationId: operationId,
  } as unknown as OrchestrationThreadShell;
}

type FailurePoint =
  | "createWorktree"
  | "setupScript"
  | "recordOwnership"
  | "threadCreate"
  | "turnStart";

interface World {
  readonly events: Array<string>;
  readonly worktreeCreates: Array<string>;
  readonly dispatches: Array<{ readonly type: string; readonly commandId: string }>;
  readonly threads: Map<string, OrchestrationThreadShell>;
  readonly worktreesDir: string;
  failAt: FailurePoint | null;
  ownershipVerified: boolean;
  models: ReadonlyArray<string>;
  projectThread: boolean;
}

function makeWorld(): World {
  const worktreesDir = mkdtempSync(join(tmpdir(), "synara-thread-creation-"));
  return {
    events: [],
    worktreeCreates: [],
    dispatches: [],
    threads: new Map(),
    worktreesDir,
    failAt: null,
    ownershipVerified: true,
    models: ["gpt-5.5"],
    projectThread: true,
  };
}

function makeDependencies(world: World) {
  const snapshotQuery = {
    getProjectShellById: () => Effect.succeed(Option.some(projectShell)),
    getShellSnapshot: () => Effect.succeed({ projects: [projectShell] }),
    getThreadShellById: (threadId: string) =>
      Effect.succeed(Option.fromNullishOr(world.threads.get(threadId) ?? null)),
  } as unknown as ProjectionSnapshotQueryShape;

  const orchestrationEngine = {
    dispatch: (command: {
      readonly type: string;
      readonly commandId: string;
      readonly threadId: string;
      readonly gatewayOperationId?: string;
    }) =>
      Effect.suspend(() => {
        if (command.type === "thread.create") {
          if (world.failAt === "threadCreate") {
            return Effect.fail(new Error("thread.create rejected"));
          }
          world.events.push(`dispatch:thread.create`);
          world.dispatches.push({ type: command.type, commandId: command.commandId });
          if (world.projectThread) {
            world.threads.set(
              command.threadId,
              makeThreadShell(command.threadId, command.gatewayOperationId ?? ""),
            );
          }
          return Effect.succeed({ sequence: 1 });
        }
        if (command.type === "thread.turn.start") {
          if (world.failAt === "turnStart") return Effect.fail(new Error("turn rejected"));
          world.events.push("dispatch:thread.turn.start");
          world.dispatches.push({ type: command.type, commandId: command.commandId });
          return Effect.succeed({ sequence: 2 });
        }
        if (command.type === "thread.delete") {
          world.events.push("dispatch:thread.delete");
          world.dispatches.push({ type: command.type, commandId: command.commandId });
          world.threads.delete(command.threadId);
          return Effect.succeed({ sequence: 3 });
        }
        return Effect.succeed({ sequence: 0 });
      }),
  } as unknown as OrchestrationEngineShape;

  const git = {
    withMutation: <A, E, R>(_cwd: string, effect: Effect.Effect<A, E, R>) => effect,
    execute: () => Effect.succeed({ code: 0, stdout: "commit-abc\n", stderr: "" }),
    createDetachedWorktree: (input: { readonly path: string; readonly ref: string }) =>
      Effect.suspend(() => {
        if (world.failAt === "createWorktree") {
          return Effect.fail(new Error("worktree add failed"));
        }
        mkdirSync(input.path, { recursive: true });
        world.worktreeCreates.push(input.path);
        world.events.push("worktree:create");
        return Effect.succeed({
          worktree: { path: input.path, ref: input.ref, branch: null },
        });
      }),
    recordWorktreeOwnership: (input: {
      readonly path: string;
      readonly branch: string | null;
      readonly token: string;
    }) =>
      Effect.suspend(() =>
        world.failAt === "recordOwnership"
          ? Effect.fail(new Error("ownership marker failed"))
          : Effect.succeed({
              token: input.token,
              gitDir: `${input.path}/.git`,
              branch: input.branch,
              head: "commit-abc",
              stateHash: "state-1",
            }),
      ),
    verifyWorktreeOwnership: () =>
      Effect.succeed({
        verified: world.ownershipVerified,
        reason: world.ownershipVerified ? null : "HEAD moved since the operation created it",
      }),
    removeWorktree: (input: { readonly path: string }) =>
      Effect.sync(() => {
        rmSync(input.path, { recursive: true, force: true });
        world.events.push("worktree:remove");
      }),
  } as unknown as GitCoreShape;

  const providerDiscovery = {
    listModels: () =>
      Effect.succeed({
        models: world.models.map((slug) => ({ slug, displayName: slug })),
        source: "test",
      }),
  } as unknown as ProviderDiscoveryServiceShape;

  return {
    snapshotQuery,
    orchestrationEngine,
    git,
    providerDiscovery,
    serverConfig: { worktreesDir: world.worktreesDir },
    loadProviderAvailabilities: Effect.succeed(
      new Map<ProviderKind, AgentGatewayProviderAvailability>([
        ["codex", { enabled: true, available: true }],
      ]),
    ),
    runSetupScript: () =>
      world.failAt === "setupScript"
        ? Promise.reject(new Error("setup script failed"))
        : Promise.resolve(),
    // Zero disables the projection grace period so the suite never depends on
    // wall-clock scheduling.
    threadShellTimeoutMs: 0,
  } as const;
}

const decodeRequest = Schema.decodeUnknownSync(ThreadCreationRequest);

function makeRequest(operationId: string, overrides?: Record<string, unknown>) {
  return decodeRequest({
    operationId,
    projectId: PROJECT_ID,
    target: { mode: "worktree", baseRef: "main" },
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    firstMessage: { text: "Fix the flaky test" },
    ...overrides,
  });
}

/**
 * Rewind a completed operation to the durable state a crash would have left
 * behind: the worktree exists and its ownership proof is recorded, but the
 * thread command never landed. The plan is the one production wrote, so the
 * fixture cannot drift from the coordinator's own encoding.
 */
const simulateCrashAfterWorktree = (world: World, operationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ThreadCreationOperationRepository;
    const record = yield* repository.getById(operationId);
    const plan = JSON.parse(record?.planJson ?? "null") as {
      threadCreated: boolean;
      acceptedSequence: number | null;
    };
    plan.threadCreated = false;
    plan.acceptedSequence = null;
    yield* sql`
      UPDATE thread_creation_operations
      SET status = 'creating-thread', plan_json = ${JSON.stringify(plan)}, result_json = NULL
      WHERE operation_id = ${operationId}
    `;
    world.threads.clear();
    world.dispatches.length = 0;
    world.events.length = 0;
  });

const buildCoordinator = (world: World) =>
  Effect.gen(function* () {
    const operationRepository = yield* ThreadCreationOperationRepository;
    return yield* makeThreadCreationCoordinator({
      ...makeDependencies(world),
      operationRepository,
    });
  });

layer("ThreadCreationCoordinator", (it) => {
  it.effect("creates a worktree, a thread and the first turn as one operation", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const coordinator = yield* buildCoordinator(world);
      const request = makeRequest("op-happy");

      const state = yield* coordinator.createAndStart(request);
      assert.equal(state.status, "completed");
      if (state.status !== "completed") return;

      const ids = makeThreadCreationIds("op-happy");
      assert.equal(state.result.threadId, ids.threadId);
      assert.equal(state.result.messageId, ids.messageId);
      assert.equal(state.result.commandId, ids.turnStartCommandId);
      assert.equal(state.result.acceptedSequence, 2);
      assert.equal(
        state.result.worktree?.path,
        join(world.worktreesDir, makeThreadCreationWorktreeSegment("op-happy")),
      );
      assert.isTrue(state.result.worktree?.detached);
      assert.deepStrictEqual(world.events, [
        "worktree:create",
        "dispatch:thread.create",
        "dispatch:thread.turn.start",
      ]);
      rmSync(world.worktreesDir, { recursive: true, force: true });
    }),
  );

  it.effect("replays the identical result for the same operation id", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const coordinator = yield* buildCoordinator(world);
      const request = makeRequest("op-replay");

      const first = yield* coordinator.createAndStart(request);
      const second = yield* coordinator.createAndStart(request);
      assert.deepStrictEqual(second, first);
      // A replay must not repeat a single side effect.
      assert.equal(world.worktreeCreates.length, 1);
      assert.equal(world.dispatches.length, 2);

      const polled = yield* coordinator.getOperation("op-replay");
      assert.deepStrictEqual(polled, first);
      rmSync(world.worktreesDir, { recursive: true, force: true });
    }),
  );

  it.effect("rejects a reused operation id that carries a different request", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const coordinator = yield* buildCoordinator(world);
      yield* coordinator.createAndStart(makeRequest("op-conflict"));

      const failure = yield* coordinator
        .createAndStart(
          makeRequest("op-conflict", { firstMessage: { text: "A completely different task" } }),
        )
        .pipe(Effect.flip);
      assert.equal(failure.error.code, "idempotency_conflict");
      assert.equal(world.worktreeCreates.length, 1);
      rmSync(world.worktreesDir, { recursive: true, force: true });
    }),
  );

  it.effect("validates the provider target before any side effect", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      world.models = ["some-other-model"];
      const coordinator = yield* buildCoordinator(world);

      const state = yield* coordinator.createAndStart(makeRequest("op-invalid-model"));
      assert.equal(state.status, "failed");
      if (state.status !== "failed") return;
      assert.equal(state.error.code, "model_unavailable");
      assert.isTrue(state.compensationCompleted);
      assert.deepStrictEqual(world.events, []);
      assert.equal(world.worktreeCreates.length, 0);

      // A validation failure is terminal: the same id must not start over.
      const retry = yield* coordinator.createAndStart(makeRequest("op-invalid-model"));
      assert.deepStrictEqual(retry, state);
      rmSync(world.worktreesDir, { recursive: true, force: true });
    }),
  );

  it.effect("resumes without duplicating side effects after a restart mid-operation", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const coordinator = yield* buildCoordinator(world);
      yield* coordinator.createAndStart(makeRequest("op-restart"));
      yield* simulateCrashAfterWorktree(world, "op-restart");

      const restarted = yield* buildCoordinator(world);
      const state = yield* restarted.createAndStart(makeRequest("op-restart"));
      assert.equal(state.status, "completed");
      // Exactly one worktree across both runs, and the resume picked up at the
      // thread command rather than starting over.
      assert.equal(world.worktreeCreates.length, 1);
      assert.deepStrictEqual(world.events, [
        "dispatch:thread.create",
        "dispatch:thread.turn.start",
      ]);
      rmSync(world.worktreesDir, { recursive: true, force: true });
    }),
  );

  it.effect("compensates owned resources in reverse order at every failure point", () =>
    Effect.gen(function* () {
      const expectations: ReadonlyArray<{
        readonly failAt: FailurePoint;
        readonly events: ReadonlyArray<string>;
      }> = [
        { failAt: "createWorktree", events: [] },
        { failAt: "setupScript", events: ["worktree:create", "worktree:remove"] },
        { failAt: "recordOwnership", events: ["worktree:create", "worktree:remove"] },
        { failAt: "threadCreate", events: ["worktree:create", "worktree:remove"] },
        {
          failAt: "turnStart",
          events: [
            "worktree:create",
            "dispatch:thread.create",
            "dispatch:thread.delete",
            "worktree:remove",
          ],
        },
      ];

      for (const expectation of expectations) {
        const world = makeWorld();
        world.failAt = expectation.failAt;
        const coordinator = yield* buildCoordinator(world);
        const operationId = `op-fail-${expectation.failAt}`;

        const state = yield* coordinator.createAndStart(makeRequest(operationId));
        assert.equal(state.status, "failed", expectation.failAt);
        if (state.status !== "failed") continue;
        assert.isTrue(state.compensationCompleted, expectation.failAt);
        assert.deepStrictEqual(world.events, expectation.events, expectation.failAt);
        assert.isFalse(
          existsSync(join(world.worktreesDir, makeThreadCreationWorktreeSegment(operationId))),
          expectation.failAt,
        );
        // A failed operation is terminal: retrying the same id never restarts it.
        const retry = yield* coordinator.createAndStart(makeRequest(operationId));
        assert.deepStrictEqual(retry, state, expectation.failAt);
        rmSync(world.worktreesDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("blocks with the owned worktree when ownership no longer verifies", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const coordinator = yield* buildCoordinator(world);
      yield* coordinator.createAndStart(makeRequest("op-mismatch"));
      yield* simulateCrashAfterWorktree(world, "op-mismatch");

      // Someone moved the worktree's HEAD while Synara was down.
      world.ownershipVerified = false;

      const restarted = yield* buildCoordinator(world);
      const state = yield* restarted.createAndStart(makeRequest("op-mismatch"));
      assert.equal(state.status, "blocked");
      if (state.status !== "blocked") return;
      assert.equal(state.reason, "worktree-ownership-mismatch");
      assert.deepStrictEqual(state.ownedResources, [
        {
          kind: "worktree",
          identifier: join(world.worktreesDir, makeThreadCreationWorktreeSegment("op-mismatch")),
        },
      ]);
      // The saga refuses to delete a worktree it can no longer prove it owns.
      assert.isTrue(
        existsSync(join(world.worktreesDir, makeThreadCreationWorktreeSegment("op-mismatch"))),
      );

      // Blocked is terminal: no automatic retry may take it over.
      const polled = yield* restarted.createAndStart(makeRequest("op-mismatch"));
      assert.deepStrictEqual(polled, state);
      rmSync(world.worktreesDir, { recursive: true, force: true });
    }),
  );

  it.effect("stays resumable when the thread has not projected yet", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      world.projectThread = false;
      const coordinator = yield* buildCoordinator(world);

      const pending = yield* coordinator.createAndStart(makeRequest("op-unprojected"));
      assert.equal(pending.status, "pending");
      if (pending.status !== "pending") return;
      assert.equal(pending.phase, "starting-turn");
      // The turn was accepted, so a resume must not dispatch it a second time.
      assert.deepStrictEqual(
        world.dispatches.map((entry) => entry.type),
        ["thread.create", "thread.turn.start"],
      );

      world.threads.set(
        makeThreadCreationIds("op-unprojected").threadId,
        makeThreadShell(makeThreadCreationIds("op-unprojected").threadId, "op-unprojected"),
      );
      const completed = yield* coordinator.createAndStart(makeRequest("op-unprojected"));
      assert.equal(completed.status, "completed");
      assert.equal(world.dispatches.length, 2);
      rmSync(world.worktreesDir, { recursive: true, force: true });
    }),
  );

  it.effect("reports an unknown operation as not-found", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const coordinator = yield* buildCoordinator(world);
      const state = yield* coordinator.getOperation("op-unknown");
      assert.deepStrictEqual(state, { status: "not-found", operationId: "op-unknown" });
      rmSync(world.worktreesDir, { recursive: true, force: true });
    }),
  );

  it.effect("creates a local thread without touching git", () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const coordinator = yield* buildCoordinator(world);
      const state = yield* coordinator.createAndStart(
        makeRequest("op-local", { target: { mode: "local" } }),
      );
      assert.equal(state.status, "completed");
      if (state.status !== "completed") return;
      assert.equal(state.result.worktree, null);
      assert.deepStrictEqual(world.events, [
        "dispatch:thread.create",
        "dispatch:thread.turn.start",
      ]);
      rmSync(world.worktreesDir, { recursive: true, force: true });
    }),
  );
});
