import type { ResolvedKeybindingsConfig, ThreadId } from "@synara/contracts";
import type { ChatHeader } from "./ChatHeader";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

export type ChatHeaderProps = Parameters<typeof ChatHeader>[0];

/**
 * Smallest prop set that still renders the leading cluster (thread identity + sidebar
 * navigation controls). Trailing project/git/handoff controls are switched off so the
 * markup under test is the leading edge only.
 */
export function createMinimalChatHeaderProps(): ChatHeaderProps {
  return {
    activeThreadId: "thread-chat-header-test" as ThreadId,
    activeThreadTitle: "Fix auth flow",
    activeThreadEntryPoint: "chat",
    activeProvider: "codex",
    activeProjectName: undefined,
    threadBreadcrumbs: [],
    isGitRepo: false,
    openInTarget: null,
    activeProjectScripts: undefined,
    preferredScriptId: null,
    keybindings: EMPTY_KEYBINDINGS,
    availableEditors: [],
    diffToggleShortcutLabel: null,
    handoffBadgeLabel: null,
    handoffActionLabel: "Hand off",
    handoffDisabled: true,
    handoffActionTargetProviders: [],
    handoffBadgeSourceProvider: null,
    handoffBadgeTargetProvider: null,
    gitCwd: null,
    diffTotals: { additions: 0, deletions: 0, fileCount: 0, hasChanges: false },
    showDiffToggle: false,
    hideHandoffControls: true,
    diffOpen: false,
    onRunProjectScript: () => {},
    onAddProjectScript: async () => {},
    onUpdateProjectScript: async () => {},
    onDeleteProjectScript: async () => {},
    onToggleDiff: () => {},
    onCreateHandoff: () => {},
    onNavigateToThread: () => {},
    onRenameThread: () => {},
  };
}

