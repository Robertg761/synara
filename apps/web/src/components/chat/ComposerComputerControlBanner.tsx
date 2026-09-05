// FILE: ComposerComputerControlBanner.tsx
// Purpose: Tell the user, in the chat itself, that an agent is driving the computer they
//          are sitting at — and give them the one control that stops it.
// Layer: Chat composer UI
// Exports: ComposerComputerControlBanner
//
// Only on a backend whose desktop is the visible one. Everywhere else the agent
// has a seat of its own: nothing the user can see moves, the Computer pane opens
// by itself to show the work, and KWin and Hyprland bind an emergency-release
// shortcut the compositor honours. On a shared desktop none of that is true —
// `computerReleaseControlHint` is correctly null because macOS has no such
// global, the pane deliberately never auto-opens, and the only release was the
// end of the turn. So a user could watch their own windows being typed into with
// nothing on screen to explain it and nothing to press.
//
// Truthful about what it is stopping: this ends the agent's turn, which is what
// releases the desktop. It does not undo what has already been done.

import { StopIcon } from "~/lib/icons";
import { Button } from "~/components/ui/button";

export function ComposerComputerControlBanner({
  stopRequested,
  onStop,
}: {
  readonly stopRequested: boolean;
  readonly onStop: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3 sm:px-6">
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none"
        />
        <span className="min-w-0 text-[12px] text-[var(--color-text-foreground-secondary)]">
          <span className="font-medium text-[var(--color-text-foreground)]">
            An agent is controlling this computer.
          </span>{" "}
          It clicks and types without moving your pointer, and may briefly bring a window forward
          before putting yours back.
        </span>
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 gap-1 text-destructive"
        disabled={stopRequested}
        onClick={onStop}
        aria-label="Stop the agent controlling this computer"
      >
        <StopIcon className="size-3" />
        {stopRequested ? "Stopping…" : "Stop"}
      </Button>
    </div>
  );
}
