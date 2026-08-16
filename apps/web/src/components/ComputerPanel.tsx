import type { ComputerScreenSize, ThreadId } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useThreadComputerStateSeed } from "~/hooks/useThreadComputerStateSeed";
import type { DockPaneRuntimeMode } from "~/lib/dockPaneActivation";
import { LoaderCircleIcon, MonitorIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { selectThreadComputerState, useComputerStateStore } from "../computerStateStore";
import {
  computerContainRect,
  computerCursorPosition,
  resolveComputerAvailabilityView,
  shouldSubscribeToComputerStream,
} from "./ComputerPanel.logic";
import { useComputerImageStream } from "./computer/useComputerImageStream";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Button } from "./ui/button";

export default function ComputerPanel(props: {
  mode: DiffPanelMode;
  threadId: ThreadId;
  runtimeMode: DockPaneRuntimeMode;
  isVisible: boolean;
  onClosePanel: () => void;
  onRequestLive?: () => void;
}) {
  const { threadId, runtimeMode, isVisible } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const threadState = useComputerStateStore(selectThreadComputerState(threadId));
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  useThreadComputerStateSeed(threadId);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const availabilityView = resolveComputerAvailabilityView(threadState?.availability);
  const streamEnabled = shouldSubscribeToComputerStream({
    runtimeMode,
    isVisible,
    threadState,
  });
  const { status: streamStatus, dimensions } = useComputerImageStream({
    canvasRef,
    computerId: streamEnabled && threadState ? threadState.computerId : null,
    enabled: streamEnabled,
  });

  const screenSize: ComputerScreenSize | undefined =
    threadState?.screenSize ?? dimensions ?? undefined;
  const containRect = useMemo(
    () =>
      screenSize
        ? computerContainRect({
            source: screenSize,
            containerWidth: viewportSize.width,
            containerHeight: viewportSize.height,
          })
        : null,
    [screenSize, viewportSize.height, viewportSize.width],
  );
  const cursorPosition = computerCursorPosition({
    cursor: threadState?.cursor,
    screenSize,
    containRect,
  });

  const header = (
    <div className="flex h-full w-full min-w-0 items-center gap-2">
      <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium text-xs">Computer</span>
      {threadState?.agentActive ? (
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
          <span className="size-1.5 animate-pulse rounded-full bg-current" />
          Agent controlling
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={props.onClosePanel}
          title="Close"
          aria-label="Close computer panel"
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );

  return (
    <DiffPanelShell mode={props.mode} header={header}>
      <div
        ref={viewportRef}
        className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-black/90"
      >
        {availabilityView.kind === "blocked" || availabilityView.kind === "checking" ? (
          <ComputerAvailabilityMessage
            title={availabilityView.title}
            description={availabilityView.description}
          />
        ) : runtimeMode === "preview" ? (
          <button
            type="button"
            className="rounded-full bg-white/95 px-3 py-1.5 font-medium text-[10px] text-black shadow-sm"
            onClick={props.onRequestLive}
          >
            Show the live computer
          </button>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              aria-label="Linux desktop"
              className="absolute inset-0 h-full w-full object-contain"
            />
            {streamStatus.kind !== "streaming" ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center">
                <ComputerStreamStatus status={streamStatus} />
              </div>
            ) : null}
            {cursorPosition ? (
              <span
                aria-label="Agent cursor"
                className={cn(
                  "pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-blue-500 shadow-[0_0_0_1px_rgba(0,0,0,0.7)]",
                  threadState?.agentActive ? "opacity-100" : "opacity-65",
                )}
                style={{ left: cursorPosition.left, top: cursorPosition.top }}
              />
            ) : null}
          </>
        )}
      </div>
      <p
        role="status"
        className={cn(
          "line-clamp-2 flex shrink-0 items-center px-3 text-destructive text-xs transition-opacity duration-220 motion-reduce:transition-none",
          threadState?.lastError
            ? "border-border border-t opacity-100"
            : "border-transparent border-t opacity-0",
        )}
        style={{ height: "1.875rem" }}
      >
        {threadState?.lastError ?? ""}
      </p>
    </DiffPanelShell>
  );
}

function ComputerAvailabilityMessage(props: { title: string; description: string }) {
  return (
    <div className="max-w-sm px-6 text-center text-white/80" role="status">
      <MonitorIcon className="mx-auto mb-3 size-8 text-white/45" />
      <p className="font-medium text-sm text-white">{props.title}</p>
      <p className="mt-1 text-xs leading-5 text-white/60">{props.description}</p>
    </div>
  );
}

function ComputerStreamStatus(props: {
  status: ReturnType<typeof useComputerImageStream>["status"];
}) {
  if (props.status.kind === "connecting") {
    return (
      <span className="flex items-center gap-2 text-xs text-white/65" role="status">
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        Connecting to the desktop…
      </span>
    );
  }
  if (props.status.kind === "unsupported") {
    return (
      <span className="text-xs text-white/65">This browser cannot decode desktop frames.</span>
    );
  }
  if (props.status.kind === "error") {
    return <span className="max-w-xs text-xs text-white/70">{props.status.message}</span>;
  }
  return null;
}
