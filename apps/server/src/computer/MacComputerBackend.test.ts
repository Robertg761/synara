import { describe, expect, it, vi } from "vitest";

import type { ComputerUiNode } from "@synara/contracts";

import { MacComputerBackend } from "./MacComputerBackend.ts";
import {
  ComputerBackendError,
  type ComputerResolvedTarget,
  type ComputerStreamFrame,
} from "./ComputerBackend.ts";
import { MacComputerHelperError, type MacHelperTransport } from "./macComputerHelperClient.ts";
import type { ProcessRunResult } from "./macComputerHelperProvisioning.ts";

/** A 1×1 PNG, so `screenshotFromPng` sees real dimensions. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
/** A different picture of the same desktop, for the still-frame dedupe. */
const PNG_2X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGP4z8AARAAI/gH/xp559wAAAABJRU5ErkJggg==";
const GRANTED = { screenRecording: true, accessibility: true };

type ResponseValue = unknown | ((params: Record<string, unknown>) => unknown);

/** A scripted helper transport: records every call and returns/throws per method. */
class FakeMacHelper implements MacHelperTransport {
  // Not running until started, like the real client: a double that reports
  // `running` before `start()` cannot catch a backend that forgets to spawn.
  running = false;
  startCount = 0;
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];

  constructor(private readonly responses: Record<string, ResponseValue> = {}) {}

  start(): void {
    this.startCount += 1;
    this.running = true;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    const response = this.responses[method];
    if (typeof response === "function") {
      return (response as (p: Record<string, unknown>) => unknown)(params);
    }
    if (response === undefined) return { ok: true };
    if (response instanceof Error) throw response;
    return response;
  }

  async dispose(): Promise<void> {
    this.running = false;
  }

  callsFor(method: string): Record<string, unknown>[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }
}

const XCODE_PRESENT: ProcessRunResult = {
  code: 0,
  stdout: "Xcode 26.2\nBuild version 17C52\n",
  stderr: "",
};

function makeBackend(
  helper: FakeMacHelper,
  options: {
    readonly run?: () => Promise<ProcessRunResult>;
    readonly stillIntervalMs?: number;
  } = {},
): MacComputerBackend {
  return new MacComputerBackend({
    platform: "darwin",
    now: () => 0,
    resolveBinary: async () => "/fake/computer-helper",
    makeHelperClient: () => helper,
    run: options.run ?? (async () => XCODE_PRESENT),
    ...(options.stillIntervalMs === undefined ? {} : { stillIntervalMs: options.stillIntervalMs }),
  });
}

/**
 * The exact key set `Windows.dictionary` emits (Windows.swift). Spelling this
 * fixture the way the helper actually speaks is the point: an earlier version
 * used the Linux `appId` key, so the backend dropping the macOS `appName` on
 * the floor passed every test.
 */
function windowsResponse(workspace: { x: number; y: number; width: number; height: number }) {
  return {
    windows: [
      {
        id: "5",
        title: "Calculator",
        appName: "Calculator",
        pid: 42,
        bounds: { x: 200, y: 150, width: 400, height: 500 },
        focused: true,
        minimized: false,
        visible: true,
        stackingIndex: 0,
      },
    ],
    workspace,
    focusedWindowId: "5",
  };
}

function resolvedTarget(node: Partial<ComputerUiNode>): ComputerResolvedTarget {
  const fullNode: ComputerUiNode = {
    role: "text-field",
    label: "Field",
    value: null,
    description: null,
    frame: { x: 10, y: 10, width: 100, height: 20 },
    activationPoint: { x: 60, y: 20 },
    onScreen: true,
    windowId: null,
    children: [],
    ...node,
  };
  return { target: {}, point: { x: 60, y: 20 }, node: fullNode };
}

describe("MacComputerBackend", () => {
  it("reports an unsupported platform off macOS without touching the toolchain", async () => {
    let ran = false;
    const backend = new MacComputerBackend({
      platform: "linux",
      run: async () => {
        ran = true;
        return XCODE_PRESENT;
      },
    });
    expect(await backend.probeAvailability()).toEqual({
      kind: "unsupported-platform",
      platform: "linux",
    });
    expect(ran).toBe(false);
  });

  it("passive probe reports available when the Xcode toolchain is present", async () => {
    const backend = makeBackend(new FakeMacHelper());
    expect(await backend.probeAvailability()).toEqual({ kind: "available", backend: "mac" });
  });

  it("passive probe reports unavailable when no toolchain and no cached binary exist", async () => {
    const backend = new MacComputerBackend({
      platform: "darwin",
      run: async () => ({ code: 127, stdout: "", stderr: "xcodebuild: not found" }),
      // Hermetic: with the ambient environment the packaged desktop's
      // SYNARA_COMPUTER_HELPER_BINARY_PATH would satisfy `bundledBinary()` and
      // this would report available on a developer's own machine.
      env: {},
      helperCacheRoot: "/nonexistent/synara-computer-helper-cache",
    });
    const availability = await backend.probeAvailability();
    expect(availability.kind).toBe("backend-unavailable");
  });

  it("establishing availability reads the helper's TCC grants into health", async () => {
    const helper = new FakeMacHelper({
      capabilities: { screenRecording: true, accessibility: true },
    });
    const backend = makeBackend(helper);
    expect(await backend.availability()).toEqual({ kind: "available", backend: "mac" });
    expect(backend.health().captureAvailable).toBe(true);
    expect(backend.health().status).toBe("connected");
  });

  it("provision names the grants still missing after building the helper", async () => {
    const helper = new FakeMacHelper({
      capabilities: { screenRecording: false, accessibility: true },
    });
    const backend = makeBackend(helper);
    const summary = await backend.provision();
    expect(summary).toContain("Screen Recording");
    expect(summary).not.toContain("Accessibility ");
  });

  it("spawns the helper when the backend brings it up", async () => {
    const helper = new FakeMacHelper({ capabilities: GRANTED });
    const backend = makeBackend(helper);

    expect(helper.startCount).toBe(0);
    await backend.availability();

    // The spawn belongs to the connect, not to the first agent action: without
    // it the first click pays the process launch.
    expect(helper.startCount).toBe(1);
    expect(helper.running).toBe(true);
  });

  it("refuses availability while Accessibility is denied", async () => {
    const helper = new FakeMacHelper({
      capabilities: { screenRecording: true, accessibility: false },
    });
    const backend = makeBackend(helper);

    // Without Accessibility every click and keystroke is dropped by
    // WindowServer, so "available" would open a pane onto a desktop nothing
    // could be done to.
    await expect(backend.availability()).resolves.toEqual({
      kind: "backend-unavailable",
      message: expect.stringContaining("Accessibility"),
    });
  });

  it("suppresses screenshots and stream frames until capture is granted", async () => {
    const helper = new FakeMacHelper({
      capabilities: { screenRecording: false, accessibility: true },
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
    });
    const backend = makeBackend(helper);
    await backend.availability();

    const state = await backend.getState({ includeScreenshot: true, includeText: false });
    expect(state.screenshot).toBeUndefined();
    // No capture is even attempted: the grant is known to be missing.
    expect(helper.callsFor("capture")).toEqual([]);

    const frames: unknown[] = [];
    await backend.attachStream(() => frames.push(1));
    expect(frames).toEqual([]);
  });

  it("stops reporting capture health when the helper refuses on permission", async () => {
    const helper = new FakeMacHelper({
      capabilities: GRANTED,
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: new MacComputerHelperError("helper_-32000", "Screen Recording is not granted"),
    });
    const backend = makeBackend(helper);
    await backend.availability();

    await expect(
      backend.captureScreenshot({ kind: "region", region: { x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toBeInstanceOf(ComputerBackendError);

    // The refusal is the live answer about the grant, so a later state read must
    // not try again and must not claim a screenshot it cannot take.
    const state = await backend.getState({ includeScreenshot: true, includeText: false });
    expect(state.screenshot).toBeUndefined();
  });

  it("translates window bounds out of a negative-origin workspace into agent space", async () => {
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: -100, y: -50, width: 1440, height: 900 }),
    });
    const backend = makeBackend(helper);
    const windows = await backend.listWindows();
    // Global (200,150) minus the workspace origin (-100,-50) → agent (300,200).
    expect(windows[0]?.bounds).toEqual({ x: 300, y: 200, width: 400, height: 500 });
    // The owning application survives the parse. An agent told to "click the
    // button in Safari" has only this to tell two same-titled windows apart.
    expect(windows[0]?.appName).toBe("Calculator");
  });

  it("adds the workspace origin back onto pointer coordinates", async () => {
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: -100, y: -50, width: 1440, height: 900 }),
      click: (params: Record<string, unknown>) => ({ x: params.x, y: params.y }),
    });
    const backend = makeBackend(helper);
    await backend.listWindows(); // establishes the origin
    const result = await backend.click({ x: 10, y: 20 });
    expect(helper.callsFor("click")[0]).toEqual({ x: -90, y: -30 });
    expect(result).toEqual({ point: { x: 10, y: 20 } });
  });

  it("reports a clamp when the helper lands the pointer elsewhere", async () => {
    const helper = new FakeMacHelper({
      click: () => ({ x: 500, y: 20 }),
    });
    const backend = makeBackend(helper);
    const result = await backend.click({ x: 10, y: 20 });
    expect(result).toEqual({ point: { x: 10, y: 20 }, clampedTo: { x: 500, y: 20 } });
  });

  it("captures a window and maps its region back into agent space", async () => {
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: () => ({ base64: PNG_1X1, region: { x: 200, y: 150, width: 400, height: 500 } }),
    });
    const backend = makeBackend(helper);
    const shot = await backend.captureScreenshot({ kind: "window", windowId: "5" });
    expect(shot.mimeType).toBe("image/png");
    expect(shot.region).toEqual({ x: 200, y: 150, width: 400, height: 500 });
  });

  it("writes a value through the accessibility node path when one is addressable", async () => {
    const helper = new FakeMacHelper({ "set-value": { ok: true } });
    const backend = makeBackend(helper);
    await backend.setValue(resolvedTarget({ windowId: "5", nodePath: [1, 3] }), "hello");
    expect(helper.callsFor("set-value")[0]).toEqual({
      windowId: "5",
      nodePath: [1, 3],
      value: "hello",
    });
    expect(helper.callsFor("click")).toHaveLength(0);
  });

  it("falls back to click-and-type when no node path is addressable", async () => {
    const helper = new FakeMacHelper();
    const backend = makeBackend(helper);
    await backend.setValue(resolvedTarget({ windowId: "5" }), "typed");
    expect(helper.callsFor("set-value")).toHaveLength(0);
    expect(helper.callsFor("click")).toHaveLength(1);
    expect(helper.callsFor("type")[0]).toEqual({ text: "typed" });
  });

  it("passes typed text, keys, and hotkeys straight to the helper", async () => {
    const helper = new FakeMacHelper();
    const backend = makeBackend(helper);
    await backend.typeText("abc");
    await backend.pressKey("enter");
    await backend.hotkey(["cmd", "v"]);
    expect(helper.callsFor("type")[0]).toEqual({ text: "abc" });
    expect(helper.callsFor("press-key")[0]).toEqual({ key: "enter" });
    expect(helper.callsFor("hotkey")[0]).toEqual({ keys: ["cmd", "v"] });
  });

  it("round-trips the shared system clipboard through the helper", async () => {
    const helper = new FakeMacHelper({ "read-clipboard": { text: "copied" } });
    const backend = makeBackend(helper);
    await backend.writeClipboard("out");
    expect(helper.callsFor("write-clipboard")[0]).toEqual({ text: "out" });
    expect(await backend.readClipboard()).toBe("copied");
  });

  it("issues the accessibility walk and the workspace capture together", async () => {
    const issued: string[] = [];
    let bothIssued!: () => void;
    const overlap = new Promise<void>((resolve) => {
      bothIssued = resolve;
    });
    // Each perception call parks until the other has been issued, so a
    // sequential backend never reaches the second one; the race keeps that
    // failure a failed assertion rather than a hung suite.
    // Recorded at the moment the FIRST call is about to return. The timeout is
    // only an escape so a sequential regression fails the assertion instead of
    // hanging the suite — without this flag it *passed* on that escape, because
    // both calls had been issued by the time the assertion below ran.
    let firstCompletionSawBoth: boolean | undefined;
    const arrive = async (method: string): Promise<void> => {
      issued.push(method);
      if (issued.length === 2) bothIssued();
      await Promise.race([
        overlap,
        new Promise<void>((resolve) => {
          setTimeout(resolve, 250).unref?.();
        }),
      ]);
      firstCompletionSawBoth ??= issued.length === 2;
    };
    const helper = new FakeMacHelper({
      capabilities: GRANTED,
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      "describe-ui": async () => {
        await arrive("describe-ui");
        return { root: { role: "desktop", frame: { x: 0, y: 0, width: 1440, height: 900 } } };
      },
      capture: async () => {
        await arrive("capture");
        return { base64: PNG_1X1 };
      },
    });
    const backend = makeBackend(helper);
    await backend.availability();
    const state = await backend.getState({ includeScreenshot: true, includeText: true });
    expect(issued).toHaveLength(2);
    // Both were in flight at once, not merely both eventually issued.
    expect(firstCompletionSawBoth).toBe(true);
    expect(state.root?.role).toBe("desktop");
    expect(state.screenshot?.mimeType).toBe("image/png");
  });

  it("still degrades to windows-only when the concurrent accessibility walk fails", async () => {
    const helper = new FakeMacHelper({
      capabilities: GRANTED,
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      "describe-ui": new MacComputerHelperError("helper_-32000", "Accessibility is not granted"),
      capture: () => ({ base64: PNG_1X1 }),
    });
    const backend = makeBackend(helper);
    await backend.availability();
    const state = await backend.getState({ includeScreenshot: true, includeText: true });
    expect(state.root).toBeUndefined();
    expect(state.windows).toHaveLength(1);
    expect(state.screenshot?.mimeType).toBe("image/png");
  });

  it("republishes a still frame only when the desktop changed, and always on a keyframe", async () => {
    vi.useFakeTimers();
    try {
      let png = PNG_1X1;
      const helper = new FakeMacHelper({
        capabilities: GRANTED,
        "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
        capture: () => ({ base64: png }),
      });
      const backend = makeBackend(helper, { stillIntervalMs: 100 });
      await backend.availability();
      const frames: ComputerStreamFrame[] = [];
      await backend.attachStream((frame) => frames.push(frame));
      expect(frames).toHaveLength(1);

      // The timer keeps pulling captures; identical bytes publish nothing.
      await vi.advanceTimersByTimeAsync(350);
      expect(helper.callsFor("capture").length).toBeGreaterThan(1);
      expect(frames).toHaveLength(1);

      // A receiver with nothing to draw asks for a keyframe, which is published
      // even though the desktop is byte-identical.
      await backend.requestKeyframe();
      expect(frames).toHaveLength(2);

      png = PNG_2X1;
      await vi.advanceTimersByTimeAsync(150);
      expect(frames).toHaveLength(3);
      expect(frames[2]?.data.byteLength).not.toBe(frames[0]?.data.byteLength);

      // A re-attached pane has seen nothing, so its first frame is published.
      await backend.detachStream();
      const reattached: ComputerStreamFrame[] = [];
      await backend.attachStream((frame) => reattached.push(frame));
      expect(reattached).toHaveLength(1);
      await backend.detachStream();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops capture health when a capture is refused for a missing grant", async () => {
    let granted = true;
    const helper = new FakeMacHelper({
      capabilities: () => ({ screenRecording: granted, accessibility: true }),
      "list-windows": windowsResponse({ x: 0, y: 0, width: 1440, height: 900 }),
      capture: () => {
        if (!granted) {
          throw new MacComputerHelperError(
            "helper_-32000",
            "screencapture produced no image; is Screen Recording granted?",
          );
        }
        return { base64: PNG_1X1 };
      },
    });
    const backend = makeBackend(helper);
    const captureHealth: boolean[] = [];
    backend.onEvent((event) => {
      if (event.type === "health-changed") captureHealth.push(event.health.captureAvailable);
    });
    await backend.availability();
    expect(backend.health().captureAvailable).toBe(true);

    granted = false;
    await expect(
      backend.captureScreenshot({
        kind: "region",
        region: { x: 0, y: 0, width: 100, height: 100 },
      }),
    ).rejects.toBeInstanceOf(ComputerBackendError);
    expect(backend.health().captureAvailable).toBe(false);
    expect(captureHealth).toContain(false);

    // The user granted it in System Settings; the next capability read restores it.
    granted = true;
    await backend.availability();
    expect(backend.health().captureAvailable).toBe(true);
  });

  it("turns a helper exit into a retryable error and drops the connection", async () => {
    const helper = new FakeMacHelper({
      "list-windows": new MacComputerHelperError("helper_exited", "computer helper exited"),
    });
    const backend = makeBackend(helper);
    await expect(backend.listWindows()).rejects.toBeInstanceOf(ComputerBackendError);
    expect(helper.running).toBe(false);
    expect(backend.health().status).toBe("unavailable");
  });
});
