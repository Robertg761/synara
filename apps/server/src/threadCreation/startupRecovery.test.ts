import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { ThreadCreationCoordinatorError } from "./Services/ThreadCreationCoordinator.ts";
import type {
  ThreadCreationOperationRecord,
  ThreadCreationOperationStatus,
} from "./Services/ThreadCreationOperationRepository.ts";
import type { ThreadCreationOperationState } from "./operationState.ts";
import { recoverInterruptedThreadCreationOperations } from "./startupRecovery.ts";

const NOW = "2026-07-16T00:00:00.000Z";

const error = { code: "operation_failed", message: "boom", retryable: false } as const;

function makeHarness(input: {
  readonly operations: ReadonlyArray<{
    readonly operationId: string;
    readonly status: ThreadCreationOperationStatus;
  }>;
  readonly outcome: (operationId: string) => ThreadCreationOperationState;
  readonly listFails?: boolean;
  readonly resumeFails?: ReadonlyArray<string>;
}) {
  const resumed: Array<string> = [];
  const recovery = recoverInterruptedThreadCreationOperations({
    operationRepository: {
      listNonTerminal: () =>
        input.listFails === true
          ? Effect.fail(new Error("database unavailable"))
          : Effect.succeed(
              input.operations as ReadonlyArray<
                Pick<ThreadCreationOperationRecord, "operationId" | "status">
              >,
            ),
    },
    resume: (operationId) =>
      Effect.suspend(() => {
        resumed.push(operationId);
        return input.resumeFails?.includes(operationId) === true
          ? Effect.fail(ThreadCreationCoordinatorError.of("internal_error", "resume could not run"))
          : Effect.succeed(input.outcome(operationId));
      }),
  });
  return { resumed, recovery } as const;
}

it.effect("resumes every non-terminal phase in creation order", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      operations: [
        { operationId: "op-reserved", status: "reserved" },
        { operationId: "op-worktree", status: "creating-worktree" },
        { operationId: "op-thread", status: "creating-thread" },
        { operationId: "op-turn", status: "starting-turn" },
        { operationId: "op-compensating", status: "compensating" },
      ],
      outcome: (operationId) => ({
        status: "failed",
        operationId,
        error,
        compensationCompleted: true,
        updatedAt: NOW,
      }),
    });

    const summary = yield* harness.recovery;
    assert.deepStrictEqual(harness.resumed, [
      "op-reserved",
      "op-worktree",
      "op-thread",
      "op-turn",
      "op-compensating",
    ]);
    assert.equal(summary.inspected, 5);
    assert.equal(summary.resumed, 5);
    assert.equal(summary.failed, 5);
  }),
);

it.effect("never resumes an operation that already reached a terminal state", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      operations: [
        { operationId: "op-completed", status: "completed" },
        { operationId: "op-failed", status: "failed" },
        { operationId: "op-blocked", status: "blocked" },
      ],
      outcome: (operationId) => ({
        status: "failed",
        operationId,
        error,
        compensationCompleted: true,
        updatedAt: NOW,
      }),
    });

    const summary = yield* harness.recovery;
    assert.deepStrictEqual(harness.resumed, []);
    assert.equal(summary.resumed, 0);
  }),
);

it.effect("counts the terminal outcome of each resumed operation", () =>
  Effect.gen(function* () {
    const outcomes: Record<string, ThreadCreationOperationState> = {
      "op-done": {
        status: "completed",
        operationId: "op-done",
        // The summary only reads `status`, so the result payload is irrelevant here.
        result: null as never,
        updatedAt: NOW,
      },
      "op-blocked": {
        status: "blocked",
        operationId: "op-blocked",
        reason: "worktree-ownership-mismatch",
        ownedResources: [{ kind: "worktree", identifier: "/tmp/worktree" }],
        error,
        updatedAt: NOW,
      },
      "op-stuck": {
        status: "pending",
        operationId: "op-stuck",
        phase: "starting-turn",
        updatedAt: NOW,
      },
    };
    const harness = makeHarness({
      operations: [
        { operationId: "op-done", status: "starting-turn" },
        { operationId: "op-blocked", status: "creating-thread" },
        { operationId: "op-stuck", status: "starting-turn" },
      ],
      outcome: (operationId) => outcomes[operationId]!,
    });

    const summary = yield* harness.recovery;
    assert.equal(summary.completed, 1);
    assert.equal(summary.blocked, 1);
    assert.equal(summary.stillPending, 1);
    assert.equal(summary.unrecoverable, 0);
  }),
);

it.effect("leaves an unrecoverable operation for the next startup", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      operations: [
        { operationId: "op-broken", status: "creating-worktree" },
        { operationId: "op-ok", status: "reserved" },
      ],
      outcome: (operationId) => ({
        status: "failed",
        operationId,
        error,
        compensationCompleted: true,
        updatedAt: NOW,
      }),
      resumeFails: ["op-broken"],
    });

    const summary = yield* harness.recovery;
    // One bad operation must not stop the rest of the backlog.
    assert.deepStrictEqual(harness.resumed, ["op-broken", "op-ok"]);
    assert.equal(summary.unrecoverable, 1);
    assert.equal(summary.failed, 1);
  }),
);

it.effect("startup survives a repository that cannot be read", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      operations: [],
      outcome: (operationId) => ({ status: "not-found", operationId }),
      listFails: true,
    });

    const summary = yield* harness.recovery;
    assert.equal(summary.inspected, 0);
    assert.deepStrictEqual(harness.resumed, []);
  }),
);
