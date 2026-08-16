import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

// ── WebSocket surface ────────────────────────────────────────────────

export const COMPUTER_WS_METHODS = {
  listWindows: "computer.listWindows",
  getState: "computer.getState",
  getScreenSize: "computer.getScreenSize",
  launchApp: "computer.launchApp",
  click: "computer.click",
  doubleClick: "computer.doubleClick",
  rightClick: "computer.rightClick",
  moveCursor: "computer.moveCursor",
  drag: "computer.drag",
  scroll: "computer.scroll",
  typeText: "computer.typeText",
  pressKey: "computer.pressKey",
  hotkey: "computer.hotkey",
  setValue: "computer.setValue",
  performAction: "computer.performAction",
  getThreadState: "computer.getThreadState",
  subscribeEvents: "computer.subscribeEvents",
} as const;

export const COMPUTER_WS_CHANNELS = {
  event: "computer.event",
} as const;

const COMPUTER_ID_MAX_LENGTH = 128;
const COMPUTER_TEXT_MAX_LENGTH = 16 * 1024;
const COMPUTER_LABEL_MAX_LENGTH = 1_024;
const COMPUTER_MESSAGE_MAX_LENGTH = 2_048;

export const ComputerId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(COMPUTER_ID_MAX_LENGTH),
).check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/));
export type ComputerId = typeof ComputerId.Type;

export const ComputerWindowId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(COMPUTER_ID_MAX_LENGTH),
);
export type ComputerWindowId = typeof ComputerWindowId.Type;

export const ComputerAvailability = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"),
    backend: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  }),
  Schema.Struct({
    kind: Schema.Literal("unsupported-platform"),
    platform: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    kind: Schema.Literal("backend-unavailable"),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(COMPUTER_MESSAGE_MAX_LENGTH)),
  }),
]);
export type ComputerAvailability = typeof ComputerAvailability.Type;

// ── Perception ──────────────────────────────────────────────────────

export const ComputerRect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ComputerRect = typeof ComputerRect.Type;

export const ComputerPoint = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
});
export type ComputerPoint = typeof ComputerPoint.Type;

export const ComputerScreenSize = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32_768 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32_768 })),
  scale: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
});
export type ComputerScreenSize = typeof ComputerScreenSize.Type;

export const ComputerWindow = Schema.Struct({
  id: ComputerWindowId,
  title: Schema.String.check(Schema.isMaxLength(COMPUTER_LABEL_MAX_LENGTH)),
  appName: Schema.optional(Schema.String.check(Schema.isMaxLength(COMPUTER_LABEL_MAX_LENGTH))),
  pid: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  bounds: ComputerRect,
  focused: Schema.Boolean,
  minimized: Schema.Boolean,
  visible: Schema.Boolean,
});
export type ComputerWindow = typeof ComputerWindow.Type;

export const ComputerUiFrame = ComputerRect;
export type ComputerUiFrame = typeof ComputerUiFrame.Type;

export const ComputerUiPoint = ComputerPoint;
export type ComputerUiPoint = typeof ComputerUiPoint.Type;

export interface ComputerUiNode {
  readonly role: string;
  readonly label: string | null;
  readonly value: string | null;
  readonly description: string | null;
  readonly frame: ComputerUiFrame;
  readonly activationPoint: ComputerUiPoint | null;
  readonly onScreen: boolean;
  readonly windowId: ComputerWindowId | null;
  readonly children: readonly ComputerUiNode[];
}

export const ComputerUiNode: Schema.Schema<ComputerUiNode> = Schema.Struct({
  role: Schema.String.check(Schema.isMaxLength(128)),
  label: Schema.NullOr(Schema.String.check(Schema.isMaxLength(COMPUTER_LABEL_MAX_LENGTH))),
  value: Schema.NullOr(Schema.String.check(Schema.isMaxLength(COMPUTER_TEXT_MAX_LENGTH))),
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(COMPUTER_TEXT_MAX_LENGTH))),
  frame: ComputerUiFrame,
  activationPoint: Schema.NullOr(ComputerUiPoint),
  onScreen: Schema.Boolean,
  windowId: Schema.NullOr(ComputerWindowId),
  children: Schema.Array(Schema.suspend((): Schema.Schema<ComputerUiNode> => ComputerUiNode)).check(
    Schema.isMaxLength(2_048),
  ),
});

export const ComputerScreenshot = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32_768 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32_768 })),
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 * 1024 * 1024 })),
  bytesBase64: TrimmedNonEmptyString.check(Schema.isMaxLength(88 * 1024 * 1024)),
  capturedAt: IsoDateTime,
});
export type ComputerScreenshot = typeof ComputerScreenshot.Type;

export const ComputerState = Schema.Struct({
  computerId: ComputerId,
  windows: Schema.Array(ComputerWindow).check(Schema.isMaxLength(512)),
  screenSize: ComputerScreenSize,
  root: Schema.optional(ComputerUiNode),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024))),
  screenshot: Schema.optional(ComputerScreenshot),
  capturedAt: IsoDateTime,
});
export type ComputerState = typeof ComputerState.Type;

export const ThreadComputerState = Schema.Struct({
  threadId: ThreadId,
  version: NonNegativeInt,
  computerId: ComputerId,
  windows: Schema.Array(ComputerWindow).check(Schema.isMaxLength(512)),
  screenSize: ComputerScreenSize,
  cursor: Schema.optional(ComputerPoint),
  agentActive: Schema.Boolean,
  availability: ComputerAvailability,
  lastError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(COMPUTER_MESSAGE_MAX_LENGTH))),
});
export type ThreadComputerState = typeof ThreadComputerState.Type;

export const ComputerListWindowsInput = Schema.Struct({});
export type ComputerListWindowsInput = typeof ComputerListWindowsInput.Type;

export const ComputerListWindowsResult = Schema.Struct({
  computerId: ComputerId,
  windows: Schema.Array(ComputerWindow).check(Schema.isMaxLength(512)),
  availability: ComputerAvailability,
});
export type ComputerListWindowsResult = typeof ComputerListWindowsResult.Type;

export const ComputerGetStateInput = Schema.Struct({
  includeScreenshot: Schema.optional(Schema.Boolean),
  includeText: Schema.optional(Schema.Boolean),
});
export type ComputerGetStateInput = typeof ComputerGetStateInput.Type;

export const ComputerGetScreenSizeInput = Schema.Struct({});
export type ComputerGetScreenSizeInput = typeof ComputerGetScreenSizeInput.Type;

export const ComputerGetScreenSizeResult = Schema.Struct({
  computerId: ComputerId,
  screenSize: ComputerScreenSize,
  availability: ComputerAvailability,
});
export type ComputerGetScreenSizeResult = typeof ComputerGetScreenSizeResult.Type;

export const ComputerThreadInput = Schema.Struct({ threadId: ThreadId });
export type ComputerThreadInput = typeof ComputerThreadInput.Type;

export const ComputerLaunchAppInput = Schema.Struct({
  app: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  arguments: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(4_096))).check(Schema.isMaxLength(128)),
  ),
});
export type ComputerLaunchAppInput = typeof ComputerLaunchAppInput.Type;

export const ComputerLaunchAppResult = Schema.Struct({
  computerId: ComputerId,
  app: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  window: Schema.NullOr(ComputerWindow),
});
export type ComputerLaunchAppResult = typeof ComputerLaunchAppResult.Type;

// ── Action inputs ───────────────────────────────────────────────────

const ComputerTargetFields = {
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  label: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(COMPUTER_LABEL_MAX_LENGTH)),
  ),
  role: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  windowId: Schema.optional(ComputerWindowId),
} as const;

export const ComputerTarget = Schema.Struct(ComputerTargetFields);
export type ComputerTarget = typeof ComputerTarget.Type;

export const ComputerClickInput = ComputerTarget;
export type ComputerClickInput = typeof ComputerClickInput.Type;
export const ComputerDoubleClickInput = ComputerTarget;
export type ComputerDoubleClickInput = typeof ComputerDoubleClickInput.Type;
export const ComputerRightClickInput = ComputerTarget;
export type ComputerRightClickInput = typeof ComputerRightClickInput.Type;
export const ComputerMoveCursorInput = ComputerTarget;
export type ComputerMoveCursorInput = typeof ComputerMoveCursorInput.Type;

export const ComputerDragInput = Schema.Struct({
  from: ComputerTarget,
  to: ComputerTarget,
  durationMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))),
});
export type ComputerDragInput = typeof ComputerDragInput.Type;

export const ComputerScrollInput = Schema.Struct({
  ...ComputerTargetFields,
  deltaX: Schema.Finite,
  deltaY: Schema.Finite,
});
export type ComputerScrollInput = typeof ComputerScrollInput.Type;

export const ComputerTypeTextInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(COMPUTER_TEXT_MAX_LENGTH)),
});
export type ComputerTypeTextInput = typeof ComputerTypeTextInput.Type;

export const ComputerPressKeyInput = Schema.Struct({
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type ComputerPressKeyInput = typeof ComputerPressKeyInput.Type;

export const ComputerHotkeyInput = Schema.Struct({
  keys: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
});
export type ComputerHotkeyInput = typeof ComputerHotkeyInput.Type;

export const ComputerSetValueInput = Schema.Struct({
  ...ComputerTargetFields,
  value: Schema.String.check(Schema.isMaxLength(COMPUTER_TEXT_MAX_LENGTH)),
});
export type ComputerSetValueInput = typeof ComputerSetValueInput.Type;

export const ComputerPerformActionInput = Schema.Struct({
  ...ComputerTargetFields,
  action: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type ComputerPerformActionInput = typeof ComputerPerformActionInput.Type;

export const ComputerActionResult = Schema.Struct({
  computerId: ComputerId,
  action: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  point: Schema.optional(ComputerPoint),
  windowId: Schema.optional(ComputerWindowId),
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(COMPUTER_TEXT_MAX_LENGTH))),
});
export type ComputerActionResult = typeof ComputerActionResult.Type;

// ── Push events ─────────────────────────────────────────────────────

export const ComputerThreadStateEvent = Schema.Struct({
  type: Schema.Literal("computer.thread-state"),
  state: ThreadComputerState,
});
export type ComputerThreadStateEvent = typeof ComputerThreadStateEvent.Type;

export const ComputerWindowsChangedEvent = Schema.Struct({
  type: Schema.Literal("computer.windows-changed"),
  windows: Schema.Array(ComputerWindow).check(Schema.isMaxLength(512)),
});
export type ComputerWindowsChangedEvent = typeof ComputerWindowsChangedEvent.Type;

export const ComputerActionEvent = Schema.Struct({
  type: Schema.Literal("computer.action"),
  action: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  ok: Schema.Boolean,
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(COMPUTER_MESSAGE_MAX_LENGTH))),
});
export type ComputerActionEvent = typeof ComputerActionEvent.Type;

export const ComputerFrameEvent = Schema.Struct({
  type: Schema.Literal("computer.frame"),
  header: Schema.Struct({
    computerId: ComputerId,
    sequence: NonNegativeInt,
    timestampMs: Schema.Finite,
    keyframe: Schema.Boolean,
    codecConfig: Schema.Boolean,
  }),
});
export type ComputerFrameEvent = typeof ComputerFrameEvent.Type;

export const ComputerEvent = Schema.Union([
  ComputerThreadStateEvent,
  ComputerWindowsChangedEvent,
  ComputerActionEvent,
  ComputerFrameEvent,
]);
export type ComputerEvent = typeof ComputerEvent.Type;

// ── Frame channel envelope (type-level contract only) ────────────────

export const COMPUTER_FRAME_MAGIC = 0x5343;
export const COMPUTER_FRAME_VERSION = 1;
export const COMPUTER_FRAME_FLAG_KEYFRAME = 0b0000_0001;
export const COMPUTER_FRAME_FLAG_CODEC_CONFIG = 0b0000_0010;
export const COMPUTER_FRAME_HEADER_FIXED_BYTES = 17;
export const COMPUTER_FRAME_MAX_COMPUTER_ID_BYTES = 255;

export const ComputerFrameHeader = Schema.Struct({
  computerId: ComputerId,
  sequence: NonNegativeInt,
  timestampMs: Schema.Finite,
  keyframe: Schema.Boolean,
  codecConfig: Schema.Boolean,
});
export type ComputerFrameHeader = typeof ComputerFrameHeader.Type;

export const ComputerFrameDecodeErrorReason = Schema.Literals([
  "too-short",
  "bad-magic",
  "unsupported-version",
  "truncated-computer-id",
  "invalid-computer-id",
]);
export type ComputerFrameDecodeErrorReason = typeof ComputerFrameDecodeErrorReason.Type;
