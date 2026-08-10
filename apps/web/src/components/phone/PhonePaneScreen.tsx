// FILE: PhonePaneScreen.tsx
// Purpose: Present one right-dock pane as a full-screen pushed screen on phone layouts, where the
//          RightDock (a nested Sidebar that would become a Sheet under 768px) never mounts.
// Layer: Phone layout component
// Exports: PhonePaneScreen
// Depends on: the host surface's dock pane renderer and the shared chat header row tokens.

import type { ReactNode } from "react";

import type { DockPaneRuntimeMode } from "~/lib/dockPaneActivation";
import { XIcon } from "~/lib/icons";
import type { RightDockPane } from "~/rightDockStore.logic";
import { cn } from "~/lib/utils";
import { CHAT_SURFACE_HEADER_ROW_CLASS_NAME } from "../chat/chatHeaderControls";
import { IconButton } from "../ui/icon-button";

/** Comfortable phone hit target for the only control on this screen. */
const PHONE_PANE_CLOSE_BUTTON_CLASS = "!size-11 rounded-xl [&_svg]:!size-5";

export function PhonePaneScreen(props: {
  pane: RightDockPane;
  /** Same label the desktop dock tab shows (file/pull-request overrides included). */
  title: string;
  runtimeMode: DockPaneRuntimeMode;
  onClose: () => void;
  /**
   * The host surface's dock pane renderer — the exact callback the RightDock uses on
   * desktop, so a pane behaves identically on both layouts.
   */
  renderPane: (
    pane: RightDockPane,
    context: { runtimeMode: DockPaneRuntimeMode; isActive: boolean; isVisible: boolean },
  ) => ReactNode;
}) {
  return (
    // A pushed screen, not a modal: it is backed by a real history entry and has no
    // focus trap, so it stays a labelled region rather than claiming `role="dialog"`.
    <section
      data-phone-pane-screen
      data-pane-kind={props.pane.kind}
      aria-label={props.title}
      // Fixed + inset-0 so the screen covers the chat (and its composer/keyboard inset)
      // rather than sharing the surface row the way the desktop dock does.
      className="fixed inset-0 z-50 flex flex-col bg-background pt-safe-t text-foreground"
    >
      <div className={cn(CHAT_SURFACE_HEADER_ROW_CLASS_NAME, "gap-2 px-2")}>
        <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-lg,13px)] font-medium">
          {props.title}
        </span>
        <IconButton
          label={`Close ${props.title}`}
          variant="ghost"
          size="icon"
          className={PHONE_PANE_CLOSE_BUTTON_CLASS}
          onClick={props.onClose}
        >
          <XIcon />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">
        {/* Same absolute pane box the dock gives its active pane, so panes that size
            themselves against the host (diff, terminal, browser) get identical
            constraints on both layouts. The bottom safe-area inset sits here rather than on the
            <section> or this box's parent: an absolutely positioned child is laid out against
            its containing block's PADDING box, so padding above it would not move the pane at
            all — and terminal prompts / git action rows would keep sitting under the home
            indicator. */}
        <div
          className="absolute inset-0 flex min-h-0 w-full pb-safe-b"
          // Mirrors the dock's marker so the native browser overlay can find the live
          // browser surface on phone exactly as it does on desktop.
          data-native-browser-surface={
            props.pane.kind === "browser" && props.runtimeMode === "live" ? "true" : undefined
          }
        >
          {props.renderPane(props.pane, {
            runtimeMode: props.runtimeMode,
            isActive: true,
            isVisible: true,
          })}
        </div>
      </div>
    </section>
  );
}

export default PhonePaneScreen;
