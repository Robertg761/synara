import type {
  ComputerActionResult,
  ComputerAvailability,
  ComputerId,
  ComputerLaunchAppResult,
  ComputerPoint,
  ComputerRect,
  ComputerScreenSize,
  ComputerScreenshot,
  ComputerState,
  ComputerTarget,
  ComputerUiNode,
  ComputerWindow,
} from "@synara/contracts";

/** Longest screenshot side in pixels before a capture is downscaled. */
export const DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION = 2_048;
/** Native per-side image limit enforced by the KWin capture path. */
export const MAX_COMPUTER_CAPTURE_MAX_DIMENSION = 16_384;

/**
 * A zoomed capture request: one window, or one rect of the global desktop
 * coordinate space that window bounds and pointer actions already use.
 */
export type ComputerCaptureRequest =
  | { readonly kind: "window"; readonly windowId: string; readonly maxDimension?: number }
  | { readonly kind: "region"; readonly region: ComputerRect; readonly maxDimension?: number };

export interface ComputerStreamFrame {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly keyframe: boolean;
  readonly codecConfig: boolean;
  readonly data: Uint8Array;
}

export interface ComputerResolvedTarget {
  readonly target: ComputerTarget;
  readonly point: ComputerPoint;
  readonly node: ComputerUiNode;
}

export interface ComputerBackendActionResult {
  readonly point?: ComputerPoint;
  /**
   * Set when the display server refused the requested point and moved the
   * pointer elsewhere, which happens on multi-monitor layouts whose global
   * coordinate space has gaps between outputs.
   */
  readonly clampedTo?: ComputerPoint;
  readonly windowId?: string;
  readonly value?: string;
}

export type ComputerBackendEvent =
  | { readonly type: "windows-changed"; readonly windows: readonly ComputerWindow[] }
  | { readonly type: "frame"; readonly frame: ComputerStreamFrame };

export type ComputerFrameListener = (frame: ComputerStreamFrame) => void;
export type ComputerBackendEventListener = (event: ComputerBackendEvent) => void;

export class ComputerBackendError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ComputerBackendError";
    this.retryable = options.retryable ?? false;
  }
}

/** Provider-side contract shared by real display backends and the CI fake. */
export interface ComputerBackend {
  readonly computerId: ComputerId;
  availability(): Promise<ComputerAvailability>;
  listWindows(): Promise<readonly ComputerWindow[]>;
  getScreenSize(): Promise<ComputerScreenSize>;
  getState(options: {
    readonly includeScreenshot?: boolean;
    readonly includeText?: boolean;
  }): Promise<ComputerState>;
  /**
   * Zoomed perception. `getState` downscales the whole multi-monitor workspace
   * into one screenshot, which loses small text; this captures a single window
   * or region at a far higher effective resolution and returns the same
   * `region` + `scale` mapping so pixels still convert to desktop coordinates.
   */
  captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot>;
  /** Pin or release the plugin's per-seat target window when supported. */
  focusWindow?(windowId: string): Promise<void>;
  clearFocusWindow?(): Promise<void>;
  launchApp(app: string, args: readonly string[]): Promise<ComputerLaunchAppResult>;
  click(point: ComputerPoint): Promise<ComputerBackendActionResult | void>;
  doubleClick(point: ComputerPoint): Promise<ComputerBackendActionResult | void>;
  rightClick(point: ComputerPoint): Promise<ComputerBackendActionResult | void>;
  moveCursor(point: ComputerPoint): Promise<ComputerBackendActionResult | void>;
  drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
  ): Promise<ComputerBackendActionResult | void>;
  scroll(
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerBackendActionResult | void>;
  typeText(text: string): Promise<ComputerBackendActionResult | void>;
  pressKey(key: string): Promise<ComputerBackendActionResult | void>;
  hotkey(keys: readonly string[]): Promise<ComputerBackendActionResult | void>;
  setValue(
    target: ComputerResolvedTarget,
    value: string,
  ): Promise<ComputerBackendActionResult | void>;
  performAction(
    target: ComputerResolvedTarget,
    action: string,
  ): Promise<ComputerBackendActionResult | void>;
  onEvent?(listener: ComputerBackendEventListener): () => void;
  attachStream(listener: ComputerFrameListener): Promise<void>;
  detachStream(): Promise<void>;
  requestKeyframe?(): Promise<void>;
  dispose(): Promise<void> | void;
}

/**
 * Overlap of two desktop rects, or `undefined` when they do not overlap. Both
 * backends clip a capture request to what actually exists on the workspace, so
 * the region metadata describes the pixels the caller really received.
 */
export function intersectComputerRects(
  first: ComputerRect,
  second: ComputerRect,
): ComputerRect | undefined {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function computerBackendActionResult(
  computerId: string,
  action: string,
  result: ComputerBackendActionResult | void,
): ComputerActionResult {
  return {
    computerId,
    action,
    ...(result?.point ? { point: result.point } : {}),
    ...(result?.clampedTo ? { clampedTo: result.clampedTo } : {}),
    ...(result?.windowId ? { windowId: result.windowId } : {}),
    ...(result?.value !== undefined ? { value: result.value } : {}),
  } as ComputerActionResult;
}
