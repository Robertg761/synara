import type { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { stripDiffSearchParams, type DiffRouteSearch } from "../../diffRouteSearch";
import { useRightDockStore } from "../../rightDockStore";
import { resolveRoutePanelBootstrap } from "../../routes/-chatThreadRoute.logic";

export function hasLegacyPanelRoute(search: DiffRouteSearch): boolean {
  return (
    search.panel !== undefined ||
    search.diff !== undefined ||
    search.diffTurnId !== undefined ||
    search.diffFilePath !== undefined
  );
}

/** Consume old panel links in one replacement, before phone history sync takes ownership. */
export function useLegacyPanelRouteMigration(input: {
  threadId: ThreadId;
  search: DiffRouteSearch;
  phone: boolean;
  requestImmediateHydration: (kind: "browser" | "diff") => void;
}): void {
  const { threadId, search, phone, requestImmediateHydration } = input;
  const navigate = useNavigate();
  const lastAppliedSearchKey = useRef<string | null>(null);
  useEffect(() => {
    const result = resolveRoutePanelBootstrap({
      scopeId: threadId,
      search,
      lastAppliedSearchKey: lastAppliedSearchKey.current,
    });
    lastAppliedSearchKey.current = result.nextAppliedSearchKey;
    const patch = result.panelPatch;
    if (!patch) return;
    const store = useRightDockStore.getState();
    if (patch.panel === "browser") {
      requestImmediateHydration("browser");
      store.openPane(threadId, { kind: "browser" });
    } else if (patch.panel === "diff") {
      requestImmediateHydration("diff");
      store.openPane(threadId, {
        kind: "diff",
        diffTurnId: patch.diffTurnId ?? null,
        diffFilePath: patch.diffFilePath ?? null,
      });
    } else {
      store.setDockOpen(threadId, false);
    }
    const paneId = patch.panel
      ? useRightDockStore.getState().dockStateByThreadId[threadId]?.activePaneId
      : null;
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        ...(phone && paneId ? { pane: paneId } : {}),
      }),
    });
  }, [navigate, phone, requestImmediateHydration, search, threadId]);
}
