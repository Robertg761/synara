import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderKind } from "@synara/contracts";

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

function makeContext(provider: ProviderKind = "claudeAgent"): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:computer",
      threadId: THREAD,
      provider,
      turnId: "turn-computer",
    },
    callerThreadId: THREAD,
    callerSessionKey: "gateway-session:computer",
    callerProvider: provider,
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: "turn-computer",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

async function setup(backend = new FakeComputerBackend()) {
  const manager = new ComputerManager({ backend });
  const tools = makeAgentGatewayComputerTools({ manager });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const call = async (
    name: string,
    args: Record<string, unknown>,
    provider?: ProviderKind,
  ): Promise<McpToolCallResult> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return await Effect.runPromise(tool.handler(args, makeContext(provider)));
  };
  return { backend, manager, tools, byName, call };
}

describe("agent gateway computer tools", () => {
  it("exposes the full Phase 1 surface behind computer:control", async () => {
    const { tools } = await setup();
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "computer_list_windows",
      "computer_get_state",
      "computer_get_screen_size",
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
      "computer_set_value",
      "computer_perform_action",
    ]);
    expect(tools.every((tool) => tool.requiredCapability === "computer:control")).toBe(true);
    expect(tools.every((tool) => tool.requiresActiveTurn === true)).toBe(true);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS).toEqual(
      new Set([
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

  it("refuses action tools for providers without an approval gate", async () => {
    const { backend, call } = await setup();
    const result = await call("computer_click", { x: 10, y: 10 }, "antigravity");
    expect(result.isError).toBe(true);
    expect(backend.callsFor("click")).toHaveLength(0);
  });
});
