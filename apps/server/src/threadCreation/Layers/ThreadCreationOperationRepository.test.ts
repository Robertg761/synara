import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadCreationOperationRepository } from "../Services/ThreadCreationOperationRepository.ts";
import { ThreadCreationOperationRepositoryLive } from "./ThreadCreationOperationRepository.ts";

const layer = it.layer(
  ThreadCreationOperationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const base = {
  operationId: "operation-1",
  fingerprint: "fingerprint-1",
  projectId: "project-1",
  requestJson: '{"projectId":"project-1"}',
  now: "2026-07-16T00:00:00.000Z",
};

layer("ThreadCreationOperationRepository", (it) => {
  it.effect("reserves once and replays the same request", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadCreationOperationRepository;
      const first = yield* repository.reserve(base);
      assert.equal(first.kind, "reserved");
      assert.equal(first.operation.status, "reserved");
      assert.equal(first.operation.planJson, null);
      assert.equal(first.operation.compensationCompleted, false);

      const second = yield* repository.reserve({ ...base, now: "2026-07-16T00:00:01.000Z" });
      assert.equal(second.kind, "replay");
      // A replay must not disturb the stored row.
      assert.equal(second.operation.createdAt, base.now);
      assert.equal(second.operation.updatedAt, base.now);
    }),
  );

  it.effect("rejects the same id with a different fingerprint", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadCreationOperationRepository;
      yield* repository.reserve(base);
      const conflict = yield* repository.reserve({ ...base, fingerprint: "fingerprint-2" });
      assert.equal(conflict.kind, "idempotency_conflict");
      assert.equal(conflict.operation.fingerprint, "fingerprint-1");
    }),
  );

  it.effect("advances only from the expected status and plan", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadCreationOperationRepository;
      yield* repository.reserve(base);

      const stale = yield* repository.recordProgress({
        operationId: base.operationId,
        expectedStatus: "creating-thread",
        expectedPlanJson: null,
        status: "starting-turn",
        planJson: "{}",
        now: "2026-07-16T00:00:02.000Z",
      });
      assert.isFalse(stale);

      const advanced = yield* repository.recordProgress({
        operationId: base.operationId,
        expectedStatus: "reserved",
        expectedPlanJson: null,
        status: "creating-worktree",
        planJson: '{"step":1}',
        now: "2026-07-16T00:00:03.000Z",
      });
      assert.isTrue(advanced);

      // The compare-and-set must also cover the plan, otherwise two writers in
      // the same status could interleave their plans.
      const wrongPlan = yield* repository.recordProgress({
        operationId: base.operationId,
        expectedStatus: "creating-worktree",
        expectedPlanJson: null,
        status: "creating-thread",
        planJson: '{"step":2}',
        now: "2026-07-16T00:00:04.000Z",
      });
      assert.isFalse(wrongPlan);

      const record = yield* repository.getById(base.operationId);
      assert.equal(record?.status, "creating-worktree");
      assert.equal(record?.planJson, '{"step":1}');
    }),
  );

  it.effect("lists non-terminal operations in creation order", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadCreationOperationRepository;
      yield* repository.reserve({ ...base, operationId: "list-1" });
      yield* repository.reserve({
        ...base,
        operationId: "list-2",
        now: "2026-07-16T00:00:05.000Z",
      });
      yield* repository.reserve({
        ...base,
        operationId: "list-3",
        now: "2026-07-16T00:00:06.000Z",
      });
      yield* repository.reserve({
        ...base,
        operationId: "list-4",
        now: "2026-07-16T00:00:07.000Z",
      });

      yield* repository.markCompensating({
        operationId: "list-2",
        phase: "removing-worktree",
        errorJson: '{"code":"operation_failed"}',
        now: "2026-07-16T00:00:08.000Z",
      });
      yield* repository.complete({
        operationId: "list-3",
        resultJson: '{"threadId":"thread-3"}',
        now: "2026-07-16T00:00:09.000Z",
      });
      yield* repository.fail({
        operationId: "list-4",
        errorJson: '{"code":"internal_error"}',
        compensationCompleted: true,
        now: "2026-07-16T00:00:10.000Z",
      });

      const pending = yield* repository.listNonTerminal();
      assert.deepStrictEqual(
        pending
          .filter((entry) => entry.operationId.startsWith("list-"))
          .map((entry) => [entry.operationId, entry.status]),
        [
          ["list-1", "reserved"],
          ["list-2", "compensating"],
        ],
      );

      const failed = yield* repository.getById("list-4");
      assert.equal(failed?.status, "failed");
      assert.isTrue(failed?.compensationCompleted);
    }),
  );

  it.effect("never overwrites a terminal outcome", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadCreationOperationRepository;
      yield* repository.reserve({ ...base, operationId: "terminal-1" });
      yield* repository.complete({
        operationId: "terminal-1",
        resultJson: '{"threadId":"thread-1"}',
        now: "2026-07-16T00:00:11.000Z",
      });

      yield* repository.fail({
        operationId: "terminal-1",
        errorJson: '{"code":"internal_error"}',
        compensationCompleted: true,
        now: "2026-07-16T00:00:12.000Z",
      });
      yield* repository.markCompensating({
        operationId: "terminal-1",
        phase: "removing-thread",
        errorJson: '{"code":"internal_error"}',
        now: "2026-07-16T00:00:13.000Z",
      });
      yield* repository.block({
        operationId: "terminal-1",
        reason: "manual-attention-required",
        ownedResourcesJson: "[]",
        errorJson: '{"code":"operation_blocked"}',
        now: "2026-07-16T00:00:14.000Z",
      });

      const record = yield* repository.getById("terminal-1");
      assert.equal(record?.status, "completed");
      assert.equal(record?.resultJson, '{"threadId":"thread-1"}');
    }),
  );

  it.effect("returns null for an unknown operation", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadCreationOperationRepository;
      assert.equal(yield* repository.getById("missing"), null);
    }),
  );
});
