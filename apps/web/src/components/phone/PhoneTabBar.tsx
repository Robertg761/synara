// FILE: PhoneTabBar.tsx
// Purpose: Bottom tab bar for the phone app shell — the root destinations (Home / Settings) plus
//          the geometry token the shell uses to keep scrollable content clear of the fixed bar.
// Layer: Phone layout component
// Exports: PhoneTab, PhoneTabBar, PHONE_TAB_BAR_CONTENT_INSET_CLASS
// Depends on: ~/lib/central-icons (Home glyph), ~/lib/icons (Settings glyph), ~/lib/utils

import type { ComponentType, ReactElement } from "react";

import { createCentralIconComponent } from "~/lib/central-icons";
import { SettingsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

/** The phone shell's root destinations. Threads are pushed on top of these, not a tab. */
export type PhoneTab = "home" | "settings";

const HomeIcon = createCentralIconComponent("home-door");

/**
 * 56px touch row — comfortably above the 44px minimum target, and the single number this bar's
 * geometry is built from. Both class constants below spell it out literally (`h-14` === `3.5rem`)
 * because Tailwind extracts class names from source text: a computed template string would never
 * generate a utility. Change one, change the other.
 */
const PHONE_TAB_BAR_ROW_HEIGHT_CLASS = "h-14";

/**
 * Bottom padding a scrollable phone surface needs so the fixed tab bar never covers its last
 * row: the bar's own 3.5rem row plus the device's bottom inset (0px wherever there is none).
 */
export const PHONE_TAB_BAR_CONTENT_INSET_CLASS = "pb-[calc(3.5rem+env(safe-area-inset-bottom))]";

interface PhoneTabDescriptor {
  readonly id: PhoneTab;
  readonly label: string;
  readonly Icon: ComponentType<{ className?: string }>;
}

const PHONE_TABS: readonly PhoneTabDescriptor[] = [
  { id: "home", label: "Home", Icon: HomeIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

export function PhoneTabBar({
  activeTab,
  onSelectTab,
}: {
  /**
   * The tab the current route belongs to, or `null` on a route that is reachable from the tabs
   * but is not one of them (Kanban, Automations, Pull requests, Studio, Plugins). `null` leaves
   * every tab unselected — claiming `aria-current="page"` for Home on those routes would lie to
   * assistive tech about where you are.
   */
  readonly activeTab: PhoneTab | null;
  readonly onSelectTab: (tab: PhoneTab) => void;
}): ReactElement {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-border border-t bg-background pb-safe-b"
      data-testid="phone-tab-bar"
    >
      {PHONE_TABS.map(({ id, label, Icon }) => {
        const selected = id === activeTab;
        return (
          <button
            aria-current={selected ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1",
              PHONE_TAB_BAR_ROW_HEIGHT_CLASS,
              "text-[11px] leading-none transition-colors",
              selected ? "text-foreground" : "text-muted-foreground",
            )}
            data-testid={`phone-tab-${id}`}
            key={id}
            onClick={() => onSelectTab(id)}
            type="button"
          >
            <Icon className="size-5" />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
