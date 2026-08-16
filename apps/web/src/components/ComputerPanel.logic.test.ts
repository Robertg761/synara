import type { ComputerFrameHeader, ThreadComputerState, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  computerContainRect,
  computerCursorPosition,
  createComputerFrameGateState,
  resolveComputerAvailabilityView,
  shouldSubscribeToComputerStream,
  stepComputerFrameGate,
} from "./ComputerPanel.logic";

const COMPUTER_ID = "desktop";

function header(sequence: number, computerId = COMPUTER_ID): ComputerFrameHeader {
  return {
    computerId,
    sequence,
    timestampMs: 1,
    keyframe: true,
    codecConfig: false,
  };
}

function state(overrides: Partial<ThreadComputerState> = {}): ThreadComputerState {
  return {
    threadId: "thread-1" as ThreadId,
    version: 1,
    computerId: COMPUTER_ID,
    windows: [],
    screenSize: { width: 5120, height: 2520 },
    agentActive: false,
    availability: { kind: "available" },
    lastError: null,
    ...overrides,
  };
}

describe("computer frame gate", () => {
  it("accepts the first frame and rejects frames for another computer", () => {
    const initial = createComputerFrameGateState();
    const wrong = stepComputerFrameGate(initial, header(1, "other"), COMPUTER_ID);
    expect(wrong.action).toBe("ignore");
    expect(wrong.state).toEqual(initial);

    const first = stepComputerFrameGate(initial, header(7), COMPUTER_ID);
    expect(first.action).toBe("decode");
    expect(first.requestResync).toBe(false);
    expect(first.state.lastSequence).toBe(7);
  });

  it("drops duplicates and stale sequence numbers", () => {
    const current = stepComputerFrameGate(createComputerFrameGateState(), header(10), COMPUTER_ID);
    const duplicate = stepComputerFrameGate(current.state, header(10), COMPUTER_ID);
    const stale = stepComputerFrameGate(current.state, header(9), COMPUTER_ID);

    expect(duplicate.action).toBe("drop-stale");
    expect(stale.action).toBe("drop-stale");
    expect(duplicate.requestResync).toBe(false);
    expect(stale.requestResync).toBe(false);
  });

  it("accepts standalone frames after a gap and asks the source to resync", () => {
    const current = stepComputerFrameGate(createComputerFrameGateState(), header(10), COMPUTER_ID);
    const next = stepComputerFrameGate(current.state, header(13), COMPUTER_ID);

    expect(next.action).toBe("decode");
    expect(next.requestResync).toBe(true);
    expect(next.state.lastSequence).toBe(13);
    expect(next.state.droppedSinceResync).toBe(2);
  });

  it("handles uint32 sequence wraparound", () => {
    const current = stepComputerFrameGate(
      createComputerFrameGateState(),
      header(0xffff_fffe),
      COMPUTER_ID,
    );
    const wrapped = stepComputerFrameGate(current.state, header(1), COMPUTER_ID);

    expect(wrapped.action).toBe("decode");
    expect(wrapped.requestResync).toBe(true);
  });
});

describe("computer panel state helpers", () => {
  it("maps availability into ready, checking, and blocked views", () => {
    expect(resolveComputerAvailabilityView(undefined).kind).toBe("checking");
    expect(resolveComputerAvailabilityView({ kind: "available" }).kind).toBe("ready");
    expect(
      resolveComputerAvailabilityView({ kind: "backend-unavailable", message: "KWin is off" }),
    ).toMatchObject({ kind: "blocked", description: "KWin is off" });
  });

  it("subscribes only for a visible live available thread", () => {
    expect(
      shouldSubscribeToComputerStream({
        runtimeMode: "live",
        isVisible: true,
        threadState: state(),
      }),
    ).toBe(true);
    expect(
      shouldSubscribeToComputerStream({
        runtimeMode: "preview",
        isVisible: true,
        threadState: state(),
      }),
    ).toBe(false);
    expect(
      shouldSubscribeToComputerStream({
        runtimeMode: "live",
        isVisible: true,
        threadState: state({ availability: { kind: "backend-unavailable", message: "off" } }),
      }),
    ).toBe(false);
  });

  it("contains a multi-monitor desktop and maps the agent cursor", () => {
    const rect = computerContainRect({
      source: { width: 5120, height: 2520 },
      containerWidth: 800,
      containerHeight: 500,
    });
    expect(rect).toEqual({ left: 0, top: 53.125, width: 800, height: 393.75 });
    expect(
      computerCursorPosition({
        cursor: { x: 2560, y: 1260 },
        screenSize: { width: 5120, height: 2520 },
        containRect: rect,
      }),
    ).toEqual({ left: 400, top: 250 });
  });
});
