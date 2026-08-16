import type {
  ComputerActionResult,
  ComputerAvailability,
  ComputerId,
  ComputerLaunchAppResult,
  ComputerPoint,
  ComputerScreenSize,
  ComputerState,
  ComputerTarget,
  ComputerUiNode,
  ComputerWindow,
} from "@synara/contracts";

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

export function computerBackendActionResult(
  computerId: string,
  action: string,
  result: ComputerBackendActionResult | void,
): ComputerActionResult {
  return {
    computerId,
    action,
    ...(result?.point ? { point: result.point } : {}),
    ...(result?.windowId ? { windowId: result.windowId } : {}),
    ...(result?.value !== undefined ? { value: result.value } : {}),
  } as ComputerActionResult;
}
