import { describe, expect, it } from "vitest";

import type { ComputerResolvedTarget, ComputerUiNode } from "@synara/contracts";

import { MacComputerBackend } from "./MacComputerBackend.ts";
import { ComputerBackendError } from "./ComputerBackend.ts";
import { MacComputerHelperError, type MacHelperTransport } from "./macComputerHelperClient.ts";
import type { ProcessRunResult } from "./macComputerHelperProvisioning.ts";

/** A 1×1 PNG, so `screenshotFromPng` sees real dimensions. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

type ResponseValue = unknown | ((params: Record<string, unknown>) => unknown);

/** A scripted helper transport: records every call and returns/throws per method. */
class FakeMacHelper implements MacHelperTransport {
  running = true;
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];

  constructor(private readonly responses: Record<string, ResponseValue> = {}) {}

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
  options: { readonly run?: () => Promise<ProcessRunResult> } = {},
): MacComputerBackend {
  return new MacComputerBackend({
    platform: "darwin",
    now: () => 0,
    resolveBinary: async () => "/fake/computer-helper",
    makeHelperClient: () => helper,
    run: options.run ?? (async () => XCODE_PRESENT),
  });
}

function windowsResponse(workspace: { x: number; y: number; width: number; height: number }) {
  return {
    windows: [
      {
        id: "5",
        title: "Calculator",
        appId: "com.apple.calculator",
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

  it("translates window bounds out of a negative-origin workspace into agent space", async () => {
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: -100, y: -50, width: 1440, height: 900 }),
    });
    const backend = makeBackend(helper);
    const windows = await backend.listWindows();
    // Global (200,150) minus the workspace origin (-100,-50) → agent (300,200).
    expect(windows[0]?.bounds).toEqual({ x: 300, y: 200, width: 400, height: 500 });
  });

  it("adds the workspace origin back onto pointer coordinates", async () => {
    const helper = new FakeMacHelper({
      "list-windows": windowsResponse({ x: -100, y: -50, width: 1440, height: 900 }),
      click: (params) => ({ x: params.x, y: params.y }),
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
