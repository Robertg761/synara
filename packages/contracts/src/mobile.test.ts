import { Cause, Exit, Schema } from "effect";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ApprovalRequestId,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "./baseSchemas";
import {
  MOBILE_CAPABILITIES,
  MOBILE_PAIRING_PAYLOAD_VERSION,
  MOBILE_PROTOCOL_EPOCH,
  MOBILE_PROTOCOL_MAX_REVISION,
  MOBILE_PROTOCOL_MIN_REVISION,
  MobileClientFrame,
  MobileDescriptor,
  MobileOperationId,
  MobilePairingPayload,
  MobileRelativePath,
  MobileRequestId,
  MobileRootId,
  MobileServerFrame,
  MobileSubscriptionId,
} from "./mobile";
import type { OrchestrationProjectShell, OrchestrationThreadShell } from "./orchestration";

// Fixtures are the cross-language conformance surface: the Swift client decodes
// the exact bytes committed here, so every value is deterministic and every
// secret-shaped field is an obvious test-only placeholder.

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/mobile-v1/", import.meta.url));
const UPDATE_FIXTURES = process.env.MOBILE_FIXTURES === "update";

type AnyFixture = { readonly schema: Schema.Top; readonly value: unknown };

const fixture = <S extends Schema.Top>(schema: S, value: S["Type"]): AnyFixture => ({
  schema,
  value,
});

const branded = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(schema as never) as (value: string) => Schema.Schema.Type<S>;

const environmentId = branded(EnvironmentId);
const projectId = branded(ProjectId);
const threadId = branded(ThreadId);
const messageId = branded(MessageId);
const commandId = branded(CommandId);
const turnId = branded(TurnId);
const eventId = branded(EventId);
const approvalRequestId = branded(ApprovalRequestId);
const requestId = branded(MobileRequestId);
const subscriptionId = branded(MobileSubscriptionId);
const operationId = branded(MobileOperationId);
const rootId = branded(MobileRootId);
const relativePath = branded(MobileRelativePath);

const ENVIRONMENT_ID = environmentId("11111111-1111-4111-8111-111111111111");
const SERVER_INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const SERVER_BUILD = "0.6.3";
const CLIENT_BUILD = "SynaraIOS/0.1.0";
const PROJECT_ID = projectId("33333333-3333-4333-8333-333333333333");
const THREAD_ID = threadId("44444444-4444-4444-8444-444444444444");
const MESSAGE_ID = messageId("55555555-5555-4555-8555-555555555555");
const COMMAND_ID = commandId("66666666-6666-4666-8666-666666666666");
const TURN_ID = turnId("77777777-7777-4777-8777-777777777777");
const REQUEST_ID = requestId("88888888-8888-4888-8888-888888888888");
const SUBSCRIPTION_ID = subscriptionId("99999999-9999-4999-8999-999999999999");
const OPERATION_ID = operationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const APPROVAL_REQUEST_ID = approvalRequestId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const EVENT_ID = eventId("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const ROOT_ID = rootId("root-01");

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const UPDATED_AT = "2026-01-01T00:05:00.000Z";

const MODEL_SELECTION = {
  provider: "codex",
  model: "gpt-5.5",
  options: { reasoningEffort: "high" },
} as const;

const PROJECT_SHELL: OrchestrationProjectShell = {
  id: PROJECT_ID,
  kind: "project",
  title: "Synara",
  workspaceRoot: "/Users/tester/Developer/synara",
  defaultModelSelection: MODEL_SELECTION,
  scripts: [],
  isPinned: false,
  spaceId: null,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

const THREAD_SHELL: OrchestrationThreadShell = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Fix the mobile sync gap",
  modelSelection: MODEL_SELECTION,
  runtimeMode: "full-access",
  interactionMode: "default",
  envMode: "local",
  branch: null,
  worktreePath: null,
  workingDirectory: null,
  associatedWorktreePath: null,
  associatedWorktreeBranch: null,
  associatedWorktreeRef: null,
  createBranchFlowCompleted: false,
  isPinned: false,
  parentThreadId: null,
  creationSource: null,
  sourceThreadId: null,
  sourceTurnId: null,
  gatewayOperationId: null,
  gatewayOperationIndex: null,
  subagentAgentId: null,
  subagentNickname: null,
  subagentRole: null,
  forkSourceThreadId: null,
  sidechatSourceThreadId: null,
  lastKnownPr: null,
  latestTurn: null,
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
  archivedAt: null,
  handoff: null,
  session: null,
};

const WORKTREE_THREAD_SHELL: OrchestrationThreadShell = {
  ...THREAD_SHELL,
  envMode: "worktree",
  worktreePath: "/Users/tester/.synara/worktrees/synara-44444444",
  associatedWorktreePath: "/Users/tester/.synara/worktrees/synara-44444444",
  associatedWorktreeRef: "main",
};

const OPERATION_COMPLETED = {
  status: "completed",
  operationId: OPERATION_ID,
  threadId: THREAD_ID,
  messageId: MESSAGE_ID,
  commandId: COMMAND_ID,
  acceptedSequence: 1042,
  thread: THREAD_SHELL,
  worktree: null,
  updatedAt: UPDATED_AT,
} as const;

const FIXTURES: Record<string, AnyFixture> = {
  // ── HTTP bootstrap ──────────────────────────────────────────────────
  descriptor: fixture(MobileDescriptor, {
    protocolEpoch: MOBILE_PROTOCOL_EPOCH,
    minRevision: MOBILE_PROTOCOL_MIN_REVISION,
    maxRevision: MOBILE_PROTOCOL_MAX_REVISION,
    serverInstanceId: SERVER_INSTANCE_ID,
    serverBuild: SERVER_BUILD,
    environment: {
      environmentId: ENVIRONMENT_ID,
      label: "Tester's MacBook Pro",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: SERVER_BUILD,
      capabilities: { repositoryIdentity: true },
    },
    capabilities: [...MOBILE_CAPABILITIES],
  }),

  "pairing-payload": fixture(MobilePairingPayload, {
    version: MOBILE_PAIRING_PAYLOAD_VERSION,
    baseUrl: "https://mac.example-tailnet.ts.net",
    environmentId: ENVIRONMENT_ID,
    credential: "TEST-ONLY-PAIRING-CREDENTIAL-000000",
    expiresAt: "2026-01-01T00:05:00.000Z",
  }),

  // ── Handshake ───────────────────────────────────────────────────────
  "client-hello": fixture(MobileClientFrame, {
    type: "hello",
    protocol: MOBILE_PROTOCOL_EPOCH,
    minRevision: MOBILE_PROTOCOL_MIN_REVISION,
    maxRevision: MOBILE_PROTOCOL_MAX_REVISION,
    environmentId: ENVIRONMENT_ID,
    serverInstanceId: SERVER_INSTANCE_ID,
    clientBuild: CLIENT_BUILD,
  }),

  "server-hello-accepted": fixture(MobileServerFrame, {
    type: "hello-accepted",
    protocol: MOBILE_PROTOCOL_EPOCH,
    negotiatedRevision: MOBILE_PROTOCOL_MAX_REVISION,
    environmentId: ENVIRONMENT_ID,
    serverInstanceId: SERVER_INSTANCE_ID,
    serverBuild: SERVER_BUILD,
    capabilities: [...MOBILE_CAPABILITIES],
  }),

  "server-failure-hello-incompatible": fixture(MobileServerFrame, {
    type: "failure",
    requestId: null,
    method: null,
    error: {
      code: "protocol_incompatible",
      message: "This Synara server speaks mobile.v1 revision 1 only. Update the iOS app.",
      retryable: false,
    },
  }),

  // ── Liveness ────────────────────────────────────────────────────────
  "server-ping": fixture(MobileServerFrame, {
    type: "ping",
    nonce: "ping-0001",
    sentAt: CREATED_AT,
  }),

  "client-pong": fixture(MobileClientFrame, {
    type: "pong",
    nonce: "ping-0001",
  }),

  "client-connection-probe-request": fixture(MobileClientFrame, {
    type: "request",
    requestId: REQUEST_ID,
    method: "connection.probe",
    params: {},
  }),

  "server-connection-probe-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "connection.probe",
    result: {
      environmentId: ENVIRONMENT_ID,
      serverInstanceId: SERVER_INSTANCE_ID,
      negotiatedRevision: MOBILE_PROTOCOL_MAX_REVISION,
      serverTime: CREATED_AT,
    },
  }),

  "client-cancel-request": fixture(MobileClientFrame, {
    type: "cancel-request",
    requestId: REQUEST_ID,
  }),

  // ── Shell stream ────────────────────────────────────────────────────
  "client-subscribe-shell": fixture(MobileClientFrame, {
    type: "subscribe",
    subscriptionId: SUBSCRIPTION_ID,
    stream: "orchestration.shell",
    params: { sinceSequence: 1024 },
  }),

  "server-shell-snapshot": fixture(MobileServerFrame, {
    type: "snapshot",
    subscriptionId: SUBSCRIPTION_ID,
    stream: "orchestration.shell",
    snapshot: {
      snapshotSequence: 1040,
      spaces: [],
      projects: [PROJECT_SHELL],
      threads: [THREAD_SHELL],
      updatedAt: UPDATED_AT,
    },
  }),

  "server-shell-event": fixture(MobileServerFrame, {
    type: "event",
    subscriptionId: SUBSCRIPTION_ID,
    stream: "orchestration.shell",
    event: {
      kind: "thread-upserted",
      sequence: 1042,
      thread: THREAD_SHELL,
    },
  }),

  "server-shell-synchronized": fixture(MobileServerFrame, {
    type: "synchronized",
    subscriptionId: SUBSCRIPTION_ID,
    stream: "orchestration.shell",
    sequence: 1042,
  }),

  "server-shell-reset-required": fixture(MobileServerFrame, {
    type: "reset-required",
    subscriptionId: SUBSCRIPTION_ID,
    stream: "orchestration.shell",
    reason: "stream-overflow",
    message: "Replay exceeded the durable event window; resubscribe for a fresh snapshot.",
  }),

  // ── Thread stream ───────────────────────────────────────────────────
  "client-subscribe-thread": fixture(MobileClientFrame, {
    type: "subscribe",
    subscriptionId: SUBSCRIPTION_ID,
    stream: "orchestration.thread",
    params: { threadId: THREAD_ID, sinceSequence: 1040 },
  }),

  "server-thread-snapshot": fixture(MobileServerFrame, {
    type: "snapshot",
    subscriptionId: SUBSCRIPTION_ID,
    stream: "orchestration.thread",
    snapshot: {
      snapshotSequence: 1042,
      thread: {
        ...THREAD_SHELL,
        deletedAt: null,
        messages: [
          {
            id: MESSAGE_ID,
            role: "user",
            text: "Fix the mobile sync gap.",
            turnId: TURN_ID,
            streaming: false,
            source: "native",
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
        ],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      },
    },
  }),

  "server-thread-event": fixture(MobileServerFrame, {
    type: "event",
    subscriptionId: SUBSCRIPTION_ID,
    stream: "orchestration.thread",
    event: {
      sequence: 1043,
      eventId: EVENT_ID,
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      occurredAt: UPDATED_AT,
      commandId: COMMAND_ID,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.turn-start-requested",
      payload: {
        threadId: THREAD_ID,
        messageId: MESSAGE_ID,
        dispatchMode: "queue",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: UPDATED_AT,
      },
    },
  }),

  "server-thread-reset-required": fixture(MobileServerFrame, {
    type: "reset-required",
    subscriptionId: SUBSCRIPTION_ID,
    stream: "orchestration.thread",
    reason: "unknown-event",
    message: "Received an event discriminator this client build cannot apply.",
  }),

  "client-unsubscribe": fixture(MobileClientFrame, {
    type: "unsubscribe",
    subscriptionId: SUBSCRIPTION_ID,
  }),

  // ── Providers and models ────────────────────────────────────────────
  "server-list-providers-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "provider.listProviders",
    result: {
      providers: [
        {
          provider: "codex",
          displayName: "Codex",
          available: true,
          authStatus: "authenticated",
          defaultModel: "gpt-5.5",
          supportsAutoRuntimeMode: true,
          checkedAt: UPDATED_AT,
        },
        {
          provider: "claudeAgent",
          displayName: "Claude",
          available: false,
          authStatus: "unauthenticated",
          defaultModel: "claude-sonnet-5",
          supportsAutoRuntimeMode: false,
          checkedAt: UPDATED_AT,
          message: "Run `claude login` on the Mac.",
        },
      ],
      updatedAt: UPDATED_AT,
    },
  }),

  "server-provider-statuses-snapshot": fixture(MobileServerFrame, {
    type: "snapshot",
    subscriptionId: SUBSCRIPTION_ID,
    stream: "provider.statuses",
    snapshot: {
      providers: [
        {
          provider: "codex",
          displayName: "Codex",
          available: true,
          authStatus: "authenticated",
          defaultModel: "gpt-5.5",
          supportsAutoRuntimeMode: true,
          checkedAt: UPDATED_AT,
        },
      ],
      updatedAt: UPDATED_AT,
    },
  }),

  "server-list-models-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "provider.listModels",
    result: {
      provider: "codex",
      models: [
        {
          slug: "gpt-5.5",
          name: "GPT-5.5",
          supportedReasoningEfforts: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
          defaultReasoningEffort: "medium",
          supportsFastMode: true,
          supportsThinkingToggle: false,
        },
      ],
      defaultModel: "gpt-5.5",
      source: "provider-discovery",
      cached: false,
    },
  }),

  // ── Workspace browsing ──────────────────────────────────────────────
  "client-list-roots-request": fixture(MobileClientFrame, {
    type: "request",
    requestId: REQUEST_ID,
    method: "projects.listRoots",
    params: {},
  }),

  "server-list-roots-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "projects.listRoots",
    result: {
      roots: [
        {
          rootId: ROOT_ID,
          label: "Developer",
          displayPath: "~/Developer",
        },
      ],
    },
  }),

  "client-list-directories-request": fixture(MobileClientFrame, {
    type: "request",
    requestId: REQUEST_ID,
    method: "projects.listDirectories",
    params: { rootId: ROOT_ID, relativePath: relativePath("synara") },
  }),

  "server-list-directories-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "projects.listDirectories",
    result: {
      rootId: ROOT_ID,
      relativePath: relativePath("synara"),
      parentRelativePath: relativePath(""),
      entries: [
        { name: "apps", relativePath: relativePath("synara/apps"), isGitRepository: false },
        { name: "packages", relativePath: relativePath("synara/packages"), isGitRepository: false },
      ],
    },
  }),

  "client-create-project-request": fixture(MobileClientFrame, {
    type: "request",
    requestId: REQUEST_ID,
    method: "project.create",
    params: {
      rootId: ROOT_ID,
      relativePath: relativePath("synara"),
      title: "Synara",
      defaultModelSelection: MODEL_SELECTION,
    },
  }),

  "server-create-project-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "project.create",
    result: { project: PROJECT_SHELL, acceptedSequence: 1041 },
  }),

  "server-list-branches-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "git.listBranches",
    result: {
      projectId: PROJECT_ID,
      branches: [
        { name: "main", current: true, isDefault: true, worktreePath: null },
        { name: "codex/mobile-v1", current: false, isDefault: false, worktreePath: null },
      ],
      isRepo: true,
      hasOriginRemote: true,
    },
  }),

  // ── Workspace thread creation ───────────────────────────────────────
  "client-create-thread-local-request": fixture(MobileClientFrame, {
    type: "request",
    requestId: REQUEST_ID,
    method: "workspaceThread.createAndStart",
    params: {
      operationId: OPERATION_ID,
      projectId: PROJECT_ID,
      target: { mode: "local" },
      title: "Fix the mobile sync gap",
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      firstMessage: { text: "Fix the mobile sync gap." },
    },
  }),

  "server-create-thread-local-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "workspaceThread.createAndStart",
    result: OPERATION_COMPLETED,
  }),

  "client-create-thread-worktree-request": fixture(MobileClientFrame, {
    type: "request",
    requestId: REQUEST_ID,
    method: "workspaceThread.createAndStart",
    params: {
      operationId: OPERATION_ID,
      projectId: PROJECT_ID,
      target: { mode: "worktree", baseRef: "main" },
      title: "Fix the mobile sync gap",
      modelSelection: MODEL_SELECTION,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      firstMessage: { text: "Fix the mobile sync gap." },
    },
  }),

  "server-create-thread-worktree-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "workspaceThread.createAndStart",
    result: {
      ...OPERATION_COMPLETED,
      thread: WORKTREE_THREAD_SHELL,
      worktree: {
        path: "/Users/tester/.synara/worktrees/synara-44444444",
        ref: "main",
        detached: true,
      },
    },
  }),

  // ── Workspace thread operation polling ──────────────────────────────
  "client-get-operation-request": fixture(MobileClientFrame, {
    type: "request",
    requestId: REQUEST_ID,
    method: "workspaceThread.getOperation",
    params: { operationId: OPERATION_ID },
  }),

  "server-operation-not-found": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "workspaceThread.getOperation",
    result: { status: "not-found", operationId: OPERATION_ID },
  }),

  "server-operation-pending-reserved": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "workspaceThread.getOperation",
    result: {
      status: "pending",
      operationId: OPERATION_ID,
      phase: "reserved",
      updatedAt: UPDATED_AT,
    },
  }),

  "server-operation-pending-creating-worktree": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "workspaceThread.getOperation",
    result: {
      status: "pending",
      operationId: OPERATION_ID,
      phase: "creating-worktree",
      updatedAt: UPDATED_AT,
    },
  }),

  "server-operation-pending-creating-thread": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "workspaceThread.getOperation",
    result: {
      status: "pending",
      operationId: OPERATION_ID,
      phase: "creating-thread",
      updatedAt: UPDATED_AT,
    },
  }),

  "server-operation-pending-starting-turn": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "workspaceThread.getOperation",
    result: {
      status: "pending",
      operationId: OPERATION_ID,
      phase: "starting-turn",
      updatedAt: UPDATED_AT,
    },
  }),

  "server-operation-compensating": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "workspaceThread.getOperation",
    result: {
      status: "compensating",
      operationId: OPERATION_ID,
      phase: "removing-worktree",
      error: {
        code: "operation_failed",
        message: "Provider session failed to start; reverting owned resources.",
        retryable: false,
      },
      updatedAt: UPDATED_AT,
    },
  }),

  "server-operation-blocked": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "workspaceThread.getOperation",
    result: {
      status: "blocked",
      operationId: OPERATION_ID,
      reason: "worktree-ownership-mismatch",
      ownedResources: [
        {
          kind: "worktree",
          identifier: "/Users/tester/.synara/worktrees/synara-44444444",
        },
      ],
      error: {
        code: "operation_blocked",
        message: "The worktree HEAD moved outside Synara; manual attention is required.",
        retryable: false,
      },
      updatedAt: UPDATED_AT,
    },
  }),

  "server-operation-completed": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "workspaceThread.getOperation",
    result: OPERATION_COMPLETED,
  }),

  "server-operation-failed": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "workspaceThread.getOperation",
    result: {
      status: "failed",
      operationId: OPERATION_ID,
      error: {
        code: "model_unavailable",
        message: "Model gpt-5.5 is not available for provider codex on this Mac.",
        retryable: false,
      },
      compensationCompleted: true,
      updatedAt: UPDATED_AT,
    },
  }),

  // ── Interactive turns ───────────────────────────────────────────────
  "client-turn-start-request": fixture(MobileClientFrame, {
    type: "request",
    requestId: REQUEST_ID,
    method: "clientTurn.start",
    params: {
      threadId: THREAD_ID,
      commandId: COMMAND_ID,
      messageId: MESSAGE_ID,
      message: { text: "Also update the changelog." },
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      dispatchMode: "queue",
    },
  }),

  "server-turn-start-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "clientTurn.start",
    result: { commandId: COMMAND_ID, acceptedSequence: 1044 },
  }),

  "client-turn-interrupt-request": fixture(MobileClientFrame, {
    type: "request",
    requestId: REQUEST_ID,
    method: "clientTurn.interrupt",
    params: { threadId: THREAD_ID, commandId: COMMAND_ID, turnId: TURN_ID },
  }),

  "server-turn-interrupt-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "clientTurn.interrupt",
    result: { commandId: COMMAND_ID, acceptedSequence: 1045 },
  }),

  "client-approval-response-request": fixture(MobileClientFrame, {
    type: "request",
    requestId: REQUEST_ID,
    method: "clientTurn.respondApproval",
    params: {
      threadId: THREAD_ID,
      commandId: COMMAND_ID,
      requestId: APPROVAL_REQUEST_ID,
      lifecycleGeneration: "gen-1",
      decision: "accept",
    },
  }),

  "server-approval-response-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "clientTurn.respondApproval",
    result: { commandId: COMMAND_ID, acceptedSequence: 1046 },
  }),

  "client-user-input-response-request": fixture(MobileClientFrame, {
    type: "request",
    requestId: REQUEST_ID,
    method: "clientTurn.respondUserInput",
    params: {
      threadId: THREAD_ID,
      commandId: COMMAND_ID,
      requestId: APPROVAL_REQUEST_ID,
      lifecycleGeneration: "gen-1",
      answers: { environment: "staging", regions: ["us-east", "eu-west"], notes: null },
    },
  }),

  "server-user-input-response-success": fixture(MobileServerFrame, {
    type: "success",
    requestId: REQUEST_ID,
    method: "clientTurn.respondUserInput",
    result: { commandId: COMMAND_ID, acceptedSequence: 1047 },
  }),

  // ── Failures ────────────────────────────────────────────────────────
  "server-failure-retryable": fixture(MobileServerFrame, {
    type: "failure",
    requestId: REQUEST_ID,
    method: "provider.listModels",
    error: {
      code: "rate_limited",
      message: "Model discovery is already running; retry shortly.",
      retryable: true,
      retryAfterMs: 2000,
    },
  }),

  "server-failure-non-retryable": fixture(MobileServerFrame, {
    type: "failure",
    requestId: REQUEST_ID,
    method: "projects.listDirectories",
    error: {
      code: "path_not_authorized",
      message: "The requested path resolves outside every owner-approved workspace root.",
      retryable: false,
    },
  }),
};

const encodeFixture = (entry: AnyFixture): unknown =>
  Schema.encodeUnknownSync(entry.schema as never)(entry.value);

const serialize = (encoded: unknown): string => `${JSON.stringify(encoded, null, 2)}\n`;

if (UPDATE_FIXTURES) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const [name, entry] of Object.entries(FIXTURES)) {
    writeFileSync(`${FIXTURE_DIR}${name}.json`, serialize(encodeFixture(entry)));
  }
}

describe("mobile.v1 golden fixtures", () => {
  it.each(Object.keys(FIXTURES))("%s encodes to the committed bytes", (name) => {
    const entry = FIXTURES[name]!;
    const committed = readFileSync(`${FIXTURE_DIR}${name}.json`, "utf8");
    expect(serialize(encodeFixture(entry))).toBe(committed);
  });

  it.each(Object.keys(FIXTURES))("%s decodes back to an equal value", (name) => {
    const entry = FIXTURES[name]!;
    const committed = JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, "utf8")) as unknown;
    const decoded = Schema.decodeUnknownSync(entry.schema as never)(committed);
    expect(decoded).toEqual(entry.value);
  });
});

describe("mobile.v1 protocol boundaries", () => {
  it("pins the epoch and revision range", () => {
    expect(MOBILE_PROTOCOL_EPOCH).toBe(1);
    expect(MOBILE_PROTOCOL_MIN_REVISION).toBe(1);
    expect(MOBILE_PROTOCOL_MAX_REVISION).toBe(1);
  });

  it("rejects a method literal outside the allowlist", () => {
    expect(() =>
      Schema.decodeUnknownSync(MobileClientFrame)({
        type: "request",
        requestId: REQUEST_ID,
        method: "terminal.open",
        params: {},
      }),
    ).toThrow();
  });

  it("rejects a stream literal outside the allowlist", () => {
    expect(() =>
      Schema.decodeUnknownSync(MobileClientFrame)({
        type: "subscribe",
        subscriptionId: SUBSCRIPTION_ID,
        stream: "terminal.output",
        params: {},
      }),
    ).toThrow();
  });

  it("rejects params that do not match the method", () => {
    expect(() =>
      Schema.decodeUnknownSync(MobileClientFrame)({
        type: "request",
        requestId: REQUEST_ID,
        method: "provider.listModels",
        params: { threadId: THREAD_ID },
      }),
    ).toThrow();
  });

  it("produces a typed parse error for a malformed envelope", () => {
    const exit = Schema.decodeUnknownExit(MobileServerFrame)({ type: "not-a-frame" });
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
    expect(Schema.isSchemaError(error?._tag === "Some" ? error.value : undefined)).toBe(true);
  });

  it("rejects a non-UUID requestId", () => {
    expect(() =>
      Schema.decodeUnknownSync(MobileClientFrame)({
        type: "cancel-request",
        requestId: "not-a-uuid",
      }),
    ).toThrow();
  });

  it("rejects absolute and escaping relative paths", () => {
    const decodeRelativePath = Schema.decodeUnknownSync(MobileRelativePath);
    expect(decodeRelativePath("")).toBe("");
    expect(decodeRelativePath("apps/server")).toBe("apps/server");
    expect(() => decodeRelativePath("/etc/passwd")).toThrow();
    expect(() => decodeRelativePath("../secrets")).toThrow();
    expect(() => decodeRelativePath("apps/../../secrets")).toThrow();
    expect(() => decodeRelativePath("apps\\server")).toThrow();
  });

  // Documented for Swift: additive server fields are ignored, never fatal, so a
  // revision-1 client keeps working against a newer revision-1-compatible server.
  it("ignores unknown additive object fields on decode", () => {
    const decoded = Schema.decodeUnknownSync(MobileServerFrame)({
      type: "synchronized",
      subscriptionId: SUBSCRIPTION_ID,
      stream: "orchestration.shell",
      sequence: 1042,
      futureField: { anything: true },
    });
    expect(decoded).toEqual({
      type: "synchronized",
      subscriptionId: SUBSCRIPTION_ID,
      stream: "orchestration.shell",
      sequence: 1042,
    });
  });
});
