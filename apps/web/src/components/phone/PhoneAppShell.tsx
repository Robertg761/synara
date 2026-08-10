// FILE: PhoneAppShell.tsx
// Purpose: Phone-viewport app shell for the `/_chat` route tree — a full-screen home surface with
//          a bottom tab bar and a new-thread FAB, and a full-screen chat surface (no tab bar) once
//          a thread route is active.
// Layer: Phone layout component
// Exports: PhoneAppShell
// Depends on: ~/components/ui/sidebar (SidebarProvider, for context ONLY — never the <Sidebar>
//             primitive), ./PhoneHomeScreen, ./PhoneTabBar, ~/hooks/useHandleNewThread,
//             ~/hooks/usePrimaryNewThreadTarget (which project a global "new thread" targets)

import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, type ReactElement, type ReactNode } from "react";

import { useAppSettings } from "~/appSettings";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { SidebarProvider } from "~/components/ui/sidebar";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { usePrimaryNewThreadTarget } from "~/hooks/usePrimaryNewThreadTarget";
import { NewThreadIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useSpacesUiStore } from "~/spacesUiStore";

import { PhoneHomeScreen } from "./PhoneHomeScreen";
import { PHONE_TAB_BAR_CONTENT_INSET_CLASS, PhoneTabBar, type PhoneTab } from "./PhoneTabBar";

/** Route ids the shell branches on. Generated ids, see `routeTree.gen.ts`. */
const THREAD_ROUTE_ID = "/_chat/$threadId";
const CHAT_INDEX_ROUTE_ID = "/_chat/";
const SETTINGS_ROUTE_ID = "/_chat/settings";

/** What the shell should put on screen for the currently matched route. */
type PhoneSurface = "thread" | "home" | "route";

function resolvePhoneSurface(leafRouteId: string | null): PhoneSurface {
  if (leafRouteId === THREAD_ROUTE_ID) return "thread";
  // The `_chat` index route is a cold-start *restore* machine: mounting it immediately
  // navigates into the last (or a fresh) thread. On phone the index URL is the home
  // destination, so the shell renders the home screen INSTEAD of <Outlet/> — not rendering
  // the outlet is what keeps that redirect from firing and bouncing Home into a chat.
  if (leafRouteId === CHAT_INDEX_ROUTE_ID) return "home";
  return "route";
}

/**
 * Which tab, if any, owns the matched route. Only the two root destinations map to a tab: the
 * other tab-bar-visible routes (Kanban, Automations, Pull requests, Studio, Plugins) are pushed
 * on top of Home, not Home itself, so they select nothing rather than marking Home as the
 * current page.
 */
function resolvePhoneTab(leafRouteId: string | null): PhoneTab | null {
  if (leafRouteId === SETTINGS_ROUTE_ID) return "settings";
  if (leafRouteId === CHAT_INDEX_ROUTE_ID) return "home";
  return null;
}

export function PhoneAppShell({
  children,
}: {
  /**
   * Non-visual mounts that must live inside the sidebar context (global shortcuts, maintenance
   * toasts). They are owned by the route module, so the shell takes them as children rather
   * than importing back into the route (which would be a cycle).
   */
  readonly children?: ReactNode;
}): ReactElement {
  const navigate = useNavigate();
  const leafRouteId = useRouterState({
    select: (state) => (state.matches.at(-1)?.routeId as string | undefined) ?? null,
  });
  const surface = resolvePhoneSurface(leafRouteId);
  const activeTab = resolvePhoneTab(leafRouteId);

  const { activeProjectId, handleNewThread, projects } = useHandleNewThread();
  const { settings } = useAppSettings();
  const activeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  // Which project the FAB creates a thread in. Same wiring as the sidebar's primary
  // new-thread button and the `chat.new` shortcut, so the three can never disagree.
  const newThreadProjectId =
    usePrimaryNewThreadTarget({ activeSpaceId, focusedProjectId: activeProjectId, projects }).target
      ?.projectId ?? null;

  const handleSelectTab = useCallback(
    (tab: PhoneTab) => {
      void navigate({ to: tab === "settings" ? "/settings" : "/" });
    },
    [navigate],
  );

  const handleNewThreadFromFab = useCallback(() => {
    if (!newThreadProjectId) return;
    void handleNewThread(newThreadProjectId, {
      envMode: resolveSidebarNewThreadEnvMode({ defaultEnvMode: settings.defaultThreadEnvMode }),
    });
  }, [handleNewThread, newThreadProjectId, settings.defaultThreadEnvMode]);

  // SidebarProvider supplies the `useSidebar()` context that route descendants (global
  // shortcuts, chat header) require. No <Sidebar> is mounted: below the phone breakpoint that
  // primitive renders a Sheet, and a Sheet over the phone shell would hijack navigation.
  //
  // These classes MERGE with SidebarProvider's own `flex min-h-svh w-full` — they do not replace
  // them, and that is intentional. `flex-col` flips its row axis to a column, and `h-dvh` pins
  // the shell to the dynamic viewport height while the inherited `min-h-svh` floor stays
  // harmless underneath it (svh <= dvh by definition, so the floor can never exceed the pinned
  // height). Don't "clean this up" by dropping one of them without checking the provider.
  return (
    <SidebarProvider
      className="relative h-dvh flex-col overflow-hidden bg-background"
      data-testid="phone-app-shell"
      defaultOpen={false}
    >
      {children}
      <div
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          surface === "thread" ? null : PHONE_TAB_BAR_CONTENT_INSET_CLASS,
        )}
      >
        {surface === "home" ? <PhoneHomeScreen /> : <Outlet />}
      </div>
      {surface === "thread" ? null : (
        <>
          {surface === "home" && newThreadProjectId ? (
            <button
              aria-label="New thread"
              className="fixed right-4 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+1rem)] z-40 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-opacity active:opacity-80"
              data-testid="phone-new-thread-fab"
              onClick={handleNewThreadFromFab}
              type="button"
            >
              <NewThreadIcon className="size-6" />
            </button>
          ) : null}
          <PhoneTabBar activeTab={activeTab} onSelectTab={handleSelectTab} />
        </>
      )}
    </SidebarProvider>
  );
}
