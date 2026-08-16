/** Agent-facing Linux computer perception and control tools. */
import { Effect } from "effect";

import type { ComputerTarget, ComputerState } from "@synara/contracts";

import { ComputerTargetError } from "../computer/uiTreeTargeting.ts";
import { ComputerManager } from "../computer/ComputerManager.ts";
import { mcpToolResultError, mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import {
  ToolInputError,
  errorText,
  readBooleanArg,
  readNumberArg,
  readRecordArg,
  readStringArg,
  readStringArrayArg,
} from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

export const COMPUTER_CONTROL_CAPABILITY = "computer:control" as const;

const PROVIDERS_WITHOUT_APPROVAL_GATE = new Set(["antigravity"]);

export const COMPUTER_APPROVAL_REQUIRED_TOOLS = new Set([
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

export function computerToolRequiresApproval(name: string): boolean {
  return COMPUTER_APPROVAL_REQUIRED_TOOLS.has(name);
}

export interface AgentGatewayComputerToolsOptions {
  readonly manager: ComputerManager;
}

const POINTER_COORDINATE_NOTE =
  "Coordinates are global desktop coordinates in logical pixels, the same space as window bounds and the screenshot region mapping. On multi-monitor layouts some coordinate ranges fall outside every monitor, and the display server moves the pointer to the nearest monitor edge instead.";

const TARGET_PROPERTIES = {
  x: { type: "number", description: "Global desktop x coordinate in logical pixels." },
  y: { type: "number", description: "Global desktop y coordinate in logical pixels." },
  label: { type: "string", description: "Accessible label to resolve from a fresh UI snapshot." },
  role: { type: "string", description: "Optional accessible role used to disambiguate a label." },
  window_id: { type: "string", description: "Optional window id used to disambiguate a label." },
} as const;

function approvalUnavailableResult(name: string): McpToolCallResult {
  return {
    ...mcpToolResultJson({
      error: {
        code: "ComputerApprovalRequired",
        message: `${name} requires explicit user approval, and this provider session has no approval gate. The action was refused before it ran.`,
      },
    }),
    isError: true,
  };
}

function targetErrorResult(error: ComputerTargetError): McpToolCallResult {
  return {
    ...mcpToolResultJson({
      error: {
        code: error.code,
        message: error.message,
        notFound: error.notFound,
        candidates: error.candidates,
      },
    }),
    isError: true,
  };
}

function readTarget(args: Record<string, unknown>): ComputerTarget {
  return readTargetRecord(args);
}

function readTargetRecord(args: Record<string, unknown>): ComputerTarget {
  const x = readNumberArg(args, "x");
  const y = readNumberArg(args, "y");
  const label = readStringArg(args, "label");
  const role = readStringArg(args, "role");
  const windowId = readStringArg(args, "window_id") ?? readStringArg(args, "windowId");
  return {
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(windowId !== undefined ? { windowId } : {}),
  };
}

function readNestedTarget(args: Record<string, unknown>, name: string): ComputerTarget {
  const value = readRecordArg(args, name);
  if (!value) throw new ToolInputError(`Missing required argument "${name}".`);
  return readTargetRecord(value);
}

function readDelta(args: Record<string, unknown>, name: string): number {
  const value = readNumberArg(args, name);
  if (value === undefined) throw new ToolInputError(`Missing required argument "${name}".`);
  return value;
}

function readRawRequiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new ToolInputError(`Argument "${name}" must be a string.`);
  return value;
}

function readRequiredText(args: Record<string, unknown>): string {
  const value = readRawRequiredString(args, "text");
  if (value.length > 16 * 1024) throw new ToolInputError('Argument "text" is too long.');
  return value;
}

function imageStateResult(state: ComputerState): McpToolCallResult {
  const screenshot = state.screenshot;
  if (!screenshot) return mcpToolResultJson(state);
  const { bytesBase64, ...metadata } = screenshot;
  const result = { ...state, screenshot: metadata };
  return {
    ...mcpToolResultJson(result),
    content: [
      { type: "text", text: JSON.stringify(result, null, 2) },
      { type: "image", data: bytesBase64, mimeType: "image/png" },
    ],
  };
}

function isToolResult(value: unknown): value is McpToolCallResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function makeAgentGatewayComputerTools(
  options: AgentGatewayComputerToolsOptions,
): ReadonlyArray<ToolEntry> {
  const { manager } = options;
  const handle =
    (
      name: string,
      run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
    ) =>
    (args: Record<string, unknown>, context: ToolContext) =>
      Effect.tryPromise({
        try: async () => {
          if (
            computerToolRequiresApproval(name) &&
            PROVIDERS_WITHOUT_APPROVAL_GATE.has(context.callerProvider)
          ) {
            return approvalUnavailableResult(name);
          }
          const value = await manager.withAgentActivity(context.callerThreadId, () =>
            run(args, context),
          );
          return isToolResult(value) ? value : mcpToolResultJson(value);
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            error instanceof ComputerTargetError
              ? targetErrorResult(error)
              : mcpToolResultError(errorText(error)),
          ),
        ),
      );

  const actionEntry = (
    name: string,
    title: string,
    description: string,
    inputSchema: Record<string, unknown>,
    run: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>,
  ): ToolEntry => ({
    requiredCapability: COMPUTER_CONTROL_CAPABILITY,
    requiresActiveTurn: true,
    definition: {
      name,
      description,
      inputSchema,
      annotations: { title, ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: handle(name, run),
  });

  const targetSchema = {
    type: "object",
    properties: TARGET_PROPERTIES,
    additionalProperties: false,
  } as const;

  return [
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_list_windows",
        description: "List visible desktop windows and their bounds without touching the pointer.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { title: "List computer windows", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_list_windows", async () => manager.listWindows()),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_get_state",
        description:
          "Read the current desktop state. The screenshot covers the entire desktop workspace across every monitor, scaled down: convert a screenshot pixel to a desktop point with region.x + screenshot_x / scale and region.y + screenshot_y / scale, using the screenshot region and scale returned alongside it. Window bounds and cursor positions in the JSON are already desktop coordinates. Request a screenshot or accessibility text only when needed because both increase payload size.",
        inputSchema: {
          type: "object",
          properties: {
            include_screenshot: { type: "boolean" },
            include_text: { type: "boolean" },
          },
          additionalProperties: false,
        },
        annotations: { title: "Get computer state", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_get_state", async (args) =>
        imageStateResult(
          await manager.getState({
            includeScreenshot: readBooleanArg(args, "include_screenshot") ?? false,
            includeText: readBooleanArg(args, "include_text") ?? false,
          }),
        ),
      ),
    },
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_get_screen_size",
        description: "Read the logical screen dimensions used for coordinate targeting.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { title: "Get screen size", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_get_screen_size", async () => manager.getScreenSize()),
    },
    actionEntry(
      "computer_launch_app",
      "Launch computer app",
      "Launch an application by command or desktop app identifier.",
      {
        type: "object",
        properties: {
          app: { type: "string" },
          arguments: { type: "array", items: { type: "string" } },
        },
        required: ["app"],
        additionalProperties: false,
      },
      async (args) =>
        manager.launchApp(
          readStringArg(args, "app", { required: true })!,
          readStringArrayArg(args, "arguments") ?? [],
        ),
    ),
    actionEntry(
      "computer_click",
      "Click",
      `Click a coordinate or a uniquely labelled visible control. Ambiguous and off-screen targets are refused. ${POINTER_COORDINATE_NOTE}`,
      targetSchema,
      async (args, context) => manager.click(context.callerThreadId, readTarget(args)),
    ),
    actionEntry(
      "computer_double_click",
      "Double click",
      `Double-click a coordinate or a uniquely labelled visible control. ${POINTER_COORDINATE_NOTE}`,
      targetSchema,
      async (args, context) => manager.doubleClick(context.callerThreadId, readTarget(args)),
    ),
    actionEntry(
      "computer_right_click",
      "Right click",
      `Right-click a coordinate or a uniquely labelled visible control. ${POINTER_COORDINATE_NOTE}`,
      targetSchema,
      async (args, context) => manager.rightClick(context.callerThreadId, readTarget(args)),
    ),
    actionEntry(
      "computer_move_cursor",
      "Move cursor",
      `Move the dedicated computer-use cursor to a coordinate or uniquely labelled visible control. ${POINTER_COORDINATE_NOTE}`,
      targetSchema,
      async (args, context) => manager.moveCursor(context.callerThreadId, readTarget(args)),
    ),
    actionEntry(
      "computer_drag",
      "Drag",
      `Drag between two coordinates or uniquely labelled visible controls. ${POINTER_COORDINATE_NOTE}`,
      {
        type: "object",
        properties: {
          from: targetSchema,
          to: targetSchema,
          duration_ms: { type: "integer", minimum: 0, maximum: 30_000 },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.drag(
          context.callerThreadId,
          readNestedTarget(args, "from"),
          readNestedTarget(args, "to"),
          readNumberArg(args, "duration_ms") ?? 250,
        ),
    ),
    actionEntry(
      "computer_scroll",
      "Scroll",
      `Scroll at an optional target. The target is resolved before the gesture and is never guessed. ${POINTER_COORDINATE_NOTE}`,
      {
        type: "object",
        properties: {
          ...TARGET_PROPERTIES,
          delta_x: { type: "number" },
          delta_y: { type: "number" },
        },
        required: ["delta_x", "delta_y"],
        additionalProperties: false,
      },
      async (args, context) => {
        const target = Object.keys(args).some((key) =>
          ["x", "y", "label", "role", "window_id", "windowId"].includes(key),
        )
          ? readTarget(args)
          : null;
        return manager.scroll(
          context.callerThreadId,
          target,
          readDelta(args, "delta_x"),
          readDelta(args, "delta_y"),
        );
      },
    ),
    actionEntry(
      "computer_type_text",
      "Type text",
      "Type text into the currently focused desktop control.",
      {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      async (_args, _context) => manager.typeText(_context.callerThreadId, readRequiredText(_args)),
    ),
    actionEntry(
      "computer_press_key",
      "Press key",
      "Press one keyboard key on the computer-use seat.",
      {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.pressKey(context.callerThreadId, readStringArg(args, "key", { required: true })!),
    ),
    actionEntry(
      "computer_hotkey",
      "Press hotkey",
      "Press a keyboard shortcut as an ordered key sequence.",
      {
        type: "object",
        properties: {
          keys: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 16 },
        },
        required: ["keys"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.hotkey(
          context.callerThreadId,
          readStringArrayArg(args, "keys") ??
            (() => {
              throw new ToolInputError('Missing required argument "keys".');
            })(),
        ),
    ),
    actionEntry(
      "computer_set_value",
      "Set computer value",
      "Set the value of a uniquely labelled accessible control after a fresh snapshot.",
      {
        type: "object",
        properties: { ...TARGET_PROPERTIES, value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.setValue(
          context.callerThreadId,
          readTarget(args),
          readRawRequiredString(args, "value"),
        ),
    ),
    actionEntry(
      "computer_perform_action",
      "Perform computer action",
      "Perform a named semantic action on a uniquely labelled accessible control.",
      {
        type: "object",
        properties: { ...TARGET_PROPERTIES, action: { type: "string" } },
        required: ["action"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.performAction(
          context.callerThreadId,
          readTarget(args),
          readStringArg(args, "action", { required: true })!,
        ),
    ),
  ];
}
