/** Agent-facing Linux computer perception and control tools. */
import { Effect } from "effect";

import type { ComputerScreenshot, ComputerTarget, ComputerState } from "@synara/contracts";

import { ComputerTargetError } from "../computer/uiTreeTargeting.ts";
import {
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  MAX_COMPUTER_CAPTURE_MAX_DIMENSION,
  MAX_COMPUTER_CLIPBOARD_BYTES,
  type ComputerCaptureRequest,
} from "../computer/ComputerBackend.ts";
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
  // The one read in this set on purpose: the clipboard is the human's, and it
  // can hold something they copied privately — a password manager entry, a
  // token — that is not otherwise visible to the agent. Reading it must never
  // be auto-approved the way perception tools are.
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

export function computerToolRequiresApproval(name: string): boolean {
  return COMPUTER_APPROVAL_REQUIRED_TOOLS.has(name);
}

export interface AgentGatewayComputerToolsOptions {
  readonly manager: ComputerManager;
}

/**
 * One wording for the screenshot mapping, shared by every tool that returns an
 * image, so the model transfers the same skill between them.
 */
const SCREENSHOT_MAPPING_NOTE =
  "convert a screenshot pixel to a desktop point with region.x + screenshot_x / scale and region.y + screenshot_y / scale, using the screenshot region and scale returned alongside it";

/**
 * Both clipboard tools must say the same thing about ownership: the desktop has
 * one clipboard and the human is the other party using it.
 */
const SHARED_CLIPBOARD_NOTE =
  "The desktop has a single clipboard shared with the human user, not a private one for the agent.";

const POINTER_COORDINATE_NOTE =
  "Coordinates are global desktop coordinates in logical pixels, the same space as window bounds and the screenshot region mapping. On multi-monitor layouts some coordinate ranges fall outside every monitor, and the display server moves the pointer to the nearest monitor edge instead.";

const TARGET_PROPERTIES = {
  x: { type: "number", description: "Global desktop x coordinate in logical pixels." },
  y: { type: "number", description: "Global desktop y coordinate in logical pixels." },
  label: { type: "string", description: "Accessible label to resolve from a fresh UI snapshot." },
  role: { type: "string", description: "Optional accessible role used to disambiguate a label." },
  window_id: {
    type: "string",
    description:
      "Optional window id from computer_list_windows. With a label it picks which window the label is resolved in. With x/y it scopes the coordinate to that window: the window is raised and input is routed to it even if another window overlaps, and the click is refused if the coordinate is outside the window.",
  },
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

/** Bounded in bytes rather than characters: the backend pipes it to a process. */
function readClipboardText(args: Record<string, unknown>): string {
  const value = readRawRequiredString(args, "text");
  if (Buffer.byteLength(value, "utf8") > MAX_COMPUTER_CLIPBOARD_BYTES) {
    throw new ToolInputError(
      `Argument "text" is longer than the ${MAX_COMPUTER_CLIPBOARD_BYTES} byte clipboard limit.`,
    );
  }
  return value;
}

/**
 * PNG bytes travel as MCP image content, and the mapping metadata travels as
 * the text part, so a model reading either tool's result maps pixels back to
 * desktop coordinates the same way.
 */
function screenshotResult(payload: unknown, bytesBase64: string): McpToolCallResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, 2) },
      { type: "image", data: bytesBase64, mimeType: "image/png" },
    ],
  };
}

function imageStateResult(state: ComputerState): McpToolCallResult {
  const screenshot = state.screenshot;
  if (!screenshot) return mcpToolResultJson(state);
  const { bytesBase64, ...metadata } = screenshot;
  return screenshotResult({ ...state, screenshot: metadata }, bytesBase64);
}

function capturedScreenshotResult(
  computerId: string,
  request: ComputerCaptureRequest,
  screenshot: ComputerScreenshot,
): McpToolCallResult {
  const { bytesBase64, ...metadata } = screenshot;
  return screenshotResult(
    {
      computerId,
      ...(request.kind === "window" ? { windowId: request.windowId } : {}),
      screenshot: metadata,
    },
    bytesBase64,
  );
}

const CAPTURE_REGION_KEYS = ["x", "y", "width", "height"] as const;

/**
 * The two request forms are mutually exclusive on purpose: a window id and a
 * loose rect disagree about what "the region" is, and silently preferring one
 * would hand the model a screenshot it cannot map.
 */
function readCaptureRequest(args: Record<string, unknown>): ComputerCaptureRequest {
  const windowId = readStringArg(args, "window_id") ?? readStringArg(args, "windowId");
  const present = CAPTURE_REGION_KEYS.filter(
    (key) => args[key] !== undefined && args[key] !== null,
  );
  const maxDimension = readCaptureMaxDimension(args);
  const limit = maxDimension === undefined ? {} : { maxDimension };

  if (windowId !== undefined) {
    if (present.length > 0) {
      throw new ToolInputError(
        'Pass either "window_id" or the region arguments "x", "y", "width" and "height", never both.',
      );
    }
    return { kind: "window", windowId, ...limit };
  }
  if (present.length === 0) {
    throw new ToolInputError(
      'Pass either "window_id" from computer_list_windows or all of "x", "y", "width" and "height" in global desktop logical pixels.',
    );
  }
  if (present.length < CAPTURE_REGION_KEYS.length) {
    const missing = CAPTURE_REGION_KEYS.filter((key) => !present.includes(key));
    throw new ToolInputError(
      `A screenshot region needs "x", "y", "width" and "height". Missing: ${missing.join(", ")}.`,
    );
  }
  const region = {
    x: readNumberArg(args, "x")!,
    y: readNumberArg(args, "y")!,
    width: readNumberArg(args, "width")!,
    height: readNumberArg(args, "height")!,
  };
  if (region.width <= 0 || region.height <= 0) {
    throw new ToolInputError('Arguments "width" and "height" must be greater than zero.');
  }
  return { kind: "region", region, ...limit };
}

function readCaptureMaxDimension(args: Record<string, unknown>): number | undefined {
  const value = readNumberArg(args, "max_dimension");
  if (value === undefined) return undefined;
  if (value < 1) throw new ToolInputError('Argument "max_dimension" must be at least 1.');
  return Math.min(MAX_COMPUTER_CAPTURE_MAX_DIMENSION, Math.floor(value));
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
        description:
          "List visible desktop windows and their bounds without touching the pointer. Windows come back topmost-first: stackingIndex is 0 for the topmost window and grows downward, and occludedBy names the overlapping windows stacked above each one. A plain x/y click lands on whatever is topmost at that point, so when the window you want is occluded, pass its id as window_id alongside x/y to scope the click to it. When present, active reports which window the desktop considers activated; apps may silently drop keyboard shortcuts sent to a window that is not active, so if a hotkey had no effect, check this field.",
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
        description: `Read the current desktop state. The screenshot covers the entire desktop workspace across every monitor, scaled down: ${SCREENSHOT_MAPPING_NOTE}. Window bounds and cursor positions in the JSON are already desktop coordinates. Use computer_screenshot when workspace detail is too small to read. Request a screenshot or accessibility text only when needed because both increase payload size.`,
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
        name: "computer_screenshot",
        description: `Zoom into one part of the desktop when detail is too small to read in the downscaled computer_get_state screenshot. Capture either a single window by "window_id" from computer_list_windows, or a rectangle given as "x", "y", "width" and "height" in global desktop logical pixels; pass exactly one of the two forms. The same mapping applies as in computer_get_state: ${SCREENSHOT_MAPPING_NOTE}. The capture is clipped to the desktop workspace, so read the returned region rather than assuming it matches the request.`,
        inputSchema: {
          type: "object",
          properties: {
            window_id: {
              type: "string",
              description:
                "Window id from computer_list_windows. Mutually exclusive with x/y/width/height.",
            },
            x: {
              type: "number",
              description: "Region left edge in global desktop logical pixels.",
            },
            y: { type: "number", description: "Region top edge in global desktop logical pixels." },
            width: { type: "number", description: "Region width in logical pixels." },
            height: { type: "number", description: "Region height in logical pixels." },
            max_dimension: {
              type: "integer",
              minimum: 1,
              maximum: MAX_COMPUTER_CAPTURE_MAX_DIMENSION,
              description: `Longest screenshot side in pixels before downscaling. Defaults to ${DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION}, the same budget computer_get_state spends on the whole workspace.`,
            },
          },
          additionalProperties: false,
        },
        annotations: { title: "Capture computer screenshot", ...READ_ONLY_TOOL_ANNOTATIONS },
      },
      handler: handle("computer_screenshot", async (args) => {
        const request = readCaptureRequest(args);
        return capturedScreenshotResult(
          manager.computerId,
          request,
          await manager.captureScreenshot(request),
        );
      }),
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
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      definition: {
        name: "computer_read_clipboard",
        description: `Read the desktop clipboard as text, returned as "value". ${SHARED_CLIPBOARD_NOTE} It returns whatever was copied last by anyone, so it may hold something the user copied for their own purposes. An empty clipboard returns an empty string; a clipboard holding an image, other non-text content, or more than 16384 characters of text is an error.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        // Not READ_ONLY_TOOL_ANNOTATIONS: providers auto-approve on
        // readOnlyHint, and this read must go through approval — the clipboard
        // can hold something the human copied privately. It mutates nothing,
        // hence destructiveHint stays false.
        annotations: {
          title: "Read computer clipboard",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      handler: handle("computer_read_clipboard", async (_args, context) =>
        manager.readClipboard(context.callerThreadId),
      ),
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
      async (args, context) =>
        manager.launchApp(
          context.callerThreadId,
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
      "computer_write_clipboard",
      "Write computer clipboard",
      `Replace the desktop clipboard with text, then paste it with the target application's own paste command. ${SHARED_CLIPBOARD_NOTE} Writing discards whatever the user had copied, so prefer computer_type_text for short input and use this for text too long or too awkward to type.`,
      {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      async (args, context) =>
        manager.writeClipboard(context.callerThreadId, readClipboardText(args)),
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
