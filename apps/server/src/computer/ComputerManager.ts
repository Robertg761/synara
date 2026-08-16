import {
  ComputerId,
  ComputerPoint,
  ComputerScreenSize,
  ThreadId,
  type ComputerActionResult,
  type ComputerAvailability,
  type ComputerEvent,
  type ComputerScreenshot,
  type ComputerGetScreenSizeResult,
  type ComputerListWindowsResult,
  type ComputerLaunchAppResult,
  type ComputerState,
  type ComputerTarget,
  type ComputerWindow,
  type ThreadComputerState,
} from "@synara/contracts";
import { encodeComputerFrame } from "@synara/shared/computerFrame";
import { FrameTransport, type FrameSink } from "@synara/shared/frameTransport";

import {
  computerBackendActionResult,
  ComputerBackendError,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerCaptureRequest,
  type ComputerStreamFrame,
  type ComputerResolvedTarget,
} from "./ComputerBackend.ts";
import {
  ComputerTargetError,
  computerTargetCandidates,
  resolveComputerPoint,
  resolveComputerSemanticTarget,
} from "./uiTreeTargeting.ts";

export const COMPUTER_FRAME_QUEUE_LIMIT = 8;
export const COMPUTER_FRAME_SOCKET_BUDGET_BYTES = 2 * 1024 * 1024;

export type ComputerEventListener = (event: ComputerEvent) => void;

interface ThreadComputerRuntimeState {
  version: number;
  agentActiveCount: number;
  lastError: string | null;
  windows: readonly ComputerWindow[];
  screenSize: ComputerScreenSize;
  availability: ComputerAvailability;
  cursor?: ComputerPoint;
}

export interface ComputerManagerOptions {
  readonly backend: ComputerBackend;
  readonly transport?: FrameTransport<string, ComputerStreamFrame>;
}

/** Thread state, targeting, action dispatch, and stream ownership for a computer. */
export class ComputerManager {
  readonly computerId: ComputerId;

  private readonly backend: ComputerBackend;
  private readonly transport: FrameTransport<string, ComputerStreamFrame>;
  private readonly listeners = new Set<ComputerEventListener>();
  private readonly threads = new Map<string, ThreadComputerRuntimeState>();
  private readonly backendUnsubscribe?: () => void;
  private streamAttached = false;
  private streamDesired = false;
  private streamEpoch = 0;
  private streamTransition: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: ComputerManagerOptions) {
    this.backend = options.backend;
    this.computerId = options.backend.computerId;
    this.transport =
      options.transport ??
      new FrameTransport<string, ComputerStreamFrame>({
        encode: (computerId, frame) =>
          encodeComputerFrame({
            header: {
              computerId,
              sequence: frame.sequence,
              timestampMs: frame.timestampMs,
              keyframe: frame.keyframe,
              codecConfig: frame.codecConfig,
            },
            payload: frame.data,
          }),
        queueLimit: COMPUTER_FRAME_QUEUE_LIMIT,
        socketBudgetBytes: COMPUTER_FRAME_SOCKET_BUDGET_BYTES,
        subscriberIdPrefix: "computer-frame-subscriber",
      });
    if (options.backend.onEvent) {
      this.backendUnsubscribe = options.backend.onEvent((event) => {
        if (event.type === "windows-changed") {
          for (const state of this.threads.values()) state.windows = event.windows;
          this.emit({ type: "computer.windows-changed", windows: event.windows });
          void this.publishAllThreads();
        }
      });
    }
  }

  onEvent(listener: ComputerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async availability(): Promise<ComputerAvailability> {
    return await this.backend.availability();
  }

  async listWindows(): Promise<ComputerListWindowsResult> {
    const [availability, windows] = await Promise.all([
      this.backend.availability(),
      this.backend.listWindows(),
    ]);
    return { computerId: this.computerId, windows, availability };
  }

  async getState(
    options: {
      readonly includeScreenshot?: boolean;
      readonly includeText?: boolean;
    } = {},
  ): Promise<ComputerState> {
    return await this.backend.getState(options);
  }

  /** Zoomed capture of one window or desktop region, with its pixel mapping. */
  async captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot> {
    return await this.backend.captureScreenshot(request);
  }

  async getScreenSize(): Promise<ComputerGetScreenSizeResult> {
    const [availability, screenSize] = await Promise.all([
      this.backend.availability(),
      this.backend.getScreenSize(),
    ]);
    return { computerId: this.computerId, screenSize, availability };
  }

  async launchApp(app: string, args: readonly string[] = []): Promise<ComputerLaunchAppResult> {
    const result = await this.backend.launchApp(app, args);
    this.emit({ type: "computer.action", action: "computer_launch_app", ok: true });
    return result;
  }

  async getThreadState(threadId: string): Promise<ThreadComputerState> {
    const state = this.threadRuntime(threadId);
    return (await this.publish(threadId, false)) ?? this.threadSnapshot(threadId, state);
  }

  async click(threadId: string | undefined, target: ComputerTarget): Promise<ComputerActionResult> {
    const resolved = await this.resolvePointTarget(target);
    await this.prepareResolvedTarget(resolved.windowId);
    const result = await this.backend.click(resolved.point);
    return this.actionResult("computer_click", resolved.point, result);
  }

  async doubleClick(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    const resolved = await this.resolvePointTarget(target);
    await this.prepareResolvedTarget(resolved.windowId);
    const result = await this.backend.doubleClick(resolved.point);
    return this.actionResult("computer_double_click", resolved.point, result);
  }

  async rightClick(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    const resolved = await this.resolvePointTarget(target);
    await this.prepareResolvedTarget(resolved.windowId);
    const result = await this.backend.rightClick(resolved.point);
    return this.actionResult("computer_right_click", resolved.point, result);
  }

  async moveCursor(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    const resolved = await this.resolvePointTarget(target);
    await this.prepareResolvedTarget(resolved.windowId);
    const result = await this.backend.moveCursor(resolved.point);
    return this.actionResult("computer_move_cursor", resolved.point, result);
  }

  async drag(
    threadId: string | undefined,
    from: ComputerTarget,
    to: ComputerTarget,
    durationMs = 250,
  ): Promise<ComputerActionResult> {
    const [resolvedFrom, resolvedTo] = await Promise.all([
      this.resolvePointTarget(from),
      this.resolvePointTarget(to),
    ]);
    await this.prepareResolvedTarget(resolvedFrom.windowId ?? resolvedTo.windowId);
    const result = await this.backend.drag(resolvedFrom.point, resolvedTo.point, durationMs);
    return this.actionResult("computer_drag", resolvedTo.point, result);
  }

  async scroll(
    threadId: string | undefined,
    target: ComputerTarget | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerActionResult> {
    const resolved = target ? await this.resolvePointTarget(target) : null;
    await this.prepareResolvedTarget(resolved?.windowId);
    const result = await this.backend.scroll(resolved?.point ?? null, deltaX, deltaY);
    return this.actionResult("computer_scroll", resolved?.point, result);
  }

  async typeText(threadId: string | undefined, text: string): Promise<ComputerActionResult> {
    const result = await this.backend.typeText(text);
    return this.actionResult("computer_type_text", undefined, result);
  }

  async pressKey(threadId: string | undefined, key: string): Promise<ComputerActionResult> {
    const result = await this.backend.pressKey(key);
    return this.actionResult("computer_press_key", undefined, result);
  }

  async hotkey(
    threadId: string | undefined,
    keys: readonly string[],
  ): Promise<ComputerActionResult> {
    const result = await this.backend.hotkey(keys);
    return this.actionResult("computer_hotkey", undefined, result);
  }

  async setValue(
    threadId: string | undefined,
    target: ComputerTarget,
    value: string,
  ): Promise<ComputerActionResult> {
    const resolved = await this.resolveSemanticTarget(target);
    await this.prepareResolvedTarget(resolved.node.windowId ?? undefined);
    const result = await this.backend.setValue(resolved, value);
    return this.actionResult("computer_set_value", resolved.point, result);
  }

  async performAction(
    threadId: string | undefined,
    target: ComputerTarget,
    action: string,
  ): Promise<ComputerActionResult> {
    const resolved = await this.resolveSemanticTarget(target);
    await this.prepareResolvedTarget(resolved.node.windowId ?? undefined);
    const result = await this.backend.performAction(resolved, action);
    return this.actionResult("computer_perform_action", resolved.point, result);
  }

  async withAgentActivity<A>(threadId: string, action: () => Promise<A>): Promise<A> {
    const state = this.threads.get(threadId);
    if (state) {
      state.agentActiveCount += 1;
      if (state.agentActiveCount === 1) await this.publish(threadId, true).catch(() => undefined);
    }
    try {
      return await action();
    } finally {
      if (state && this.threads.get(threadId) === state) {
        state.agentActiveCount = Math.max(0, state.agentActiveCount - 1);
        if (state.agentActiveCount === 0) await this.publish(threadId, true).catch(() => undefined);
      }
    }
  }

  async recordThreadError(threadId: string, message: string): Promise<void> {
    const state = this.threads.get(threadId);
    if (!state) return;
    state.lastError = message;
    await this.publish(threadId, true).catch(() => undefined);
  }

  subscribeFrames(sink: FrameSink): () => void {
    const unsubscribe = this.transport.subscribe(this.computerId, sink);
    this.streamDesired = true;
    this.streamEpoch += 1;
    void this.reconcileStream().catch((error) => this.recordError(error));
    return () => {
      unsubscribe();
      if (this.transport.streamSubscriberCount(this.computerId) === 0) {
        this.streamDesired = false;
        this.streamEpoch += 1;
        void this.reconcileStream().catch((error) => this.recordError(error));
      }
    };
  }

  async requestKeyframe(): Promise<void> {
    if (!this.streamAttached || this.transport.streamSubscriberCount(this.computerId) === 0) return;
    const epoch = this.streamEpoch;
    await this.enqueueStreamTransition(async () => {
      if (!this.isStreamWanted(epoch) || !this.streamAttached) return;
      if (this.backend.requestKeyframe) {
        await this.backend.requestKeyframe();
        if (!this.isStreamWanted(epoch)) return;
        return;
      }
      await this.backend.detachStream();
      this.streamAttached = false;
      if (!this.isStreamWanted(epoch)) {
        this.transport.reset(this.computerId);
        return;
      }
      this.transport.reset(this.computerId);
      await this.backend.attachStream((frame) => this.handleFrame(frame));
      if (!this.isStreamWanted(epoch)) {
        this.streamAttached = false;
        this.transport.reset(this.computerId);
        await this.backend.detachStream();
        return;
      }
      this.streamAttached = true;
    });
  }

  async flushStreamTransitions(): Promise<void> {
    await this.streamTransition;
  }

  async handleThreadRemoved(threadId: string): Promise<void> {
    this.threads.delete(threadId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.streamDesired = false;
    this.streamEpoch += 1;
    await this.enqueueStreamTransition(async () => {
      if (this.streamAttached) {
        this.streamAttached = false;
        this.transport.reset(this.computerId);
        await this.backend.detachStream();
      }
    }).catch(() => undefined);
    this.backendUnsubscribe?.();
    await this.backend.dispose();
    this.listeners.clear();
  }

  private async reconcileStream(): Promise<void> {
    await this.enqueueStreamTransition(async () => {
      if (this.disposed || !this.streamDesired) {
        if (!this.streamAttached) return;
        this.streamAttached = false;
        this.transport.reset(this.computerId);
        await this.backend.detachStream();
        return;
      }
      if (this.streamAttached) return;
      const epoch = this.streamEpoch;
      await this.backend.attachStream((frame) => this.handleFrame(frame));
      if (!this.isStreamWanted(epoch)) {
        await this.backend.detachStream();
        this.transport.reset(this.computerId);
        return;
      }
      this.streamAttached = true;
    });
  }

  private enqueueStreamTransition(action: () => Promise<void>): Promise<void> {
    const next = this.streamTransition.then(action);
    this.streamTransition = next.catch(() => undefined);
    return next;
  }

  private handleFrame(frame: ComputerStreamFrame): void {
    if (this.disposed || (!this.streamDesired && !this.streamAttached)) return;
    this.transport.publish(this.computerId, frame);
    this.emit({
      type: "computer.frame",
      header: {
        computerId: this.computerId,
        sequence: frame.sequence,
        timestampMs: frame.timestampMs,
        keyframe: frame.keyframe,
        codecConfig: frame.codecConfig,
      },
    });
  }

  private async resolvePointTarget(
    target: ComputerTarget,
  ): Promise<{ point: ComputerPoint; windowId?: string }> {
    if (hasCoordinates(target) && !hasSemanticFields(target)) {
      try {
        return { point: resolveComputerPoint(target, await this.backend.getScreenSize()) };
      } catch (error) {
        if (!(error instanceof ComputerTargetError) || error.code !== "computer_target_offscreen") {
          throw error;
        }
        const state = await this.backend.getState({ includeText: true }).catch(() => undefined);
        throw new ComputerTargetError({
          code: error.code,
          message: error.message,
          candidates: state?.root ? computerTargetCandidates(state.root) : [],
        });
      }
    }
    if (hasSemanticFields(target)) {
      const resolved = await this.resolveSemanticTarget(target);
      return {
        point: resolved.point,
        ...(resolved.node.windowId ? { windowId: resolved.node.windowId } : {}),
      };
    }
    throw new ComputerTargetError({
      code: "computer_target_invalid",
      message: "Computer actions require x/y coordinates or a labelled target.",
    });
  }

  private async prepareResolvedTarget(windowId: string | undefined): Promise<void> {
    if (windowId !== undefined) {
      await this.backend.focusWindow?.(windowId);
      return;
    }
    await this.backend.clearFocusWindow?.();
  }

  private async resolveSemanticTarget(target: ComputerTarget): Promise<ComputerResolvedTarget> {
    const state = await this.backend.getState({ includeText: true });
    if (!state.root) {
      throw new ComputerTargetError({
        code: "computer_target_not_found",
        message: "Computer accessibility state did not include a target tree.",
        notFound: true,
      });
    }
    return { target, ...resolveComputerSemanticTarget(state.root, target) };
  }

  private actionResult(
    action: string,
    point: ComputerPoint | undefined,
    result: ComputerBackendActionResult | void,
  ): ComputerActionResult {
    this.emit({ type: "computer.action", action, ok: true });
    return computerBackendActionResult(this.computerId, action, {
      ...(point ? { point } : {}),
      ...(result ?? {}),
    });
  }

  private async publish(
    threadId: string,
    increment: boolean,
  ): Promise<ThreadComputerState | undefined> {
    const state = this.threads.get(threadId);
    if (!state) return undefined;
    if (increment) state.version += 1;
    try {
      const [availability, windows, screenSize] = await Promise.all([
        this.backend.availability(),
        this.backend.listWindows(),
        this.backend.getScreenSize(),
      ]);
      if (this.disposed || this.threads.get(threadId) !== state) return undefined;
      state.availability = availability;
      state.windows = windows;
      state.screenSize = screenSize;
      state.lastError = null;
    } catch (error) {
      state.lastError = errorMessage(error);
    }
    if (this.disposed || this.threads.get(threadId) !== state) return undefined;
    const snapshot = this.threadSnapshot(threadId, state);
    this.emit({ type: "computer.thread-state", state: snapshot });
    return snapshot;
  }

  private async publishAllThreads(): Promise<void> {
    for (const threadId of this.threads.keys()) await this.publish(threadId, true);
  }

  private threadRuntime(threadId: string): ThreadComputerRuntimeState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {
        version: 0,
        agentActiveCount: 0,
        lastError: null,
        windows: [],
        screenSize: { width: 1, height: 1 },
        availability: {
          kind: "backend-unavailable",
          message: "Computer state has not been queried yet",
        },
      };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private threadSnapshot(threadId: string, state: ThreadComputerRuntimeState): ThreadComputerState {
    return {
      threadId: ThreadId.makeUnsafe(threadId),
      version: state.version,
      computerId: this.computerId,
      windows: state.windows,
      screenSize: state.screenSize,
      ...(state.cursor ? { cursor: state.cursor } : {}),
      agentActive: state.agentActiveCount > 0,
      availability: state.availability,
      lastError: state.lastError,
    };
  }

  private isStreamWanted(epoch: number): boolean {
    return (
      !this.disposed &&
      this.streamDesired &&
      this.streamEpoch === epoch &&
      this.transport.streamSubscriberCount(this.computerId) > 0
    );
  }

  private recordError(error: unknown): void {
    const message = errorMessage(error);
    for (const state of this.threads.values()) state.lastError = message;
  }

  private emit(event: ComputerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One observer cannot stop the remaining observers.
      }
    }
  }
}

function hasCoordinates(target: ComputerTarget): boolean {
  return typeof target.x === "number" && typeof target.y === "number";
}

function hasSemanticFields(target: ComputerTarget): boolean {
  return target.label !== undefined || target.role !== undefined || target.windowId !== undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ComputerBackendError || error instanceof ComputerTargetError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
