// FILE: PhoneHomeScreen.phone.browser.tsx
// Purpose: Browser regression for the phone home screen — the sidebar's own thread content must
//          render full-width in normal flow at a phone viewport, with no sidebar shell, rail, or
//          Sheet mounted anywhere (the trap this chrome exists to dodge).
// Layer: Phone layout UI test
// Depends on: ~/test/browserHarness (phone viewport + fullscreen host), a stubbed
//             `window.nativeApi` (read directly by `readNativeApi`, so no WebSocket is needed).

import "../../index.css";

import { ProjectId, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarProvider } from "~/components/ui/sidebar";
import { useSpacesUiStore } from "../../spacesUiStore";
import { useStore } from "../../store";
import { renderAtPhoneViewport } from "../../test/browserHarness";
import type { Project, SidebarThreadSummary } from "../../types";
import { useWorkspacePathsStore } from "../../workspacePathsStore";
import { PhoneHomeScreen } from "./PhoneHomeScreen";

const PROJECT_ID = ProjectId.makeUnsafe("phone-home-project");
const THREAD_ID = ThreadId.makeUnsafe("phone-home-thread");
const THREAD_TITLE = "Phone home thread";
const NOW_ISO = "2026-08-07T12:00:00.000Z";
/** Minimum comfortable touch target, in CSS pixels. */
const TOUCH_TARGET_MIN_PX = 44;

function makeProject(): Project {
  return {
    id: PROJECT_ID,
    kind: "project",
    name: "phone-home",
    remoteName: "phone-home",
    folderName: "phone-home",
    localName: null,
    cwd: "/repo/phone-home",
    defaultModelSelection: null,
    expanded: true,
    scripts: [],
  };
}

function makeThread(): SidebarThreadSummary {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: THREAD_TITLE,
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    latestTurn: null,
    lastVisitedAt: NOW_ISO,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
  };
}

/**
 * The narrowest native API the sidebar touches while mounting. `readNativeApi` returns
 * `window.nativeApi` verbatim when present, so this keeps the test off the WebSocket transport
 * entirely; every other call path is react-query backed and tolerates a rejection.
 */
const noopUnsubscribe = () => undefined;

function installNativeApiStub(): void {
  const stub = {
    automation: {
      list: () => Promise.resolve({ definitions: [], runs: [] }),
      onEvent: () => noopUnsubscribe,
    },
    orchestration: {
      getShellSnapshot: () => Promise.resolve({ spaces: [], projects: [], threads: [] }),
    },
    projects: {
      listDevServers: () => Promise.resolve({ servers: [] }),
      discoverScripts: () => Promise.resolve({ targets: [] }),
    },
    server: {
      getConfig: () => Promise.resolve({ providers: [], issues: [], keybindings: [] }),
    },
  };
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: stub,
    writable: true,
  });
}

async function renderPhoneHome(host: HTMLElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Number.POSITIVE_INFINITY } },
  });
  // A one-route memory router: the sidebar only reads location/params/search, so the app's
  // real (compiler-heavy) route graph would add minutes of build time for nothing.
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <PhoneHomeScreen />
        </SidebarProvider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(<RouterProvider router={router} />, { container: host });
}

describe("PhoneHomeScreen", () => {
  let host: HTMLDivElement | null = null;

  beforeEach(async () => {
    localStorage.clear();
    installNativeApiStub();
    useSpacesUiStore.setState({
      activeSpaceId: null,
      lastThreadIdBySpace: {},
      lastProjectIdBySpace: {},
    });
    useWorkspacePathsStore.setState({
      homeDir: "/home/test",
      chatWorkspaceRoot: "/home/test/.synara/chats",
      studioWorkspaceRoot: "/home/test/.synara/studio",
    });
    useStore.setState({
      projects: [makeProject()],
      spaces: [],
      threadIds: [THREAD_ID],
      sidebarThreadSummaryById: { [THREAD_ID]: makeThread() },
      threadsHydrated: true,
    });
    host = await renderAtPhoneViewport();
  });

  afterEach(() => {
    if (host?.isConnected) host.remove();
    host = null;
  });

  it("renders the sidebar's thread content full-width with no sidebar shell", async () => {
    if (!host) throw new Error("missing host");
    const screen = await renderPhoneHome(host);

    try {
      const root = await vi.waitUntil(
        () => document.querySelector<HTMLElement>('[data-testid="phone-home-screen"]'),
        { timeout: 20_000, interval: 25 },
      );

      // Domain content: the same thread list the desktop sidebar renders.
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(THREAD_TITLE);
        },
        { timeout: 20_000, interval: 25 },
      );

      // The trap: below 768px the <Sidebar> primitive auto-renders a Sheet. The phone chrome
      // must never mount it, so neither the primitive nor a dialog may exist.
      expect(document.querySelector('[data-slot="sidebar"]')).toBeNull();
      expect(document.querySelector('[data-slot="sidebar-container"]')).toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      // Desktop-only chrome: wordmark row + its SidebarTrigger, and the footer nav.
      expect(document.querySelector('[data-sidebar="header"]')).toBeNull();
      expect(document.querySelector('[data-slot="sidebar-trigger"]')).toBeNull();
      expect(document.querySelector('[data-sidebar="footer"]')).toBeNull();

      // Full-width in normal document flow, not a fixed/off-canvas panel.
      expect(root.getBoundingClientRect().width).toBe(390);
      expect(getComputedStyle(root).position).toBe("static");
    } finally {
      await screen.unmount();
    }
  });

  it("adds no tab-bar clearance of its own", async () => {
    if (!host) throw new Error("missing host");
    const screen = await renderPhoneHome(host);

    try {
      const root = await vi.waitUntil(
        () => document.querySelector<HTMLElement>('[data-testid="phone-home-screen"]'),
        { timeout: 20_000, interval: 25 },
      );
      const scroller = root.firstElementChild;
      expect(scroller).not.toBeNull();

      // `PhoneAppShell` already pads the wrapper this screen mounts into with
      // `PHONE_TAB_BAR_CONTENT_INSET_CLASS`. A second clearance here (this screen used to carry
      // `pb-[calc(env(safe-area-inset-bottom)+4.5rem)]`) stacks with it and strands the last
      // thread row ~72px above the bar, so the padding must stay the shell's job alone.
      expect(getComputedStyle(scroller as HTMLElement).paddingBottom).toBe("0px");
    } finally {
      await screen.unmount();
    }
  });

  it("gives thread rows a comfortable touch target", async () => {
    if (!host) throw new Error("missing host");
    const screen = await renderPhoneHome(host);

    try {
      const row = await vi.waitUntil(
        () =>
          Array.from(
            document.querySelectorAll<HTMLElement>('[data-sidebar="menu-sub-button"]'),
          ).find((candidate) => candidate.textContent?.includes(THREAD_TITLE)) ?? null,
        { timeout: 20_000, interval: 25 },
      );

      // Thread row (28px on desktop) and the project/primary-action rows above it must all
      // clear the 44px touch minimum under the phone chrome. Rounded because the browser
      // reports rem-derived heights with subpixel error (43.999996 for 2.75rem).
      expect(Math.round(row.getBoundingClientRect().height)).toBeGreaterThanOrEqual(
        TOUCH_TARGET_MIN_PX,
      );
      const primaryAction = Array.from(
        document.querySelectorAll<HTMLElement>('[data-sidebar="menu-button"]'),
      ).find((candidate) => candidate.textContent?.includes("New thread"));
      expect(Math.round(primaryAction?.getBoundingClientRect().height ?? 0)).toBeGreaterThanOrEqual(
        TOUCH_TARGET_MIN_PX,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the help menu reachable in an in-flow footer", async () => {
    if (!host) throw new Error("missing host");
    const screen = await renderPhoneHome(host);

    try {
      const footer = await vi.waitUntil(
        () => document.querySelector<HTMLElement>('[data-testid="phone-sidebar-footer"]'),
        { timeout: 20_000, interval: 25 },
      );

      // Keyboard shortcuts and Send feedback live only behind this menu, so suppressing the
      // desktop footer must not take them with it. It is a plain row in the scrolled content:
      // never the pinned SidebarFooter primitive, never fixed.
      expect(document.querySelector('[data-sidebar="footer"]')).toBeNull();
      expect(getComputedStyle(footer).position).toBe("static");

      const threadRow = Array.from(
        document.querySelectorAll<HTMLElement>('[data-sidebar="menu-sub-button"]'),
      ).find((candidate) => candidate.textContent?.includes(THREAD_TITLE));
      expect(threadRow).toBeDefined();
      expect(footer.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        threadRow?.getBoundingClientRect().bottom ?? 0,
      );

      // The desktop trigger is a 20px square icon button; min-height alone would not make it
      // tappable, so the phone footer grows the whole box.
      const helpTrigger = footer.querySelector<HTMLElement>('[aria-label="Help"]');
      expect(helpTrigger).not.toBeNull();
      const helpBox = helpTrigger?.getBoundingClientRect();
      expect(Math.round(helpBox?.height ?? 0)).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
      expect(Math.round(helpBox?.width ?? 0)).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);

      // Settings has a tab of its own, so the footer must not compete with the tab bar.
      expect(footer.textContent).not.toContain("Settings");
    } finally {
      await screen.unmount();
    }
  });

  it("opens the feedback entry point from the phone footer", async () => {
    if (!host) throw new Error("missing host");
    const screen = await renderPhoneHome(host);

    try {
      const helpTrigger = await vi.waitUntil(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="phone-sidebar-footer"] [aria-label="Help"]',
          ),
        { timeout: 20_000, interval: 25 },
      );

      helpTrigger.click();

      // Feedback has no other entry point in the app; the menu is still the desktop popover
      // until menus become sheets, so this only asserts the capability is routable.
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Send feedback");
          expect(document.body.textContent).toContain("Keyboard shortcuts");
        },
        { timeout: 20_000, interval: 25 },
      );
    } finally {
      await screen.unmount();
    }
  });
});
