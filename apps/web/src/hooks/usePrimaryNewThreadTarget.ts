// FILE: usePrimaryNewThreadTarget.ts
// Purpose: One wiring for "which project does a global new-thread action target" — the Space-scoped
//          project list, the focused/latest resolution, and the resulting target. Shared by every
//          primary new-thread entry point (chat shortcuts, sidebar button, phone FAB) so they can
//          never drift apart.
// Layer: Web hook
// Exports: usePrimaryNewThreadTarget, PrimaryNewThreadTargetInput, PrimaryNewThreadTarget
// Depends on: ~/lib/projectShortcutTargets (the pure rules), ~/lib/spaces, ~/latestProjectStore,
//             ~/workspacePathsStore, ~/storeSelectors

import type { ProjectId, SpaceId } from "@synara/contracts";
import { useMemo } from "react";

import { useLatestProjectStore } from "~/latestProjectStore";
import {
  resolveCurrentProjectTargetId,
  resolveLatestProjectTargetIdWithFallback,
  resolveNewThreadTarget,
  type NewThreadTarget,
} from "~/lib/projectShortcutTargets";
import { isOrdinarySpaceProject } from "~/lib/spaces";
import { useStore } from "~/store";
import { createProjectLastActivityAtSelector } from "~/storeSelectors";
import type { Project } from "~/types";
import { useWorkspacePathsStore } from "~/workspacePathsStore";

export interface PrimaryNewThreadTargetInput {
  /** The full project list (`store.projects`); the hook does the Space scoping itself. */
  readonly projects: readonly Project[];
  /**
   * The project the calling surface considers focused. Each site decides what "focused" means
   * (route project, sidebar selection, active chat), which is why it stays an input.
   */
  readonly focusedProjectId: ProjectId | null;
  /**
   * The Space to scope to. Passed in rather than read from the store because callers differ on
   * how they resolve it (the sidebar validates it against loaded Spaces plus its optimistic
   * pending selection; route-level callers use the stored selection directly).
   */
  readonly activeSpaceId: SpaceId | null;
}

export interface PrimaryNewThreadTarget {
  /**
   * Ordinary (non-container) projects inside the active Space. Shortcuts that target "a project"
   * must stay inside the Space you are looking at, or `mod+alt+arrow` would switch Space and the
   * next new-thread shortcut would drop you back out of it.
   */
  readonly activeSpaceProjects: readonly Project[];
  /** The focused project when it is a usable target in this Space, otherwise null. */
  readonly currentProjectId: ProjectId | null;
  /**
   * This Space's most recently used project. The remembered project is global, so it is unusable
   * the moment you switch Space; this falls back to the Space's own most recent one.
   */
  readonly latestUsableProjectId: ProjectId | null;
  /** Focused project, else latest usable one — see `resolveNewThreadTarget`. Null when neither. */
  readonly target: NewThreadTarget | null;
}

export function usePrimaryNewThreadTarget({
  activeSpaceId,
  focusedProjectId,
  projects,
}: PrimaryNewThreadTargetInput): PrimaryNewThreadTarget {
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  const latestProjectId = useLatestProjectStore((state) => state.latestProjectId);
  const selectProjectLastActivityAt = useMemo(() => createProjectLastActivityAtSelector(), []);
  const projectLastActivityAt = useStore(selectProjectLastActivityAt);

  const activeSpaceProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          isOrdinarySpaceProject(project, { homeDir, chatWorkspaceRoot, studioWorkspaceRoot }) &&
          (project.spaceId ?? null) === activeSpaceId,
      ),
    [activeSpaceId, chatWorkspaceRoot, homeDir, projects, studioWorkspaceRoot],
  );

  const currentProjectId = useMemo(
    () => resolveCurrentProjectTargetId(activeSpaceProjects, focusedProjectId),
    [activeSpaceProjects, focusedProjectId],
  );

  const latestUsableProjectId = useMemo(
    () =>
      resolveLatestProjectTargetIdWithFallback(
        activeSpaceProjects,
        latestProjectId,
        projectLastActivityAt,
      ),
    [activeSpaceProjects, latestProjectId, projectLastActivityAt],
  );

  const target = useMemo(
    () => resolveNewThreadTarget({ currentProjectId, latestUsableProjectId }),
    [currentProjectId, latestUsableProjectId],
  );

  return { activeSpaceProjects, currentProjectId, latestUsableProjectId, target };
}
