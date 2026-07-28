import { assert, it } from "@effect/vitest";
import {
  MobileCreateWorkspaceThreadInput,
  MobileWorkspaceThreadCompleted,
  MobileWorkspaceThreadOperation,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect, Schema } from "effect";

import {
  fromMobileCreateWorkspaceThreadInput,
  toMobileWorkspaceThreadCompleted,
  toMobileWorkspaceThreadOperation,
} from "./mobileOperation.ts";
import {
  ThreadCreationRequest,
  type ThreadCreationOperationState,
  type ThreadCreationPhase,
} from "./operationState.ts";
import { makeThreadCreationIds } from "./operationIdentity.ts";

const NOW = "2026-07-16T00:00:00.000Z";
const OPERATION_ID = "b9a8f0c2-1d2e-4f3a-9b8c-7d6e5f4a3b2c";
const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const ids = makeThreadCreationIds(OPERATION_ID);

const encodeOperation = Schema.encodeUnknownSync(MobileWorkspaceThreadOperation);
const decodeOperation = Schema.decodeUnknownSync(MobileWorkspaceThreadOperation);
const decodeCompleted = Schema.decodeUnknownSync(MobileWorkspaceThreadCompleted);
const decodeRequest = Schema.decodeUnknownSync(ThreadCreationRequest);
const decodeMobileInput = Schema.decodeUnknownSync(MobileCreateWorkspaceThreadInput);

// Decoded through the contract so the fixture carries every projected default
// instead of a hand-written subset.
const threadShell = Schema.decodeUnknownSync(OrchestrationThreadShell)({
  id: ids.threadId,
  projectId: PROJECT_ID,
  title: "Demo thread",
  modelSelection: { provider: "codex", model: "gpt-5.5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  envMode: "worktree",
  branch: null,
  worktreePath: "/tmp/worktree",
  associatedWorktreePath: "/tmp/worktree",
  associatedWorktreeBranch: null,
  associatedWorktreeRef: "commit-abc",
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
});

const error = {
  code: "operation_failed",
  message: "The first turn could not start.",
  retryable: true,
  retryAfterMs: 500,
} as const;

const completedState = {
  status: "completed",
  operationId: OPERATION_ID,
  result: {
    threadId: ids.threadId,
    messageId: ids.messageId,
    commandId: ids.turnStartCommandId,
    acceptedSequence: 7,
    thread: threadShell,
    worktree: { path: "/tmp/worktree", ref: "commit-abc", detached: true },
  },
  updatedAt: NOW,
} satisfies ThreadCreationOperationState;

const PHASES: ReadonlyArray<ThreadCreationPhase> = [
  "reserved",
  "creating-worktree",
  "creating-thread",
  "starting-turn",
];

/** One representative of every internal status, including every phase literal. */
const ALL_STATES: ReadonlyArray<ThreadCreationOperationState> = [
  { status: "not-found", operationId: OPERATION_ID },
  ...PHASES.map(
    (phase) =>
      ({
        status: "pending",
        operationId: OPERATION_ID,
        phase,
        updatedAt: NOW,
      }) satisfies ThreadCreationOperationState,
  ),
  ...(["reverting-turn", "removing-thread", "removing-worktree"] as const).map(
    (phase) =>
      ({
        status: "compensating",
        operationId: OPERATION_ID,
        phase,
        error,
        updatedAt: NOW,
      }) satisfies ThreadCreationOperationState,
  ),
  ...(
    [
      "worktree-ownership-mismatch",
      "worktree-cleanup-failed",
      "thread-cleanup-failed",
      "manual-attention-required",
    ] as const
  ).map(
    (reason) =>
      ({
        status: "blocked",
        operationId: OPERATION_ID,
        reason,
        ownedResources: [
          { kind: "worktree", identifier: "/tmp/worktree" },
          { kind: "thread", identifier: ids.threadId },
        ],
        error: { ...error, code: "operation_blocked" },
        updatedAt: NOW,
      }) satisfies ThreadCreationOperationState,
  ),
  completedState,
  {
    status: "failed",
    operationId: OPERATION_ID,
    error,
    compensationCompleted: true,
    updatedAt: NOW,
  },
];

it.effect("maps every coordinator state onto a valid mobile operation", () =>
  Effect.sync(() => {
    for (const state of ALL_STATES) {
      const mapped = toMobileWorkspaceThreadOperation(state);
      assert.equal(mapped.status, state.status);
      // Round-tripping through the wire schema proves the mapping is total and
      // that no field the transport requires is invented or dropped.
      assert.deepStrictEqual(decodeOperation(encodeOperation(mapped)), mapped);
    }
  }),
);

it.effect("projects a completed operation onto the completed DTO", () =>
  Effect.sync(() => {
    const completed = toMobileWorkspaceThreadCompleted(completedState);
    assert.deepStrictEqual(decodeCompleted(completed), completed);
    assert.equal(completed.threadId, ids.threadId);
    assert.equal(completed.acceptedSequence, 7);
    assert.deepStrictEqual(completed.worktree, {
      path: "/tmp/worktree",
      ref: "commit-abc",
      detached: true,
    });
    // The union member and the standalone DTO must agree exactly.
    assert.deepStrictEqual(toMobileWorkspaceThreadOperation(completedState), completed);
  }),
);

it.effect("accepts the mobile creation input as a coordinator request", () =>
  Effect.sync(() => {
    const input = decodeMobileInput({
      operationId: OPERATION_ID,
      projectId: PROJECT_ID,
      target: { mode: "worktree", baseRef: "main" },
      title: "Fix flaky test",
      modelSelection: { provider: "codex", model: "gpt-5.5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      firstMessage: { text: "Fix the flaky test" },
    });
    const request = fromMobileCreateWorkspaceThreadInput(input);
    assert.deepStrictEqual(decodeRequest(request), request);
    assert.equal(request.operationId, OPERATION_ID);
    assert.deepStrictEqual(request.target, { mode: "worktree", baseRef: "main" });
  }),
);

it.effect("drops an absent title instead of forwarding undefined", () =>
  Effect.sync(() => {
    const input = decodeMobileInput({
      operationId: OPERATION_ID,
      projectId: PROJECT_ID,
      target: { mode: "local" },
      modelSelection: { provider: "codex", model: "gpt-5.5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      firstMessage: { text: "Fix the flaky test" },
    });
    const request = fromMobileCreateWorkspaceThreadInput(input);
    assert.isFalse("title" in request);
    assert.equal(ThreadId.makeUnsafe(ids.threadId), ids.threadId);
  }),
);
