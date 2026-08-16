import { describe, expect, it } from "vitest";

import { ComputerBackendError } from "./ComputerBackend.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

describe("FakeComputerBackend", () => {
  it("records the full snapshot and action surface without a display", async () => {
    const backend = new FakeComputerBackend();
    const events: string[] = [];
    backend.onEvent?.((event) => events.push(event.type));

    await backend.availability();
    await backend.listWindows();
    await backend.getScreenSize();
    await backend.getState({ includeScreenshot: true, includeText: true });
    await backend.launchApp("org.example.Editor", ["--new"]);
    await backend.click({ x: 20, y: 20 });
    await backend.doubleClick({ x: 20, y: 20 });
    await backend.rightClick({ x: 20, y: 20 });
    await backend.moveCursor({ x: 20, y: 20 });
    await backend.drag({ x: 20, y: 20 }, { x: 30, y: 30 }, 100);
    await backend.scroll(null, 0, 500);
    await backend.typeText("hello");
    await backend.pressKey("Enter");
    await backend.hotkey(["Control", "L"]);

    expect(backend.calls.map((call) => call.method)).toEqual([
      "availability",
      "listWindows",
      "getScreenSize",
      "getState",
      "listWindows",
      "launchApp",
      "click",
      "doubleClick",
      "rightClick",
      "moveCursor",
      "drag",
      "scroll",
      "typeText",
      "pressKey",
      "hotkey",
    ]);
    expect(events).toContain("windows-changed");
  });

  it("emits deterministic codec-config and keyframe frames and supports failures", async () => {
    const backend = new FakeComputerBackend();
    const frames: Array<{ keyframe: boolean; codecConfig: boolean }> = [];
    await backend.attachStream((frame) => frames.push(frame));
    expect(frames.slice(0, 2)).toEqual([
      expect.objectContaining({ keyframe: true, codecConfig: true }),
      expect.objectContaining({ keyframe: true, codecConfig: false }),
    ]);

    backend.failNext("click", new ComputerBackendError("synthetic click failure"));
    await expect(backend.click({ x: 1, y: 1 })).rejects.toThrow("synthetic click failure");
    await expect(backend.click({ x: 1, y: 1 })).resolves.toEqual({ point: { x: 1, y: 1 } });

    await backend.requestKeyframe?.();
    expect(frames.length).toBe(4);
    await backend.detachStream();
    backend.emitFrame(true, true);
    expect(frames.length).toBe(4);
  });
});
