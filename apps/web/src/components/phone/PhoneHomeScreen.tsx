// FILE: PhoneHomeScreen.tsx
// Purpose: Full-screen phone home surface — the thread sidebar's own content (space switcher
//          chips, thread list, "Needs you" activity view) rendered full-width in normal document
//          flow, with no sidebar shell, rail, or Sheet anywhere in the tree.
// Layer: Phone layout component
// Exports: PhoneHomeScreen
// Depends on: ~/components/Sidebar (the shared domain content, via its `chrome` prop). The phone
//             shell mounts this inside a SidebarProvider and pins its own bottom tab bar over it.

import type { ReactElement } from "react";

import ThreadSidebar from "~/components/Sidebar";
import { cn } from "~/lib/utils";

/**
 * Bottom breathing room under the last thread row. The shell's tab bar is ~56px tall and sits on
 * top of the home indicator, so the scroll content has to clear both plus a little slack — the
 * last row must stay tappable, not merely visible.
 */
const TAB_BAR_CLEARANCE_CLASS_NAME = "pb-[calc(env(safe-area-inset-bottom)+4.5rem)]";

/**
 * The phone home screen. Deliberately thin: it owns arrangement (one full-height scroll
 * container, safe-area padding, tab-bar clearance) and nothing else. All domain content comes
 * from the one thread-sidebar implementation, asked for its phone chrome — never a fork of it.
 *
 * The `chrome` prop is how arrangement is chosen; this component never reads `useLayoutMode`,
 * pointer media queries, or the shell platform. The caller already decided by mounting it.
 */
export function PhoneHomeScreen(): ReactElement {
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="phone-home-screen">
      {/* The single scroll container for the screen: the phone chrome renders the sidebar's
          body in normal flow precisely so scrolling is owned here, not nested. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain pt-safe-t",
          TAB_BAR_CLEARANCE_CLASS_NAME,
        )}
      >
        <ThreadSidebar chrome="phone" />
      </div>
    </div>
  );
}
