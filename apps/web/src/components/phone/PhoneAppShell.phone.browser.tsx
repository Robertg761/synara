// FILE: PhoneAppShell.phone.browser.tsx
// Purpose: Browser tests for the phone/desktop split in the `/_chat` route layout — the phone
//          shell (home screen + tab bar + FAB, and a bare full-screen chat on a thread route)
//          versus the untouched desktop sidebar layout.
// Layer: Browser test
// Depends on: ~/test/browserHarness (phone viewport), ~/test/effectRpcWebSocketMock (ws fixture)

import "../../index.css";

import {
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  type ThreadId,
  type WsWelcomePayload,
  WS_METHODS,
} from "@synara/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { ws, http, HttpResponse } from "msw";
import { setupWorker } from "msw/browser";
import { page } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { getRouter } from "../../router";
import { useStore } from "../../store";
import {
  createShellSnapshotFromReadModel,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
} from "../../test/effectRpcWebSocketMock";
import {
  createBrowserTestServerConfig,
  createFullscreenTestHost,
  renderAtPhoneViewport,
} from "../../test/browserHarness";
import { settleInFlightTransportWork } from "../../test/transportTeardown";
import { resetWsNativeApiForTest } from "../../wsNativeApi";

const THREAD_ID = "thread-phone-shell-test" as ThreadId;
const PROJECT_ID = "project-phone-shell" as ProjectId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;
/** Budget for the one-off cold transform of the chat route graph (see `beforeAll`). */
const WARMUP_TIMEOUT_MS = 240_000;

let fixture: {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
};

const wsLink = ws.link(/ws(s)?:\/\/.*/);

let activeRouter: ReturnType<typeof getRouter> | null = null;

function createSnapshot(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    spaces: [],
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: { provider: "codex", model: "gpt-5" },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Test thread",
        modelSelection: { provider: "codex", model: "gpt-5" },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages: [
          {
            id: "msg-1" as MessageId,
            role: "user",
            text: "hello",
            turnId: null,
            streaming: false,
            source: "native",
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          },
        ],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function threadDetail(threadId: ThreadId): OrchestrationReadModel["threads"][number] {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) throw new Error(`Missing thread fixture for ${threadId}`);
  return thread;
}

function resolveWsRpc(tag: string): unknown {
  if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
    return createShellSnapshotFromReadModel(fixture.snapshot);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) return fixture.snapshot;
  if (tag === WS_METHODS.serverGetConfig) return fixture.serverConfig;
  if (tag === WS_METHODS.projectsListDevServers) return { servers: [] };
  if (tag === WS_METHODS.automationList) return { definitions: [], runs: [] };
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) return { entries: [], truncated: false };
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      const parsed = readEffectRpcClientMessage(client, rawData);
      if (parsed.kind !== "request") return;

      const requestBody = flattenEffectRpcRequestPayload(
        parsed.request.tag,
        parsed.request.payload,
      );
      const method = requestBody._tag;
      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "welcome",
          payload: fixture.welcome,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "snapshot",
          config: fixture.serverConfig,
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(fixture.snapshot),
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in requestBody) {
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: fixture.snapshot.snapshotSequence,
            thread: threadDetail(requestBody.threadId as ThreadId),
          },
        });
        return;
      }
      if (
        method === WS_METHODS.subscribeServerProviderStatuses ||
        method === WS_METHODS.subscribeServerSettings ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeOrchestrationDomainEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeAutomationEvents
      ) {
        return;
      }
      sendEffectRpcExit(client, parsed.request.id, resolveWsRpc(method));
    });
  }),
  http.get("*/attachments/:attachmentId", () => new HttpResponse(null, { status: 204 })),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function mountAt(
  host: HTMLDivElement,
  initialEntry: string,
): Promise<{ cleanup: () => Promise<void> }> {
  const router = getRouter(createMemoryHistory({ initialEntries: [initialEntry] }));
  activeRouter = router;
  const screen = await render(<RouterProvider router={router} />, { container: host });
  let cleanedUp = false;
  return {
    cleanup: async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await screen.unmount();
      if (host.isConnected) host.remove();
      await settleInFlightTransportWork();
    },
  };
}

function query(selector: string): Element | null {
  return document.querySelector(selector);
}

/**
 * The <Sidebar> primitive turns into a Sheet below 768px, and the phone shell must never mount
 * it. `[data-slot="sidebar"]` alone would be a vacuous check — that element only exists while
 * the Sheet is OPEN — so assert against the chrome that is in the DOM whether the sheet is open
 * or not: the container, the dialog the Sheet would render, the trigger, and the desktop footer.
 * (Same selector set as `PhoneHomeScreen.phone.browser.tsx`.)
 */
function expectNoDesktopSidebarChrome(): void {
  expect(query('[data-slot="sidebar"]')).toBeNull();
  expect(query('[data-slot="sidebar-container"]')).toBeNull();
  expect(query('[role="dialog"]')).toBeNull();
  expect(query('[data-slot="sidebar-trigger"]')).toBeNull();
  expect(query('[data-sidebar="footer"]')).toBeNull();
}

async function waitFor(selector: string, timeout = 30_000): Promise<void> {
  try {
    await vi.waitFor(
      () => {
        expect(query(selector), `Expected ${selector} to be present`).not.toBeNull();
      },
      { timeout, interval: 16 },
    );
  } catch (cause) {
    // A stuck mount here is almost always the router, not the assertion — dump enough to
    // tell "route never resolved" apart from "component rendered the wrong branch".
    console.error(
      "phone-shell router state",
      JSON.stringify({
        status: activeRouter?.state.status,
        pathname: activeRouter?.state.location.pathname,
        matches: activeRouter?.state.matches.map((match) => [match.routeId, match.status]),
      }),
    );
    throw cause;
  }
}

describe("phone app shell", () => {
  beforeAll(async () => {
    fixture = {
      snapshot: createSnapshot(),
      serverConfig: createBrowserTestServerConfig(NOW_ISO),
      welcome: {
        cwd: "/repo/project",
        projectName: "Project",
        bootstrapProjectId: PROJECT_ID,
        bootstrapThreadId: THREAD_ID,
      },
    };
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: { url: "/mockServiceWorker.js" },
    });

    // The first mount of the chat route graph makes the Vite dev server transform the whole
    // thread surface (ChatView and friends), which can take minutes on a busy machine and blows
    // past any per-test budget. Pay it once, here, so the tests below only measure rendering.
    await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
    const warmupHost = createFullscreenTestHost();
    const warmup = await mountAt(warmupHost, `/${THREAD_ID}`);
    try {
      await waitFor('[data-slot="sidebar"]', WARMUP_TIMEOUT_MS);
    } finally {
      await warmup.cleanup();
    }
  }, WARMUP_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    await resetWsNativeApiForTest();
    await worker.stop();
    // Leave the shared page geometry as the rest of the suite expects it.
    await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
  });

  beforeEach(async () => {
    await resetWsNativeApiForTest();
    localStorage.clear();
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    useStore.setState({
      projects: [],
      threadIds: [],
      threadShellById: {},
      threadSessionById: {},
      threadTurnStateById: {},
      messageIdsByThreadId: {},
      messageByThreadId: {},
      activityIdsByThreadId: {},
      activityByThreadId: {},
      proposedPlanIdsByThreadId: {},
      proposedPlanByThreadId: {},
      turnDiffIdsByThreadId: {},
      turnDiffSummaryByThreadId: {},
      sidebarThreadSummaryById: {},
      threadsHydrated: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the home screen and tab bar at a phone viewport, with no sidebar sheet", async () => {
    const host = await renderAtPhoneViewport();
    const mounted = await mountAt(host, "/");

    try {
      await waitFor('[data-testid="phone-app-shell"]');
      await waitFor('[data-testid="phone-home-screen"]');
      await waitFor('[data-testid="phone-tab-bar"]');

      expect(query('[data-testid="phone-tab-home"]')).not.toBeNull();
      expect(query('[data-testid="phone-tab-settings"]')).not.toBeNull();
      expectNoDesktopSidebarChrome();

      // Touch targets: the tab row must clear the 44px minimum.
      const homeTab = query('[data-testid="phone-tab-home"]');
      expect(homeTab?.getBoundingClientRect().height ?? 0).toBeGreaterThanOrEqual(44);
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the tab bar and renders the thread route full-screen on a thread URL", async () => {
    const host = await renderAtPhoneViewport();
    const mounted = await mountAt(host, `/${THREAD_ID}`);

    try {
      await waitFor('[data-testid="phone-app-shell"]');
      // Positive assertion first: "no home screen, no tab bar" is also true of a shell that
      // rendered nothing at all, so require the chat surface itself to be on screen.
      await waitFor("[data-chat-composer-form='true']");
      expect(query("[data-chat-scroll-container='true']")).not.toBeNull();
      await vi.waitFor(
        () => {
          expect(query('[data-testid="phone-home-screen"]')).toBeNull();
          expect(query('[data-testid="phone-tab-bar"]')).toBeNull();
        },
        { timeout: 30_000, interval: 16 },
      );
      expectNoDesktopSidebarChrome();
      // The chat surface owns the only way back to Home on this screen (no tab bar here), so
      // there must be a back affordance in its header.
      expect(query('[aria-label="Back to chats"]')).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the desktop sidebar layout at a desktop viewport", async () => {
    await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
    const host = createFullscreenTestHost();
    const mounted = await mountAt(host, `/${THREAD_ID}`);

    try {
      await waitFor('[data-slot="sidebar"]');
      expect(query('[data-testid="phone-app-shell"]')).toBeNull();
      expect(query('[data-testid="phone-tab-bar"]')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });
});
