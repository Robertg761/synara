// Phone settings reuse the desktop section list and search without a desktop sidebar.
import { useEffect, useRef, useState } from "react";

import { useLayoutMode } from "~/lib/layoutMode";
import { registerBackDismissable } from "~/lib/mobileBackStack";
import { SETTINGS_NAV_ITEMS, type SettingsSectionId } from "~/settingsNavigation";
import { SettingsSidebarNav } from "../SettingsSidebarNav";
import { Button } from "../ui/button";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";

export function PhoneSettingsNavigation(props: {
  activeSection: SettingsSectionId;
  onBack: () => void;
  onSelectSection: (section: SettingsSectionId, options?: { target?: string }) => void;
}) {
  const phone = useLayoutMode() === "phone";
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!phone || !open) return;
    return registerBackDismissable(() => {
      setOpen(false);
      toggleRef.current?.focus();
      return true;
    });
  }, [phone, open]);
  if (!phone) return null;
  const label = SETTINGS_NAV_ITEMS.find((item) => item.id === props.activeSection)?.label;
  return (
    <div className="mb-6 min-w-0">
      <Button
        ref={toggleRef}
        variant="outline"
        className="h-11 w-full justify-between"
        aria-label="Choose settings section"
        aria-expanded={open}
        aria-controls="phone-settings-navigation"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="truncate">Settings: {label}</span>
        <DisclosureChevron open={open} />
      </Button>
      <DisclosureRegion open={open} contentClassName="pt-2">
        <div id="phone-settings-navigation" className="max-h-[55dvh] overflow-y-auto rounded-xl border border-border p-1 [&_button]:min-h-11">
          <SettingsSidebarNav
            activeSection={props.activeSection}
            onBack={() => { setOpen(false); props.onBack(); }}
            onSelectSection={(section, options) => {
              setOpen(false);
              toggleRef.current?.focus();
              props.onSelectSection(section, options);
            }}
          />
        </div>
      </DisclosureRegion>
    </div>
  );
}
