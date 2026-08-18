import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderKind } from "@synara/contracts";

import { MAX_COMPUTER_CLIPBOARD_BYTES } from "../computer/ComputerBackend.ts";
import { ComputerManager } from "../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../computer/FakeComputerBackend.ts";
import {
  COMPUTER_APPROVAL_REQUIRED_TOOLS,
  computerToolRequiresApproval,
  makeAgentGatewayComputerTools,
} from "./computerTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import type { ToolContext } from "./toolRuntime.ts";

const THREAD = "thread-computer";

function resultJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? JSON.parse(text.text) : undefined;
}

/** A backend that never implemented the optional clipboard methods. */
function withoutClipboard(backend: FakeComputerBackend): FakeComputerBackend {
  return new Proxy(backend, {
    get: (target, property, receiver) =>
      property === "readClipboard" || property === "writeClipboard"
        ? undefined
        : Reflect.get(target, property, receiver),
  });
}

function makeContext(provider: ProviderKind = "claudeAgent", threadId = THREAD): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:computer",
      threadId,
      provider,
      turnId: "turn-computer",
    },
    callerThreadId: threadId,
    callerSessionKey: "gateway-session:computer",
    callerProvider: provider,
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: "turn-computer",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

async function setup(backend = new FakeComputerBackend()) {
  // A zero settle delay: these tests assert on what the post-action capture
  // does, not on how long the desktop is given to repaint.
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  const tools = makeAgentGatewayComputerTools({ manager });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const call = async (
    name: string,
    args: Record<string, unknown>,
    provider?: ProviderKind,
    threadId?: string,
  ): Promise<McpToolCallResult> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return await Effect.runPromise(tool.handler(args, makeContext(provider, threadId)));
  };
  return { backend, manager, tools, byName, call };
}

describe("agent gateway computer tools", () => {
  it("exposes the full Phase 1 surface behind computer:control", async () => {
    const { tools } = await setup();
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "computer_list_windows",
      "computer_get_state",
      "computer_screenshot",
      "computer_get_screen_size",
      "computer_read_clipboard",
      "computer_launch_app",
      "computer_click",
      "computer_double_click",
      "computer_right_click",
      "computer_move_cursor",
      "computer_drag",
      "computer_scroll",
      "computer_type_text",
      "computer_press_key",
      "computer_hotkey",
      "computer_write_clipboard",
      "computer_set_value",
      "computer_perform_action",
    ]);
    expect(tools.every((tool) => tool.requiredCapability === "computer:control")).toBe(true);
    expect(tools.every((tool) => tool.requiresActiveTurn === true)).toBe(true);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS).toEqual(
      new Set([
        "computer_read_clipboard",
        "computer_launch_app",
        "computer_click",
        "computer_double_click",
        "computer_right_click",
        "computer_move_cursor",
        "computer_drag",
        "computer_scroll",
        "computer_type_text",
        "computer_press_key",
        "computer_hotkey",
        "computer_write_clipboard",
        "computer_set_value",
        "computer_perform_action",
      ]),
    );
    for (const name of COMPUTER_APPROVAL_REQUIRED_TOOLS) {
      expect(computerToolRequiresApproval(name)).toBe(true);
      expect(tools.some((tool) => tool.definition.name === name)).toBe(true);
    }
  });

  it("returns perception payloads and preserves screenshot image content", async () => {
    const { call } = await setup();
    const list = await call("computer_list_windows", {});
    expect(list.isError).not.toBe(true);
    const state = await call("computer_get_state", {
      include_screenshot: true,
      include_text: true,
    });
    expect(state.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(state.content.find((entry) => entry.type === "image")).toMatchObject({
      mimeType: "image/png",
    });
    // The model can only turn screenshot pixels into pointer coordinates when
    // the region and scale travel with the image.
    const text = state.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      screenshot: { region: { x: 0, y: 0, width: 1_920, height: 1_080 }, scale: 1 },
    });
  });

  it("describes the screenshot-to-desktop coordinate mapping for the model", async () => {
    const { byName } = await setup();
    expect(byName.get("computer_get_state")?.definition.description).toContain(
      "region.x + screenshot_x / scale",
    );
    // Both perception tools must spell the mapping out identically so the model
    // carries the same skill from the workspace shot to the zoomed one.
    expect(byName.get("computer_screenshot")?.definition.description).toContain(
      "region.x + screenshot_x / scale",
    );
    for (const name of [
      "computer_click",
      "computer_double_click",
      "computer_right_click",
      "computer_move_cursor",
      "computer_drag",
      "computer_scroll",
    ]) {
      expect(byName.get(name)?.definition.description).toContain("global desktop coordinates");
    }
  });

  it("tells the model how to click a window another window covers", async () => {
    const { byName } = await setup();
    const list = byName.get("computer_list_windows")?.definition.description ?? "";
    expect(list).toContain("stackingIndex");
    expect(list).toContain("occludedBy");
    expect(list).toContain("window_id");

    // Every pointer tool takes the same target shape, so the escape hatch has
    // to be described on the shared property rather than in one tool.
    for (const name of ["computer_click", "computer_double_click", "computer_drag"]) {
      const schema = JSON.stringify(byName.get(name)?.definition.inputSchema ?? {});
      expect(schema).toContain("raised and input is routed to it");
    }
  });

  it("zooms into a window and maps the capture back to desktop coordinates", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_screenshot", { window_id: "fake-calculator" });

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(result.content.find((entry) => entry.type === "image")).toMatchObject({
      mimeType: "image/png",
    });
    // The calculator window sits at (1050, 120) and is 420x620 logical pixels,
    // which fits the default budget, so the capture is not downscaled.
    const text = result.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      windowId: "fake-calculator",
      screenshot: {
        mimeType: "image/png",
        width: 420,
        height: 620,
        region: { x: 1_050, y: 120, width: 420, height: 620 },
        scale: 1,
      },
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-calculator",
    });
  });

  it("zooms into a region and reports the downscaled pixel mapping", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_screenshot", {
      x: 1_050,
      y: 120,
      width: 400,
      height: 800,
      max_dimension: 400,
    });

    expect(result.isError).not.toBe(true);
    const text = result.content.find((entry) => entry.type === "text");
    const payload = JSON.parse(text?.type === "text" ? text.text : "{}");
    // 800 logical pixels squeezed into 400 screenshot pixels halves the scale,
    // so screenshot pixel (100, 100) is desktop point (1250, 320).
    expect(payload).toMatchObject({
      screenshot: {
        width: 200,
        height: 400,
        region: { x: 1_050, y: 120, width: 400, height: 800 },
        scale: 0.5,
      },
    });
    expect(payload.windowId).toBeUndefined();
    const { region, scale } = payload.screenshot;
    expect([region.x + 100 / scale, region.y + 100 / scale]).toEqual([1_250, 320]);
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "region",
      region: { x: 1_050, y: 120, width: 400, height: 800 },
      maxDimension: 400,
    });
  });

  it("refuses an ambiguous or incomplete screenshot request without capturing", async () => {
    const { backend, call } = await setup();

    const both = await call("computer_screenshot", { window_id: "fake-calculator", x: 0 });
    expect(both.isError).toBe(true);
    expect(both.content[0]).toMatchObject({ text: expect.stringContaining("never both") });

    const partial = await call("computer_screenshot", { x: 10, y: 20, width: 30 });
    expect(partial.isError).toBe(true);
    expect(partial.content[0]).toMatchObject({ text: expect.stringContaining("height") });

    const empty = await call("computer_screenshot", { x: 10, y: 20, width: 0, height: 30 });
    expect(empty.isError).toBe(true);
    expect(empty.content[0]).toMatchObject({ text: expect.stringContaining("greater than zero") });

    expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
  });

  it("captures the focused window when called without a target", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_screenshot", {});

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    // The fake terminal is the focused window, so an untargeted zoom lands on
    // it and says so, mapping the same way an explicit window capture does.
    const text = result.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      windowId: "fake-terminal",
      screenshot: { region: { x: 40, y: 40, width: 960, height: 720 } },
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-terminal",
    });
  });

  it("surfaces a compositor capture failure as a readable error result", async () => {
    const { backend, call } = await setup();
    backend.failNext(
      "captureScreenshot",
      new Error("org.synara.ComputerUse.Error.CaptureFailed: window not visible"),
    );

    const result = await call("computer_screenshot", { window_id: "fake-calculator" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("window not visible"),
    });
  });

  it("keeps the zoom tool read-only and free of an approval gate", async () => {
    const { backend, byName, call } = await setup();
    expect(computerToolRequiresApproval("computer_screenshot")).toBe(false);
    expect(byName.get("computer_screenshot")?.definition.annotations).toMatchObject({
      readOnlyHint: true,
    });
    // Antigravity has no approval gate, so a read-only tool must still run.
    const result = await call(
      "computer_screenshot",
      { window_id: "fake-calculator" },
      "antigravity",
    );
    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("captureScreenshot")).toHaveLength(1);
  });

  it("passes a clamped pointer landing point back to the caller", async () => {
    const backend = new FakeComputerBackend();
    backend.click = async (point) => ({ point, clampedTo: { x: point.x, y: 1_080 } });
    const { call } = await setup(backend);

    const result = await call("computer_click", { x: 44, y: 44 });
    expect(result.isError).not.toBe(true);
    const entry = result.content[0];
    expect(JSON.parse(entry?.type === "text" ? entry.text : "{}")).toMatchObject({
      point: { x: 44, y: 44 },
      clampedTo: { x: 44, y: 1_080 },
    });
  });

  it("attaches a post-action screenshot of the focused window to action results", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_click", { x: 10, y: 10 });

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    // A bare coordinate names no window, so the capture falls to the focused
    // one, and the metadata says which window the pixels cover.
    const text = result.content.find((entry) => entry.type === "text");
    expect(JSON.parse(text?.type === "text" ? text.text : "{}")).toMatchObject({
      action: "computer_click",
      point: { x: 10, y: 10 },
      screenshot: {
        windowId: "fake-terminal",
        region: { x: 40, y: 40, width: 960, height: 720 },
        scale: 1,
      },
    });
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-terminal",
    });
  });

  it("captures the window a scoped action named rather than the focused one", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_click", {
      x: 1_100,
      y: 200,
      window_id: "fake-calculator",
    });

    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-calculator",
    });
  });

  it("skips the post-action screenshot when the model opts out", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_type_text", { text: "hi", include_screenshot: false });

    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
    expect(backend.callsFor("captureScreenshot")).toHaveLength(0);
  });

  it("keeps a successful action result when the post-action capture fails", async () => {
    const { backend, call } = await setup();
    backend.failNext("captureScreenshot");
    const result = await call("computer_press_key", { key: "enter" });

    // The key press happened; losing the screenshot must not report failure.
    expect(result.isError).not.toBe(true);
    expect(result.content.map((entry) => entry.type)).toEqual(["text"]);
    expect(resultJson(result)).toMatchObject({ action: "computer_press_key" });
  });

  it("tells the model every observed action already carries its screenshot", async () => {
    const { byName } = await setup();
    for (const name of [
      "computer_click",
      "computer_double_click",
      "computer_right_click",
      "computer_move_cursor",
      "computer_drag",
      "computer_scroll",
      "computer_type_text",
      "computer_press_key",
      "computer_hotkey",
      "computer_set_value",
      "computer_perform_action",
    ]) {
      const tool = byName.get(name);
      expect(tool?.definition.description).toContain("screenshot taken after the action settled");
      expect(JSON.stringify(tool?.definition.inputSchema)).toContain("include_screenshot");
    }
    // Launching resolves seconds later and clipboard writes change no pixels,
    // so neither pays for a capture that would only show the previous state.
    for (const name of ["computer_launch_app", "computer_write_clipboard"]) {
      const tool = byName.get(name);
      expect(tool?.definition.description).not.toContain("screenshot taken after");
      expect(JSON.stringify(tool?.definition.inputSchema)).not.toContain("include_screenshot");
    }
  });

  it("resolves semantic actions from a fresh snapshot and reports backend calls", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_click", { label: "Calculate", role: "button" });
    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("click")).toHaveLength(1);
    expect(backend.callsFor("click")[0]?.args[0]).toEqual({ x: 1_180, y: 228 });

    const setValue = await call("computer_set_value", { label: "Display", value: "468" });
    expect(setValue.isError).not.toBe(true);
    expect(backend.callsFor("setValue")).toHaveLength(1);
  });

  it("preserves raw text values, including whitespace and an empty value", async () => {
    const { backend, call } = await setup();

    for (const text of ["  hello  ", " ", "\n"]) {
      const result = await call("computer_type_text", { text });
      expect(result.isError).not.toBe(true);
      expect(backend.callsFor("typeText").at(-1)?.args).toEqual([text]);
    }

    const emptyValue = await call("computer_set_value", { label: "Display", value: "" });
    expect(emptyValue.isError).not.toBe(true);
    expect(backend.callsFor("setValue").at(-1)?.args.at(-1)).toBe("");
  });

  it("treats a camel-case windowId as a scroll target", async () => {
    const backend = new FakeComputerBackend({
      root: {
        role: "window",
        label: "Calculator",
        value: null,
        description: null,
        frame: { x: 100, y: 200, width: 300, height: 400 },
        activationPoint: { x: 250, y: 400 },
        onScreen: true,
        windowId: "w1",
        children: [],
      },
    });
    const { call } = await setup(backend);

    const result = await call("computer_scroll", {
      windowId: "w1",
      delta_x: 10,
      delta_y: -20,
    });

    expect(result.isError).not.toBe(true);
    expect(backend.callsFor("scroll").at(-1)?.args[0]).toEqual({ x: 250, y: 400 });
  });

  it("refuses invalid targets with structured candidate data", async () => {
    const { call } = await setup();
    const result = await call("computer_click", { label: "does not exist" });
    expect(result.isError).toBe(true);
    const text = result.content.find((entry) => entry.type === "text");
    const structured = text && text.type === "text" ? JSON.parse(text.text) : null;
    expect(structured.error.code).toBe("computer_target_not_found");
    expect(structured.error.candidates.length).toBeGreaterThan(0);
  });

  it("round-trips the shared clipboard and starts from an empty one", async () => {
    const { backend, call } = await setup();

    const empty = await call("computer_read_clipboard", {});
    expect(resultJson(empty)).toMatchObject({ action: "computer_read_clipboard", value: "" });

    const write = await call("computer_write_clipboard", { text: "  copied\ntext  " });
    expect(write.isError).not.toBe(true);
    expect(backend.callsFor("writeClipboard").at(-1)?.args).toEqual(["  copied\ntext  "]);

    const read = await call("computer_read_clipboard", {});
    expect(resultJson(read)).toMatchObject({ value: "  copied\ntext  " });
  });

  it("tells the model the clipboard belongs to the user too", async () => {
    const { byName } = await setup();
    for (const name of ["computer_read_clipboard", "computer_write_clipboard"]) {
      expect(byName.get(name)?.definition.description).toContain("shared with the human user");
    }
  });

  it("refuses clipboard text past the byte limit before it reaches the backend", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_write_clipboard", {
      text: "x".repeat(MAX_COMPUTER_CLIPBOARD_BYTES + 1),
    });
    expect(result.isError).toBe(true);
    expect(backend.callsFor("writeClipboard")).toHaveLength(0);
  });

  it("reports clipboard tools as unsupported on a backend without them", async () => {
    const { call } = await setup(withoutClipboard(new FakeComputerBackend()));

    for (const [name, args] of [
      ["computer_read_clipboard", {}],
      ["computer_write_clipboard", { text: "nope" }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError).toBe(true);
      const text = result.content.find((entry) => entry.type === "text");
      expect(text?.type === "text" ? text.text : "").toContain("does not support clipboard access");
    }
  });

  it("refuses action tools for providers without an approval gate", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_click", { x: 10, y: 10 }, "antigravity");
    expect(result.isError).toBe(true);
    expect(backend.callsFor("click")).toHaveLength(0);
  });

  it("keeps the clipboard read behind approval instead of the perception set", async () => {
    const { backend, byName, call } = await setup();

    // Approval-gated on purpose: the clipboard can hold something the human
    // copied privately, so providers must not auto-approve it as read-only.
    expect(byName.get("computer_read_clipboard")?.definition.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });

    const refused = await call("computer_read_clipboard", {}, "antigravity");
    expect(refused.isError).toBe(true);
    expect(backend.callsFor("readClipboard")).toHaveLength(0);
  });

  it("refuses a second thread's actions with a retryable error and keeps its perception", async () => {
    const { backend, call, manager } = await setup();

    // The first action to land owns the desktop; nothing asks for it explicitly.
    const owned = await call("computer_click", { x: 10, y: 10 }, undefined, "thread-a");
    expect(owned.isError).not.toBe(true);

    const blocked = await call("computer_type_text", { text: "hello" }, undefined, "thread-b");
    expect(blocked.isError).toBe(true);
    expect(resultJson(blocked)).toMatchObject({
      error: {
        code: "computer_controlled_by_other_thread",
        retryable: true,
        message: expect.stringContaining("another conversation"),
      },
    });
    // The refusal happens before the backend, so the loser never moves anything.
    expect(backend.callsFor("typeText")).toHaveLength(0);

    // Reading the desktop is never arbitrated: the blocked thread can keep
    // watching, which is what makes "try again later" actionable advice.
    for (const [name, args] of [
      ["computer_list_windows", {}],
      ["computer_get_state", { include_screenshot: true }],
      ["computer_get_screen_size", {}],
      ["computer_screenshot", { x: 0, y: 0, width: 100, height: 100 }],
    ] as const) {
      const perception = await call(name, args, undefined, "thread-b");
      expect(perception.isError).not.toBe(true);
    }

    // Turn end hands the desktop over; the roles then swap.
    await manager.releaseDesktopControl("thread-a");
    const handover = await call("computer_type_text", { text: "hello" }, undefined, "thread-b");
    expect(handover.isError).not.toBe(true);
    const nowBlocked = await call("computer_click", { x: 1, y: 1 }, undefined, "thread-a");
    expect(resultJson(nowBlocked)).toMatchObject({
      error: { code: "computer_controlled_by_other_thread" },
    });
  });
});
