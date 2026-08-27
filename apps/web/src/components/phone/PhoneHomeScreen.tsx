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
          body in normal flow precisely so scrolling is owned here, not nested.

          No tab-bar clearance here: the shell already pads the wrapper this screen mounts into
          with `PHONE_TAB_BAR_CONTENT_INSET_CLASS`, so this box is laid out entirely above the
          bar. Adding padding here too left ~72px of dead space under the last thread row. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-safe-t">
        <ThreadSidebar chrome="phone" />
      </div>
    </div>
  );
}
