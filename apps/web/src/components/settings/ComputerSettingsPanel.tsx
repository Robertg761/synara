// FILE: ComputerSettingsPanel.tsx
// Purpose: Own the Computer use settings panel: desktop backend status and computer-control preferences.
// Layer: Settings UI components
// Exports: ComputerSettingsPanel

import {
  COMPUTER_KWIN_BACKEND,
  COMPUTER_RELEASE_CONTROL_HOTKEY,
  type ComputerCapabilities,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import type { AppSettingsBinding } from "~/appSettings";
import { resolveComputerAvailabilityView } from "~/components/ComputerPanel.logic";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import {
  COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS,
  computerStatusQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { SettingResetButton } from "./SettingControls";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionShell,
  SettingsSection,
} from "./SettingsPanelPrimitives";

const BACKEND_DISPLAY_NAMES: Record<string, string> = {
  kwin: "KWin plugin (KDE)",
  portal: "Desktop portals (GNOME / wlroots)",
  fake: "Test backend",
};

/**
 * Ordered to read as a sentence of abilities, most consequential first. The
 * shared-seat flag is deliberately not in this list: it is a warning about how
 * input happens, not an ability, and gets its own line.
 */
const CAPABILITY_LABELS: ReadonlyArray<{
  readonly key: keyof ComputerCapabilities;
  readonly label: string;
}> = [
  { key: "capture", label: "screen capture" },
  { key: "input", label: "input" },
  { key: "windows", label: "window listing" },
  { key: "windowBounds", label: "window geometry" },
  { key: "stacking", label: "stacking order" },
  { key: "activation", label: "window activation" },
  { key: "clipboard", label: "clipboard" },
  { key: "ghostCursor", label: "ghost cursor" },
];

function capabilitySummary(capabilities: ComputerCapabilities): string {
  const enabled = CAPABILITY_LABELS.filter((entry) => capabilities[entry.key]).map(
    (entry) => entry.label,
  );
  return enabled.length > 0 ? enabled.join(", ") : "none";
}

export function ComputerSettingsPanel({
  settings,
  defaults,
  updateSettings,
  active,
}: AppSettingsBinding & { readonly active: boolean }) {
  const statusQuery = useQuery({
    ...computerStatusQueryOptions(),
    enabled: active,
    // Health can flip (reconnecting, consent granted) while the panel is open.
    refetchInterval: active ? COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS : false,
  });

  if (!active) return null;

  const status = statusQuery.data;
  const availabilityView = statusQuery.isError
    ? {
        kind: "blocked" as const,
        title: "Computer status is unavailable",
        description:
          statusQuery.error instanceof Error && statusQuery.error.message
            ? statusQuery.error.message
            : "The server could not be reached.",
      }
    : resolveComputerAvailabilityView(status?.availability, status?.health);
  const backend =
    status?.availability.kind === "available" ? (status.availability.backend ?? null) : null;
  const health = status?.health;
  // The emergency release is a shortcut the KWin plugin registers with the
  // compositor. No other backend binds it, and a nested offscreen session never
  // hears the human's keys, so only the visible KWin desktop may promise it.
  const dedicatedSeatDescription =
    backend === COMPUTER_KWIN_BACKEND && status?.capabilities.visibleDesktop === true
      ? `The agent drives its own seat, so your cursor and focus stay untouched. Press ${COMPUTER_RELEASE_CONTROL_HOTKEY} at any time to stop it from acting on the desktop, and press it again to let it resume.`
      : "The agent drives its own seat, so your cursor and focus stay untouched.";
  const healthNotes = [
    ...(health?.status === "awaiting-consent"
      ? ["Waiting for you to answer the desktop's permission dialog."]
      : []),
    ...(health && health.reconnects > 0
      ? [
          `Reconnected ${health.reconnects === 1 ? "once" : `${health.reconnects} times`} since startup.`,
        ]
      : []),
    ...(health?.lastFailure && availabilityView.kind === "ready"
      ? [`Last failure: ${health.lastFailure.message}`]
      : []),
  ];

  return (
    <div className="space-y-6">
      <SettingsSectionShell
        title="Desktop backend"
        action={
          <Button
            size="xs"
            variant="outline"
            disabled={statusQuery.isFetching}
            onClick={() => void statusQuery.refetch()}
          >
            {statusQuery.isFetching ? "Checking…" : "Refresh"}
          </Button>
        }
      >
        <SettingsCard>
          <SettingsRow
            title={
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    availabilityView.kind === "ready"
                      ? "bg-emerald-500"
                      : availabilityView.kind === "checking"
                        ? "animate-pulse bg-amber-500"
                        : "bg-red-500",
                  )}
                />
                {availabilityView.title}
              </span>
            }
            description={availabilityView.description}
            status={healthNotes.length > 0 ? healthNotes.join(" ") : undefined}
          />
          {backend ? (
            <SettingsRow
              title="Backend"
              description="Which desktop integration serves perception and input."
              control={
                <span className="text-sm text-muted-foreground">
                  {BACKEND_DISPLAY_NAMES[backend] ?? backend}
                </span>
              }
            />
          ) : null}
          {status && availabilityView.kind === "ready" ? (
            <SettingsRow
              title="Capabilities"
              description={
                status.capabilities.sharedSeat
                  ? "The agent shares your seat: the real cursor moves and real focus follows, and it yields whenever you touch the mouse or keyboard."
                  : dedicatedSeatDescription
              }
              status={capabilitySummary(status.capabilities)}
            />
          ) : null}
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSection title="Computer pane">
        <SettingsRow
          title="Open automatically"
          description="Open the Computer pane the first time an agent acts on the desktop in a chat. Closing the pane keeps it closed for the rest of that chat's run."
          resetAction={
            settings.autoOpenComputerPane !== defaults.autoOpenComputerPane ? (
              <SettingResetButton
                label="open automatically"
                onClick={() =>
                  updateSettings({ autoOpenComputerPane: defaults.autoOpenComputerPane })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenComputerPane}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenComputerPane: Boolean(checked) })
              }
              aria-label="Open the Computer pane automatically when an agent drives the desktop"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Per-chat control">
        <SettingsRow
          title="Start new chats with computer control"
          description="New chats follow your last choice: flipping Computer control in a chat's mode menu also updates this default. Each chat can still be switched individually."
          resetAction={
            settings.enableComputerControlForNewChats !==
            defaults.enableComputerControlForNewChats ? (
              <SettingResetButton
                label="start new chats with computer control"
                onClick={() =>
                  updateSettings({
                    enableComputerControlForNewChats: defaults.enableComputerControlForNewChats,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableComputerControlForNewChats}
              onCheckedChange={(checked) =>
                updateSettings({ enableComputerControlForNewChats: Boolean(checked) })
              }
              aria-label="Start new chats with computer control enabled"
            />
          }
        />
        <SettingsRow
          title="Enabling computer control"
          description="Switch computer control per chat from the composer's mode menu (the Full access picker); the mode button shows a monitor icon while it is on. Desktop actions then ask for approval as they run, and clipboard reads always ask."
        />
      </SettingsSection>
    </div>
  );
}
