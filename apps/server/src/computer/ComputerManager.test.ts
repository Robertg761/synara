import { describe, expect, it } from "vitest";

import type { ThreadComputerState } from "@synara/contracts";
import { decodeComputerFrame } from "@synara/shared/computerFrame";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import type { FrameSink } from "@synara/shared/frameTransport";

class RecordingSink implements FrameSink {
  readonly received: Uint8Array[] = [];
  open = true;

  send = (bytes: Uint8Array): void => {
    this.received.push(bytes);
  };
  bufferedAmount = (): number => 0;
  isOpen = (): boolean => this.open;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("ComputerManager and FakeComputerBackend", () => {
  it("publishes thread snapshots, activity transitions, and backend window events", async () => {
    const backend = new FakeComputerBackend({ now: () => "2026-08-15T00:00:00.000Z" });
    const manager = new ComputerManager({ backend });
    const events: Array<{ type: string; state?: { agentActive: boolean } }> = [];
    manager.onEvent((event) => {
      events.push({
        type: event.type,
        ...("state" in event ? { state: { agentActive: event.state.agentActive } } : {}),
      });
    });

    const initial = await manager.getThreadState("thread-1");
    expect(initial.threadId).toBe("thread-1");
    expect(initial.version).toBe(0);
    expect(initial.windows.map((window) => window.title)).toEqual(["Terminal", "Calculator"]);
    expect(initial.availability).toEqual({ kind: "available", backend: "fake" });

    const result = await manager.withAgentActivity("thread-1", async () => {
      const active = events.findLast((event) => event.type === "computer.thread-state");
      expect(active?.state?.agentActive).toBe(true);
      return await manager.click("thread-1", { label: "Calculate", role: "button" });
    });
    expect(result.point).toEqual({ x: 1_180, y: 228 });
    expect(
      events.filter((event) => event.type === "computer.thread-state").length,
    ).toBeGreaterThanOrEqual(3);
    expect(events.at(-1)?.state?.agentActive).toBe(false);

    const newWindow = {
      id: "fake-notes",
      title: "Notes",
      appName: "org.kde.kwrite",
      bounds: { x: 200, y: 200, width: 500, height: 400 },
      focused: true,
      minimized: false,
      visible: true,
    };
    backend.emitWindowsChanged([newWindow]);
    await Promise.resolve();
    await Promise.resolve();
    const refreshed = await manager.getThreadState("thread-1");
    expect(refreshed.windows).toEqual([newWindow]);
    expect(events.some((event) => event.type === "computer.windows-changed")).toBe(true);

    await manager.dispose();
  });

  it("republishes every thread when backend health changes, without touching the backend", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const states: ThreadComputerState[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.thread-state") states.push(event.state);
    });
    const seeded = await Promise.all([
      manager.getThreadState("thread-a"),
      manager.getThreadState("thread-b"),
    ]);
    expect(seeded.map((state) => state.health.status)).toEqual(["connected", "connected"]);
    const callsBeforeHealth = backend.calls.length;

    backend.emitHealthChanged({
      status: "reconnecting",
      consecutiveFailures: 1,
      reconnects: 0,
      lastFailure: { message: "KWin vanished", at: "2026-08-16T10:00:00.000Z" },
      captureAvailable: false,
    });

    // A supervision event is answered from cache: asking the backend anything
    // here would put a round trip — and a connect attempt — on every failure.
    expect(backend.calls).toHaveLength(callsBeforeHealth);
    const degraded = ["thread-a", "thread-b"].map((threadId) =>
      states.findLast((state) => state.threadId === threadId),
    );
    expect(degraded.map((state) => state?.health.status)).toEqual(["reconnecting", "reconnecting"]);
    expect(degraded.map((state) => state?.availability.kind)).toEqual([
      "backend-unavailable",
      "backend-unavailable",
    ]);
    expect(degraded[0]?.availability).toMatchObject({
      message: expect.stringContaining("KWin vanished"),
    });
    // Panels drop stale snapshots by version, so a live change must move it.
    expect(degraded[0]?.version).toBeGreaterThan(seeded[0]!.version);

    backend.emitHealthChanged({
      status: "connected",
      consecutiveFailures: 0,
      reconnects: 1,
      lastFailure: { message: "KWin vanished", at: "2026-08-16T10:00:00.000Z" },
      captureAvailable: true,
    });

    const recovered = await manager.getThreadState("thread-a");
    expect(recovered.availability).toEqual({ kind: "available", backend: "fake" });
    expect(recovered.health).toMatchObject({ status: "connected", reconnects: 1 });

    await manager.dispose();
  });

  it("performs semantic writes only against a fresh, unambiguous snapshot", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    await expect(manager.setValue("thread-1", { label: "Display" }, "468")).resolves.toMatchObject({
      action: "computer_set_value",
      value: "468",
    });
    await expect(
      manager.performAction("thread-1", { label: "Calculate", role: "button" }, "activate"),
    ).resolves.toMatchObject({ action: "computer_perform_action", point: { x: 1_180, y: 228 } });

    await expect(manager.click("thread-1", { x: 1_920, y: 1_080 })).rejects.toMatchObject({
      code: "computer_target_offscreen",
    });
    await expect(manager.click("thread-1", { x: 10 })).rejects.toMatchObject({
      code: "computer_target_invalid",
    });

    await manager.dispose();
  });

  it("raises a target window before focusing it and scopes a coordinate click to it", async () => {
    // The browser covers the calculator, which is the live failure this
    // targeting exists for: a bare coordinate click lands on the browser.
    const backend = new FakeComputerBackend({
      windows: [
        {
          id: "fake-browser",
          title: "Browser",
          bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
          focused: true,
          minimized: false,
          visible: true,
          stackingIndex: 0,
          occludedBy: [],
        },
        {
          id: "fake-calculator",
          title: "Calculator",
          bounds: { x: 1_050, y: 120, width: 420, height: 620 },
          focused: false,
          minimized: false,
          visible: true,
          stackingIndex: 1,
          occludedBy: ["fake-browser"],
        },
      ],
    });
    const manager = new ComputerManager({ backend });

    await manager.click("thread-1", { label: "Calculate", role: "button" });
    expect(
      backend.calls
        .map((call) => call.method)
        .filter((method) => ["raiseWindow", "focusWindow", "click"].includes(method)),
    ).toEqual(["raiseWindow", "focusWindow", "click"]);
    expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);

    const perceptionCalls = backend.callsFor("getState").length;
    const scoped = await manager.click("thread-1", {
      x: 1_100,
      y: 200,
      windowId: "fake-calculator",
    });
    expect(scoped.point).toEqual({ x: 1_100, y: 200 });
    expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({ x: 1_100, y: 200 });
    // The coordinate is authoritative, so no accessibility tree is read for it.
    expect(backend.callsFor("getState")).toHaveLength(perceptionCalls);

    // A coordinate that misses the window is refused rather than clicked
    // wherever it happens to land.
    await expect(
      manager.click("thread-1", { x: 40, y: 40, windowId: "fake-calculator" }),
    ).rejects.toMatchObject({ code: "computer_target_offscreen" });
    await expect(
      manager.click("thread-1", { x: 40, y: 40, windowId: "gone" }),
    ).rejects.toMatchObject({ code: "computer_target_not_found", notFound: true });

    await manager.dispose();
  });

  it("keeps window targeting working on a backend that cannot raise windows", async () => {
    const backend = new FakeComputerBackend();
    (backend as unknown as { raiseWindow?: undefined }).raiseWindow = undefined;
    const manager = new ComputerManager({ backend });

    await expect(
      manager.click("thread-1", { label: "Calculate", role: "button" }),
    ).resolves.toMatchObject({ point: { x: 1_180, y: 228 } });
    expect(backend.callsFor("raiseWindow")).toHaveLength(0);
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);

    await manager.dispose();
  });

  it("attributes every action event to the thread that drove it", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const actions: Array<{ action: string; threadId?: string }> = [];
    manager.onEvent((event) => {
      if (event.type !== "computer.action") return;
      actions.push({
        action: event.action,
        ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
      });
    });

    await manager.launchApp("thread-1", "kcalc");
    await manager.click("thread-1", { x: 10, y: 10 });
    await manager.doubleClick("thread-1", { x: 10, y: 10 });
    await manager.rightClick("thread-1", { x: 10, y: 10 });
    await manager.moveCursor("thread-1", { x: 10, y: 10 });
    await manager.drag("thread-1", { x: 10, y: 10 }, { x: 20, y: 20 });
    await manager.scroll("thread-1", null, 0, 12);
    await manager.typeText("thread-1", "hi");
    await manager.pressKey("thread-1", "enter");
    await manager.hotkey("thread-1", ["ctrl", "s"]);
    await manager.writeClipboard("thread-1", "clip");
    await manager.readClipboard("thread-1");
    await manager.setValue("thread-1", { label: "Display" }, "12");
    await manager.performAction("thread-1", { label: "Calculate", role: "button" }, "activate");

    expect(actions).toEqual([
      { action: "computer_launch_app", threadId: "thread-1" },
      { action: "computer_click", threadId: "thread-1" },
      { action: "computer_double_click", threadId: "thread-1" },
      { action: "computer_right_click", threadId: "thread-1" },
      { action: "computer_move_cursor", threadId: "thread-1" },
      { action: "computer_drag", threadId: "thread-1" },
      { action: "computer_scroll", threadId: "thread-1" },
      { action: "computer_type_text", threadId: "thread-1" },
      { action: "computer_press_key", threadId: "thread-1" },
      { action: "computer_hotkey", threadId: "thread-1" },
      { action: "computer_write_clipboard", threadId: "thread-1" },
      { action: "computer_read_clipboard", threadId: "thread-1" },
      { action: "computer_set_value", threadId: "thread-1" },
      { action: "computer_perform_action", threadId: "thread-1" },
    ]);

    await manager.dispose();
  });

  it("carries clipboard text on the shared action result, and refuses it without backend support", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    await manager.writeClipboard("thread-1", "shared text");
    await expect(manager.readClipboard("thread-1")).resolves.toMatchObject({
      action: "computer_read_clipboard",
      value: "shared text",
    });

    // Reads are bounded by the contract limit on `value`; writes are not, so a
    // large paste is fine but cannot come back through the result field.
    await manager.writeClipboard("thread-1", "x".repeat(16 * 1024 + 1));
    await expect(manager.readClipboard("thread-1")).rejects.toThrow(/more than the 16384/);

    const withoutClipboard = new ComputerManager({
      backend: new Proxy(new FakeComputerBackend(), {
        get: (target, property, receiver) =>
          property === "readClipboard" || property === "writeClipboard"
            ? undefined
            : Reflect.get(target, property, receiver),
      }),
    });
    await expect(withoutClipboard.readClipboard("thread-1")).rejects.toThrow(
      /does not support clipboard access/,
    );
    await expect(withoutClipboard.writeClipboard("thread-1", "nope")).rejects.toThrow(
      /does not support clipboard access/,
    );

    await manager.dispose();
    await withoutClipboard.dispose();
  });

  it("leaves pane input unattributed instead of borrowing a thread", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const actions: Array<Record<string, unknown>> = [];
    manager.onEvent((event) => {
      if (event.type === "computer.action") actions.push({ ...event });
    });

    await manager.click(undefined, { x: 10, y: 10 });
    await manager.launchApp(undefined, "kcalc");
    // A whitespace-only caller is not a thread either.
    await manager.pressKey("  ", "enter");

    expect(actions.every((action) => !("threadId" in action))).toBe(true);
    expect(actions).toHaveLength(3);

    await manager.dispose();
  });

  it("gives the desktop to the first thread that drives it and refuses the second", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const states: ThreadComputerState[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.thread-state") states.push(event.state);
    });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    await manager.click("thread-a", { x: 10, y: 10 });
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toMatchObject({
      code: "computer_controlled_by_other_thread",
      retryable: true,
      message: expect.stringMatching(/another conversation; try again when it is free/),
    });

    // Watching is safe while someone else drives, so nothing read-only is gated
    // — including the blocked thread's own state.
    await expect(manager.listWindows()).resolves.toMatchObject({ computerId: backend.computerId });
    await expect(manager.getState({})).resolves.toMatchObject({ computerId: backend.computerId });
    await expect(manager.getScreenSize()).resolves.toMatchObject({
      computerId: backend.computerId,
    });
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });
    await expect(manager.getThreadState("thread-a")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });

    // The human at the pane is not a competing agent: their input carries no
    // thread, and it neither waits for the lease nor takes it.
    await expect(manager.click(undefined, { x: 30, y: 30 })).resolves.toMatchObject({
      action: "computer_click",
    });
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toMatchObject({
      code: "computer_controlled_by_other_thread",
    });

    // Both panels learned about the handover without polling.
    expect(
      states.some((state) => state.threadId === "thread-b" && state.controlledByOtherThread),
    ).toBe(true);
    expect(states.findLast((state) => state.threadId === "thread-a")?.controlledByOtherThread).toBe(
      false,
    );

    await manager.dispose();
  });

  it("hands the desktop to the next thread when the owner's turn ends", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    await manager.launchApp("thread-a", "kcalc");
    await expect(manager.typeText("thread-b", "hi")).rejects.toThrow(/another conversation/);

    // What the lease reactor calls on turn.completed / turn.aborted /
    // session.exited.
    await manager.releaseDesktopControl("thread-a");
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });

    await expect(manager.typeText("thread-b", "hi")).resolves.toMatchObject({
      action: "computer_type_text",
    });
    // A's next turn now waits on B, and a release from a thread that no longer
    // owns the desktop cannot take it away from B.
    await expect(manager.click("thread-a", { x: 10, y: 10 })).rejects.toThrow(
      /another conversation/,
    );
    await manager.releaseDesktopControl("thread-a");
    await expect(manager.click("thread-a", { x: 10, y: 10 })).rejects.toThrow(
      /another conversation/,
    );
    await expect(manager.getThreadState("thread-a")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });

    // Removing the owning thread frees the desktop the same way.
    await manager.handleThreadRemoved("thread-b");
    await expect(manager.click("thread-a", { x: 10, y: 10 })).resolves.toMatchObject({
      action: "computer_click",
    });

    await manager.dispose();
  });

  it("expires an idle lease as a backstop, but never one whose owner is still acting", async () => {
    const backend = new FakeComputerBackend();
    let nowMs = 0;
    const manager = new ComputerManager({ backend, now: () => nowMs, leaseIdleMs: 1_000 });
    await manager.getThreadState("thread-a");

    await manager.click("thread-a", { x: 10, y: 10 });
    nowMs = 999;
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toThrow(
      /another conversation/,
    );

    // An owner that is mid-call still holds the pointer, however long ago the
    // call started — the crash this backstop exists for leaves nothing running.
    nowMs = 10_000;
    const started = deferred();
    const finish = deferred();
    const inFlight = manager.withAgentActivity("thread-a", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toThrow(
      /another conversation/,
    );
    finish.resolve();
    await inFlight;

    await expect(manager.click("thread-b", { x: 20, y: 20 })).resolves.toMatchObject({
      action: "computer_click",
    });
    await expect(manager.click("thread-a", { x: 10, y: 10 })).rejects.toThrow(
      /another conversation/,
    );

    await manager.dispose();
  });

  it("lets one thread keep driving across a long think, and keeps perception free", async () => {
    const backend = new FakeComputerBackend();
    let nowMs = 0;
    const manager = new ComputerManager({ backend, now: () => nowMs, leaseIdleMs: 1_000 });

    await manager.click("thread-a", { x: 10, y: 10 });
    // Nobody else asked for the desktop while the model thought, so the owner
    // simply picks it back up: expiry is a chance for others, not a revocation.
    nowMs = 60_000;
    await expect(manager.click("thread-a", { x: 10, y: 10 })).resolves.toMatchObject({
      action: "computer_click",
    });
    // Perception from another thread neither takes the lease nor renews it.
    await manager.getState({});
    await manager.listWindows();
    await expect(manager.click("thread-a", { x: 10, y: 10 })).resolves.toMatchObject({
      action: "computer_click",
    });

    await manager.dispose();
  });

  it("runs the synthetic frame attach, publish, and detach loop", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const sink = new RecordingSink();
    const unsubscribe = manager.subscribeFrames(sink);
    await manager.flushStreamTransitions();

    expect(backend.callsFor("attachStream")).toHaveLength(1);
    expect(sink.received).toHaveLength(2);
    expect(decodeComputerFrame(sink.received[0]!).ok).toBe(true);
    backend.emitFrame(false, false, Uint8Array.of(7, 8));
    expect(sink.received).toHaveLength(3);

    unsubscribe();
    await manager.flushStreamTransitions();
    expect(backend.callsFor("detachStream")).toHaveLength(1);
    const count = sink.received.length;
    backend.emitFrame(true, false);
    expect(sink.received).toHaveLength(count);

    await manager.dispose();
  });

  it("drops late frames and state updates after a thread is removed", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const sink = new RecordingSink();
    const unsubscribe = manager.subscribeFrames(sink);
    await manager.flushStreamTransitions();
    await manager.getThreadState("thread-removed");
    await manager.handleThreadRemoved("thread-removed");

    backend.emitFrame(false, false, Uint8Array.of(9));
    await manager.withAgentActivity("thread-removed", async () => undefined);
    await manager.recordThreadError("thread-removed", "late error");

    const threads = (manager as unknown as { threads: Map<string, unknown> }).threads;
    expect(threads.has("thread-removed")).toBe(false);

    unsubscribe();
    await manager.dispose();
  });

  it("does not reattach a stream after disposal wins during keyframe recovery", async () => {
    const backend = new FakeComputerBackend();
    const detachStarted = deferred();
    const allowDetach = deferred();
    const detachStream = backend.detachStream.bind(backend);
    (backend as unknown as { requestKeyframe?: undefined }).requestKeyframe = undefined;
    backend.detachStream = async () => {
      detachStarted.resolve();
      await allowDetach.promise;
      await detachStream();
    };
    const manager = new ComputerManager({ backend });
    const unsubscribe = manager.subscribeFrames(new RecordingSink());
    await manager.flushStreamTransitions();

    const request = manager.requestKeyframe();
    await detachStarted.promise;
    const disposal = manager.dispose();
    allowDetach.resolve();
    await Promise.all([request, disposal]);

    expect(backend.callsFor("attachStream")).toHaveLength(1);
    expect(backend.callsFor("detachStream")).toHaveLength(1);
    unsubscribe();
  });

  it("carries the backend's capabilities onto every thread snapshot", async () => {
    // The panel decides which controls to offer from this field alone, so a
    // backend that cannot report geometry has to say so in the snapshot rather
    // than let the panel offer window-scoped actions that will be refused.
    const backend = new FakeComputerBackend({
      capabilities: {
        windows: true,
        windowBounds: false,
        stacking: false,
        capture: true,
        input: true,
        clipboard: false,
        activation: false,
        ghostCursor: false,
        sharedSeat: true,
      },
    });
    const manager = new ComputerManager({ backend });

    const state = await manager.getThreadState("thread-1");

    expect(state.capabilities).toEqual(backend.capabilities());
    await manager.dispose();
  });

  it("refuses a window-scoped click when the desktop reports no geometry", async () => {
    // Passing window_id is a request for a guarantee — that the point lands in
    // that window. Without bounds nothing can check it, and clicking anyway
    // would drop the guarantee silently instead of telling the agent to drop
    // the scope or target by label.
    const backend = new FakeComputerBackend({
      windows: [
        {
          id: "boundless",
          title: "Calculator",
          appName: "org.kde.kcalc",
          focused: true,
          minimized: false,
          visible: true,
        },
      ],
    });
    const manager = new ComputerManager({ backend });

    await expect(
      manager.click("thread-1", { x: 100, y: 100, windowId: "boundless" }),
    ).rejects.toMatchObject({ code: "computer_target_offscreen" });
    expect(backend.callsFor("click")).toHaveLength(0);
    await manager.dispose();
  });

  it("returns perception payloads with optional text and screenshot", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const state = await manager.getState({ includeScreenshot: true, includeText: true });

    expect(state.screenshot?.mimeType).toBe("image/png");
    expect(state.screenshot?.bytesBase64.length).toBeGreaterThan(0);
    expect(state.text).toContain("Calculate");
    expect(state.root?.children.length).toBeGreaterThan(0);

    await manager.dispose();
  });
});
