import type {
  ComputerAvailability,
  ComputerFrameHeader,
  ComputerPoint,
  ComputerScreenSize,
  ThreadComputerState,
} from "@synara/contracts";

export interface ComputerFrameGateState {
  readonly lastSequence: number | null;
  readonly droppedSinceResync: number;
}

export type ComputerFrameGateAction = "ignore" | "drop-stale" | "decode";

export interface ComputerFrameGateStep {
  readonly state: ComputerFrameGateState;
  readonly action: ComputerFrameGateAction;
  readonly requestResync: boolean;
}

const UINT32_MODULUS = 0x1_0000_0000;
const UINT32_HALF_RANGE = 0x8000_0000;

export function createComputerFrameGateState(): ComputerFrameGateState {
  return { lastSequence: null, droppedSinceResync: 0 };
}

export function resetComputerFrameGate(): ComputerFrameGateState {
  return createComputerFrameGateState();
}

export function stepComputerFrameGate(
  state: ComputerFrameGateState,
  header: Pick<ComputerFrameHeader, "computerId" | "sequence">,
  expectedComputerId: string,
): ComputerFrameGateStep {
  if (header.computerId !== expectedComputerId) {
    return { state, action: "ignore", requestResync: false };
  }

  if (state.lastSequence === null) {
    return {
      state: { lastSequence: header.sequence, droppedSinceResync: 0 },
      action: "decode",
      requestResync: false,
    };
  }

  const distance = (header.sequence - state.lastSequence + UINT32_MODULUS) % UINT32_MODULUS;
  if (distance === 0 || distance >= UINT32_HALF_RANGE) {
    return {
      state: {
        ...state,
        droppedSinceResync: state.droppedSinceResync + 1,
      },
      action: "drop-stale",
      requestResync: false,
    };
  }

  return {
    state: {
      lastSequence: header.sequence,
      droppedSinceResync: distance > 1 ? state.droppedSinceResync + distance - 1 : 0,
    },
    action: "decode",
    requestResync: distance > 1,
  };
}

export type ComputerAvailabilityView =
  | { readonly kind: "checking"; readonly title: string; readonly description: string }
  | { readonly kind: "ready"; readonly title: string; readonly description: string }
  | {
      readonly kind: "blocked";
      readonly title: string;
      readonly description: string;
    };

export function resolveComputerAvailabilityView(
  availability: ComputerAvailability | undefined,
): ComputerAvailabilityView {
  if (!availability) {
    return {
      kind: "checking",
      title: "Checking computer availability",
      description: "Waiting for the Linux desktop capture service.",
    };
  }
  if (availability.kind === "available") {
    return {
      kind: "ready",
      title: "Computer control available",
      description: "The agent can use the desktop through its computer tools.",
    };
  }
  if (availability.kind === "unsupported-platform") {
    return {
      kind: "blocked",
      title: "Computer control is unavailable",
      description: `This server is running on ${availability.platform}. Linux computer control needs Wayland, KWin, and the Synara plugin.`,
    };
  }
  return {
    kind: "blocked",
    title: "Computer control is unavailable",
    description: availability.message,
  };
}

export function shouldSubscribeToComputerStream(input: {
  readonly runtimeMode: "live" | "preview";
  readonly isVisible: boolean;
  readonly threadState: ThreadComputerState | undefined;
}): boolean {
  return (
    input.runtimeMode === "live" &&
    input.isVisible &&
    input.threadState?.availability.kind === "available"
  );
}

export interface ComputerContainRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function computerContainRect(input: {
  readonly source: ComputerScreenSize;
  readonly containerWidth: number;
  readonly containerHeight: number;
}): ComputerContainRect | null {
  if (
    !Number.isFinite(input.containerWidth) ||
    !Number.isFinite(input.containerHeight) ||
    input.containerWidth <= 0 ||
    input.containerHeight <= 0
  ) {
    return null;
  }
  const scale = Math.min(
    input.containerWidth / input.source.width,
    input.containerHeight / input.source.height,
  );
  const width = input.source.width * scale;
  const height = input.source.height * scale;
  return {
    left: (input.containerWidth - width) / 2,
    top: (input.containerHeight - height) / 2,
    width,
    height,
  };
}

export function computerCursorPosition(input: {
  readonly cursor: ComputerPoint | undefined;
  readonly screenSize: ComputerScreenSize | undefined;
  readonly containRect: ComputerContainRect | null;
}): { readonly left: number; readonly top: number } | null {
  if (!input.cursor || !input.screenSize || !input.containRect) {
    return null;
  }
  return {
    left:
      input.containRect.left + (input.cursor.x / input.screenSize.width) * input.containRect.width,
    top:
      input.containRect.top + (input.cursor.y / input.screenSize.height) * input.containRect.height,
  };
}
