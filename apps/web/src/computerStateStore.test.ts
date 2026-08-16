import type { ThreadComputerState, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { selectThreadComputerState, useComputerStateStore } from "./computerStateStore";

const baseState: ThreadComputerState = {
  threadId: "thread-1" as ThreadId,
  version: 2,
  computerId: "desktop",
  windows: [],
  screenSize: { width: 5120, height: 2520 },
  agentActive: false,
  availability: { kind: "available" },
  lastError: null,
};

describe("computerStateStore", () => {
  it("keeps the newest thread snapshot and exposes its selector", () => {
    useComputerStateStore.getState().clear();
    useComputerStateStore.getState().upsertThreadState(baseState);
    useComputerStateStore
      .getState()
      .upsertThreadState({ ...baseState, version: 1, agentActive: true });

    expect(
      selectThreadComputerState("thread-1" as ThreadId)(useComputerStateStore.getState()),
    ).toEqual(baseState);
  });

  it("applies window changes and records the latest action", () => {
    useComputerStateStore.getState().clear();
    useComputerStateStore.getState().upsertThreadState(baseState);
    const window = {
      id: "window-1",
      title: "Terminal",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      focused: true,
      minimized: false,
      visible: true,
    };
    useComputerStateStore.getState().applyWindowsChanged([window]);
    const action = { type: "computer.action", action: "click", ok: true } as const;
    useComputerStateStore.getState().recordAction(action);

    expect(useComputerStateStore.getState().threadStatesByThreadId["thread-1"]?.windows).toEqual([
      window,
    ]);
    expect(useComputerStateStore.getState().lastAction).toEqual(action);
  });

  it("clears snapshots and action history", () => {
    useComputerStateStore.getState().clear();
    expect(useComputerStateStore.getState().threadStatesByThreadId).toEqual({});
    expect(useComputerStateStore.getState().lastAction).toBeNull();
  });
});
