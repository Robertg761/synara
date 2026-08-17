import type { ThreadComputerState, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  selectThreadComputerAction,
  selectThreadComputerState,
  useComputerStateStore,
} from "./computerStateStore";

const baseState: ThreadComputerState = {
  threadId: "thread-1" as ThreadId,
  version: 2,
  computerId: "desktop",
  windows: [],
  screenSize: { width: 5120, height: 2520 },
  agentActive: false,
  controlledByOtherThread: false,
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

  it("attributes an action to its thread and leaves other threads untouched", () => {
    useComputerStateStore.getState().clear();
    const typed = {
      type: "computer.action",
      action: "computer_type_text",
      ok: true,
      threadId: "thread-1" as ThreadId,
    } as const;
    const paneClick = { type: "computer.action", action: "computer_click", ok: true } as const;

    useComputerStateStore.getState().recordAction(typed);
    useComputerStateStore.getState().recordAction(paneClick);

    expect(
      selectThreadComputerAction("thread-1" as ThreadId)(useComputerStateStore.getState()),
    ).toBe(typed);
    expect(
      selectThreadComputerAction("thread-2" as ThreadId)(useComputerStateStore.getState()),
    ).toBeUndefined();
    // Unattributed pane input still moves the global cursor of activity.
    expect(useComputerStateStore.getState().lastAction).toBe(paneClick);
  });

  it("forgets a removed thread's action along with its snapshot", () => {
    useComputerStateStore.getState().clear();
    useComputerStateStore.getState().upsertThreadState(baseState);
    useComputerStateStore.getState().recordAction({
      type: "computer.action",
      action: "computer_click",
      ok: true,
      threadId: "thread-1" as ThreadId,
    });

    useComputerStateStore.getState().removeThreadState("thread-1" as ThreadId);

    expect(
      selectThreadComputerAction("thread-1" as ThreadId)(useComputerStateStore.getState()),
    ).toBeUndefined();
    expect(useComputerStateStore.getState().threadStatesByThreadId["thread-1"]).toBeUndefined();
  });

  it("clears snapshots and action history", () => {
    useComputerStateStore.getState().clear();
    expect(useComputerStateStore.getState().threadStatesByThreadId).toEqual({});
    expect(useComputerStateStore.getState().lastAction).toBeNull();
    expect(useComputerStateStore.getState().lastActionByThreadId).toEqual({});
  });
});
