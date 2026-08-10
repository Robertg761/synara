// FILE: rightDockStore.logic.ts
// Purpose: Pure, testable transitions for the right dock (tabbed multi-pane right sidebar).
// Layer: UI state helpers
// Exports: dock pane types, default-state factory, immutable open/close/activate helpers, and the
//          shared dock-visibility resolvers (desktop dock vs phone `?pane=` screen).

import type { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import type { LayoutMode } from "./lib/layoutMode";
import { isPlainObject, sanitizeStringKeyedRecord } from "./persistedRecord";

// Single source of truth for the dock pane kinds. The union type, the runtime
// validator, the per-kind metadata map, and the add-menu order are all derived
// from this list so they can never drift apart.
export const RIGHT_DOCK_PANE_KINDS = [
  "browser",
  "diff",
  "explorer",
  "file",
  "terminal",
  "sidechat",
  "git",
  "pullRequest",
] as const;

export type RightDockPaneKind = (typeof RIGHT_DOCK_PANE_KINDS)[number];
export type PullRequestInitialTab = "summary" | "timeline" | "code";

const RIGHT_DOCK_PANE_KIND_SET: ReadonlySet<string> = new Set(RIGHT_DOCK_PANE_KINDS);

export interface RightDockPane {
  id: string;
  kind: RightDockPaneKind;
  // sidechat panes point at the embedded thread.
  threadId: ThreadId | null;
  // diff panes remember which turn/file they were opened on.
  diffTurnId: TurnId | null;
  diffFilePath: string | null;
  // file panes preview one workspace-relative file.
  filePath: string | null;
  pullRequestProjectId: ProjectId | null;
  pullRequestRepository: string | null;
  pullRequestNumber: number | null;
  pullRequestInitialTab: PullRequestInitialTab | null;
}

export interface RightDockThreadState {
  open: boolean;
  panes: RightDockPane[];
  activePaneId: string | null;
}

// File previews are the only multi-instance dock kind. Side chats share one
// destination and switch the embedded thread inside it.
const MULTI_INSTANCE_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set(["file"]);

// Kinds that can only ever have one instance per host thread, derived as
// "every kind that is not multi-instance" so the two sets can never drift.
export const SINGLETON_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set(
  RIGHT_DOCK_PANE_KINDS.filter((kind) => !MULTI_INSTANCE_PANE_KINDS.has(kind)),
);

export function isSingletonPaneKind(kind: RightDockPaneKind): boolean {
  return SINGLETON_PANE_KINDS.has(kind);
}

export function createDefaultRightDockState(): RightDockThreadState {
  return {
    open: false,
    panes: [],
    activePaneId: null,
  };
}

export function isRightDockPaneKind(value: unknown): value is RightDockPaneKind {
  return typeof value === "string" && RIGHT_DOCK_PANE_KIND_SET.has(value);
}

// Persisted dock state predates the current pane-kind union, so a stale entry
// (e.g. a kind that was renamed or removed) can crash the dock during render.
// Drop any pane we no longer understand and keep the active tab pointing at a
// surviving pane.
function sanitizePersistedPane(value: unknown): RightDockPane | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const candidate = value;
  if (typeof candidate.id !== "string" || !isRightDockPaneKind(candidate.kind)) {
    return null;
  }
  return {
    id: candidate.id,
    kind: candidate.kind,
    threadId: typeof candidate.threadId === "string" ? (candidate.threadId as ThreadId) : null,
    diffTurnId: typeof candidate.diffTurnId === "string" ? (candidate.diffTurnId as TurnId) : null,
    diffFilePath: typeof candidate.diffFilePath === "string" ? candidate.diffFilePath : null,
    filePath: typeof candidate.filePath === "string" ? candidate.filePath : null,
    pullRequestProjectId:
      typeof candidate.pullRequestProjectId === "string"
        ? (candidate.pullRequestProjectId as ProjectId)
        : null,
    pullRequestRepository:
      typeof candidate.pullRequestRepository === "string" ? candidate.pullRequestRepository : null,
    pullRequestNumber:
      typeof candidate.pullRequestNumber === "number" &&
      Number.isInteger(candidate.pullRequestNumber) &&
      candidate.pullRequestNumber > 0
        ? candidate.pullRequestNumber
        : null,
    pullRequestInitialTab:
      candidate.pullRequestInitialTab === "summary" ||
      candidate.pullRequestInitialTab === "timeline" ||
      candidate.pullRequestInitialTab === "code"
        ? candidate.pullRequestInitialTab
        : null,
  };
}

export function sanitizeRightDockThreadState(value: unknown): RightDockThreadState {
  if (!isPlainObject(value)) {
    return createDefaultRightDockState();
  }
  const candidate = value;
  const sanitizedPanes = Array.isArray(candidate.panes)
    ? candidate.panes
        .map(sanitizePersistedPane)
        .filter((pane): pane is RightDockPane => pane !== null)
    : [];
  const persistedActivePaneId =
    typeof candidate.activePaneId === "string" ? candidate.activePaneId : null;
  const keptSingletonPaneIdByKind = new Map<RightDockPaneKind, string>();
  for (const pane of sanitizedPanes) {
    if (
      isSingletonPaneKind(pane.kind) &&
      (pane.id === persistedActivePaneId || !keptSingletonPaneIdByKind.has(pane.kind))
    ) {
      keptSingletonPaneIdByKind.set(pane.kind, pane.id);
    }
  }
  const panes = sanitizedPanes.filter(
    (pane) =>
      !isSingletonPaneKind(pane.kind) || keptSingletonPaneIdByKind.get(pane.kind) === pane.id,
  );
  const activePaneId =
    persistedActivePaneId && panes.some((pane) => pane.id === persistedActivePaneId)
      ? persistedActivePaneId
      : (panes[0]?.id ?? null);
  return {
    open: candidate.open === true,
    panes,
    activePaneId,
  };
}

export function sanitizeRightDockStateByThreadId(
  value: unknown,
): Record<string, RightDockThreadState> {
  return sanitizeStringKeyedRecord(value, (raw) =>
    raw === undefined ? null : sanitizeRightDockThreadState(raw),
  );
}

export interface OpenPaneInput {
  paneId: string;
  kind: RightDockPaneKind;
  threadId?: ThreadId | null;
  diffTurnId?: TurnId | null;
  diffFilePath?: string | null;
  filePath?: string | null;
  pullRequestProjectId?: ProjectId | null;
  pullRequestRepository?: string | null;
  pullRequestNumber?: number | null;
  pullRequestInitialTab?: PullRequestInitialTab | null;
}

function createPane(input: OpenPaneInput): RightDockPane {
  return {
    id: input.paneId,
    kind: input.kind,
    threadId: input.threadId ?? null,
    diffTurnId: input.diffTurnId ?? null,
    diffFilePath: input.diffFilePath ?? null,
    filePath: input.filePath ?? null,
    pullRequestProjectId: input.pullRequestProjectId ?? null,
    pullRequestRepository: input.pullRequestRepository ?? null,
    pullRequestNumber: input.pullRequestNumber ?? null,
    pullRequestInitialTab: input.pullRequestInitialTab ?? null,
  };
}

// Payload to merge into an existing singleton pane when re-opening it. Only
// overwrite content metadata when the caller explicitly targets new content,
// so a bare re-open/toggle keeps the pane focused on what it currently shows.
function singletonPaneReopenPatch(input: OpenPaneInput): Partial<RightDockPane> | null {
  if (input.kind === "sidechat" && input.threadId !== undefined) {
    return { threadId: input.threadId ?? null };
  }
  if (
    input.kind === "diff" &&
    (input.diffTurnId !== undefined || input.diffFilePath !== undefined)
  ) {
    return { diffTurnId: input.diffTurnId ?? null, diffFilePath: input.diffFilePath ?? null };
  }
  if (
    input.kind === "pullRequest" &&
    (input.pullRequestProjectId !== undefined ||
      input.pullRequestRepository !== undefined ||
      input.pullRequestNumber !== undefined ||
      input.pullRequestInitialTab !== undefined)
  ) {
    return {
      pullRequestProjectId: input.pullRequestProjectId ?? null,
      pullRequestRepository: input.pullRequestRepository ?? null,
      pullRequestNumber: input.pullRequestNumber ?? null,
      pullRequestInitialTab: input.pullRequestInitialTab ?? null,
    };
  }
  return null;
}

// Multi-instance file panes reuse an existing pane when it already shows the
// requested path, so re-clicking a file focuses its tab instead of duplicating it.
function findMatchingMultiInstancePane(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockPane | undefined {
  if (input.kind === "file") {
    const filePath = input.filePath ?? null;
    return state.panes.find((pane) => pane.kind === "file" && pane.filePath === filePath);
  }
  return undefined;
}

function findSingletonPane(
  state: RightDockThreadState,
  kind: RightDockPaneKind,
): RightDockPane | undefined {
  return state.panes.find((pane) => pane.kind === kind);
}

// Opens (or focuses) a pane and makes the dock visible. Singleton kinds reuse
// the existing pane and merge diff metadata; multi-instance kinds add a new
// pane unless one already shows the same content (thread / file).
export function openPaneInState(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockThreadState {
  if (isSingletonPaneKind(input.kind)) {
    const existing = findSingletonPane(state, input.kind);
    if (existing) {
      const patch = singletonPaneReopenPatch(input);
      const nextPanes = patch
        ? state.panes.map((pane) => (pane.id === existing.id ? { ...pane, ...patch } : pane))
        : state.panes;
      return { open: true, panes: nextPanes, activePaneId: existing.id };
    }
  } else {
    const existing = findMatchingMultiInstancePane(state, input);
    if (existing) {
      return { open: true, panes: state.panes, activePaneId: existing.id };
    }
  }

  const pane = createPane(input);
  return {
    open: true,
    panes: [...state.panes, pane],
    activePaneId: pane.id,
  };
}

function resolveActiveAfterRemoval(
  panes: RightDockPane[],
  removedIndex: number,
  previousActiveId: string | null,
  removedId: string,
): string | null {
  if (previousActiveId !== removedId) {
    return previousActiveId;
  }
  if (panes.length === 0) {
    return null;
  }
  const neighborIndex = Math.min(removedIndex, panes.length - 1);
  return panes[neighborIndex]?.id ?? null;
}

export function closePaneInState(
  state: RightDockThreadState,
  paneId: string,
): RightDockThreadState {
  const removedIndex = state.panes.findIndex((pane) => pane.id === paneId);
  if (removedIndex === -1) {
    return state;
  }
  const nextPanes = state.panes.filter((pane) => pane.id !== paneId);
  const nextActiveId = resolveActiveAfterRemoval(
    nextPanes,
    removedIndex,
    state.activePaneId,
    paneId,
  );
  return {
    // An open dock with no panes is the launcher state. Closing the final tab
    // returns to that launcher instead of collapsing the entire dock.
    open: state.open,
    panes: nextPanes,
    activePaneId: nextActiveId,
  };
}

export function setActivePaneInState(
  state: RightDockThreadState,
  paneId: string,
): RightDockThreadState {
  if (!state.panes.some((pane) => pane.id === paneId)) {
    return state;
  }
  return { ...state, open: true, activePaneId: paneId };
}

export function setDockOpenInState(
  state: RightDockThreadState,
  open: boolean,
): RightDockThreadState {
  if (state.open === open) {
    return state;
  }
  return { ...state, open };
}

export function updatePaneInState(
  state: RightDockThreadState,
  paneId: string,
  patch: Partial<
    Pick<
      RightDockPane,
      | "diffTurnId"
      | "diffFilePath"
      | "filePath"
      | "threadId"
      | "pullRequestProjectId"
      | "pullRequestRepository"
      | "pullRequestNumber"
      | "pullRequestInitialTab"
    >
  >,
): RightDockThreadState {
  let changed = false;
  const nextPanes = state.panes.map((pane) => {
    if (pane.id !== paneId) {
      return pane;
    }
    const nextPane = { ...pane, ...patch };
    if (
      nextPane.diffTurnId !== pane.diffTurnId ||
      nextPane.diffFilePath !== pane.diffFilePath ||
      nextPane.filePath !== pane.filePath ||
      nextPane.threadId !== pane.threadId ||
      nextPane.pullRequestProjectId !== pane.pullRequestProjectId ||
      nextPane.pullRequestRepository !== pane.pullRequestRepository ||
      nextPane.pullRequestNumber !== pane.pullRequestNumber ||
      nextPane.pullRequestInitialTab !== pane.pullRequestInitialTab
    ) {
      changed = true;
      return nextPane;
    }
    return pane;
  });
  return changed ? { ...state, panes: nextPanes } : state;
}

// Header toggles behave like a visibility switch for a singleton kind: if that
// kind is the active visible pane, collapse the dock (preserving tabs);
// otherwise open/focus it.
export function toggleSingletonPaneInState(
  state: RightDockThreadState,
  input: OpenPaneInput,
): RightDockThreadState {
  const existing = findSingletonPane(state, input.kind);
  if (existing && state.open && state.activePaneId === existing.id) {
    return { ...state, open: false };
  }
  return openPaneInState(state, input);
}

export function resolveActivePane(state: RightDockThreadState): RightDockPane | null {
  if (!state.open || state.activePaneId === null) {
    return null;
  }
  return state.panes.find((pane) => pane.id === state.activePaneId) ?? null;
}

export function findMissingSidechatPaneIds(
  state: RightDockThreadState,
  existingThreadIds: ReadonlySet<ThreadId>,
): readonly string[] {
  return state.panes.flatMap((pane) =>
    pane.kind === "sidechat" && pane.threadId && !existingThreadIds.has(pane.threadId)
      ? [pane.id]
      : [],
  );
}

/**
 * What the dock is showing on screen right now, in the two shapes it can take.
 *
 * - `dockRendered` is about the *desktop* dock component: when it is mounted, the
 *   visible pane is whatever the store says is active (`open` + `activePaneId`).
 * - `phonePaneId` is the phone shape: there is no dock, a single pane is pushed
 *   full screen and the URL (`?pane=`) is the only authority for which one.
 *
 * Exactly one of them is ever meaningful, which is why they travel together: a
 * consumer that reads only `dockRendered` silently treats every phone pane as
 * invisible (no detail lease, wrong toast suppression).
 */
export interface DockVisibility {
  readonly dockRendered: boolean;
  readonly phonePaneId: string | null;
}

/**
 * Single source of truth for "is a dock pane on screen, and which one".
 * Every consumer (detail leases, toast visibility, ...) derives from this rather
 * than re-deriving `view !== "editor"` locally.
 */
export function resolveDockVisibility(input: {
  layoutMode: LayoutMode;
  view: "editor" | undefined;
  urlPaneId: string | null | undefined;
}): DockVisibility {
  // The editor view replaces the whole chat surface: no dock, no pane screen.
  if (input.view === "editor") {
    return { dockRendered: false, phonePaneId: null };
  }
  if (input.layoutMode === "phone") {
    // The desktop dock genuinely is not mounted on phone; visibility is the URL.
    return { dockRendered: false, phonePaneId: input.urlPaneId ?? null };
  }
  return { dockRendered: true, phonePaneId: null };
}

/**
 * The pane a host thread currently shows, or null when nothing of it is on screen.
 * Phone resolves the pushed screen straight from the URL pane id (the store's
 * `open`/`activePaneId` follow it asynchronously and must not gate visibility);
 * desktop keeps the store as the authority.
 */
export function resolveVisibleDockPane(
  visibility: DockVisibility,
  state: RightDockThreadState | null | undefined,
): RightDockPane | null {
  if (!state) {
    return null;
  }
  if (visibility.phonePaneId !== null) {
    return state.panes.find((pane) => pane.id === visibility.phonePaneId) ?? null;
  }
  if (!visibility.dockRendered) {
    return null;
  }
  return resolveActivePane(state);
}

// An active sidechat embeds a full chat, so it needs a detail lease just like a
// split-view pane. Persisted inactive or currently unrendered docks stay out of
// the scarce live-stream budget.
export function resolveVisibleDockSidechatThreadIds(input: {
  visibility: DockVisibility;
  dockStateByThreadId: Record<string, RightDockThreadState | undefined>;
  hostThreadIds: readonly ThreadId[];
}): ThreadId[] {
  if (!input.visibility.dockRendered && input.visibility.phonePaneId === null) {
    return [];
  }

  const sidechatThreadIds: ThreadId[] = [];
  const seenThreadIds = new Set<ThreadId>(input.hostThreadIds);
  for (const hostThreadId of input.hostThreadIds) {
    const visiblePane = resolveVisibleDockPane(
      input.visibility,
      input.dockStateByThreadId[hostThreadId],
    );
    if (
      visiblePane?.kind === "sidechat" &&
      visiblePane.threadId &&
      !seenThreadIds.has(visiblePane.threadId)
    ) {
      seenThreadIds.add(visiblePane.threadId);
      sidechatThreadIds.push(visiblePane.threadId);
    }
  }
  return sidechatThreadIds;
}
