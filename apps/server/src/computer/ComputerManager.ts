import {
  ComputerId,
  ComputerPoint,
  ComputerScreenSize,
  COMPUTER_TEXT_MAX_LENGTH,
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

/**
 * Crash backstop for the desktop lease, not the normal release path.
 *
 * There is one desktop, one cursor and one keyboard focus, so exactly one
 * thread may drive it at a time. Ownership is released the moment the owner's
 * turn ends (`releaseDesktopControl`, driven by the provider runtime's
 * terminal turn and session events), because a takeover mid-turn corrupts the
 * owner: its drag is teleported, its typing is retargeted. Idle expiry only
 * covers the case where that signal never arrives — a provider process that
 * died without a terminal event — and so is deliberately long: a model can
 * think for minutes between two tool calls, and expiring under a live turn is
 * the failure this whole mechanism exists to prevent. Five minutes matches the
 * KWin plugin's own session idle timeout, the point past which the desktop
 * session is being torn down anyway.
 */
export const COMPUTER_LEASE_IDLE_MS = 300_000;

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

/** The single desktop's exclusive owner, and when it last drove it. */
interface DesktopLease {
  readonly threadId: string;
  lastActivityMs: number;
}

export interface ComputerManagerOptions {
  readonly backend: ComputerBackend;
  readonly transport?: FrameTransport<string, ComputerStreamFrame>;
  /** Injected for tests; the lease is the only clock-dependent state here. */
  readonly now?: () => number;
  readonly leaseIdleMs?: number;
}

/**
 * Refusal raised when another thread owns the desktop. It extends
 * `ComputerBackendError` so every existing catch site keeps classifying it,
 * and carries `retryable` because the desktop does come free again — the
 * message tells the model to come back rather than to give up or find another
 * way in.
 */
export class ComputerLeaseError extends ComputerBackendError {
  readonly code = "computer_controlled_by_other_thread";

  constructor() {
    super(
      "The computer is currently controlled by another conversation; try again when it is free. " +
        "Reading the desktop (windows, state, screenshots) still works while it is held.",
      { retryable: true },
    );
    this.name = "ComputerLeaseError";
  }
}

/** Thread state, targeting, action dispatch, and stream ownership for a computer. */
export class ComputerManager {
  readonly computerId: ComputerId;

  private readonly backend: ComputerBackend;
  private readonly transport: FrameTransport<string, ComputerStreamFrame>;
  private readonly listeners = new Set<ComputerEventListener>();
  private readonly threads = new Map<string, ThreadComputerRuntimeState>();
  private readonly backendUnsubscribe?: () => void;
  private readonly now: () => number;
  private readonly leaseIdleMs: number;
  private lease: DesktopLease | null = null;
  private streamAttached = false;
  private streamDesired = false;
  private streamEpoch = 0;
  private streamTransition: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: ComputerManagerOptions) {
    this.backend = options.backend;
    this.computerId = options.backend.computerId;
    this.now = options.now ?? Date.now;
    this.leaseIdleMs = options.leaseIdleMs ?? COMPUTER_LEASE_IDLE_MS;
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

  /** Launching spawns windows on the shared desktop, so it takes the lease too. */
  async launchApp(
    threadId: string | undefined,
    app: string,
    args: readonly string[] = [],
  ): Promise<ComputerLaunchAppResult> {
    await this.claimDesktopControl(threadId);
    const result = await this.backend.launchApp(app, args);
    this.emitAction(threadId, "computer_launch_app");
    return result;
  }

  async getThreadState(threadId: string): Promise<ThreadComputerState> {
    const state = this.threadRuntime(threadId);
    return (await this.publish(threadId, false)) ?? this.threadSnapshot(threadId, state);
  }

  async click(threadId: string | undefined, target: ComputerTarget): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const resolved = await this.resolvePointTarget(target);
    await this.prepareResolvedTarget(resolved.windowId);
    const result = await this.backend.click(resolved.point);
    return this.actionResult(threadId, "computer_click", resolved.point, result);
  }

  async doubleClick(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const resolved = await this.resolvePointTarget(target);
    await this.prepareResolvedTarget(resolved.windowId);
    const result = await this.backend.doubleClick(resolved.point);
    return this.actionResult(threadId, "computer_double_click", resolved.point, result);
  }

  async rightClick(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const resolved = await this.resolvePointTarget(target);
    await this.prepareResolvedTarget(resolved.windowId);
    const result = await this.backend.rightClick(resolved.point);
    return this.actionResult(threadId, "computer_right_click", resolved.point, result);
  }

  async moveCursor(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const resolved = await this.resolvePointTarget(target);
    await this.prepareResolvedTarget(resolved.windowId);
    const result = await this.backend.moveCursor(resolved.point);
    return this.actionResult(threadId, "computer_move_cursor", resolved.point, result);
  }

  async drag(
    threadId: string | undefined,
    from: ComputerTarget,
    to: ComputerTarget,
    durationMs = 250,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const [resolvedFrom, resolvedTo] = await Promise.all([
      this.resolvePointTarget(from),
      this.resolvePointTarget(to),
    ]);
    await this.prepareResolvedTarget(resolvedFrom.windowId ?? resolvedTo.windowId);
    const result = await this.backend.drag(resolvedFrom.point, resolvedTo.point, durationMs);
    return this.actionResult(threadId, "computer_drag", resolvedTo.point, result);
  }

  async scroll(
    threadId: string | undefined,
    target: ComputerTarget | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const resolved = target ? await this.resolvePointTarget(target) : null;
    await this.prepareResolvedTarget(resolved?.windowId);
    const result = await this.backend.scroll(resolved?.point ?? null, deltaX, deltaY);
    return this.actionResult(threadId, "computer_scroll", resolved?.point, result);
  }

  async typeText(threadId: string | undefined, text: string): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const result = await this.backend.typeText(text);
    return this.actionResult(threadId, "computer_type_text", undefined, result);
  }

  async pressKey(threadId: string | undefined, key: string): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const result = await this.backend.pressKey(key);
    return this.actionResult(threadId, "computer_press_key", undefined, result);
  }

  async hotkey(
    threadId: string | undefined,
    keys: readonly string[],
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const result = await this.backend.hotkey(keys);
    return this.actionResult(threadId, "computer_hotkey", undefined, result);
  }

  /**
   * The clipboard is the system one the human shares, and it is optional on the
   * backend, so a backend without it refuses the call instead of the tool
   * layer discovering a missing method at dispatch time.
   *
   * Reading it takes the lease even though it mutates nothing: the clipboard is
   * one shared slot that the owning thread is mid-way through using, and a read
   * from a second thread is either racing that write or reading its private
   * payload. Uniformity also keeps the rule the model must learn simple —
   * perception of the screen is free, everything clipboard is not.
   */
  async readClipboard(threadId: string | undefined): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const read = this.backend.readClipboard?.bind(this.backend);
    if (!read) throw clipboardUnsupportedError();
    const value = await read();
    // `ComputerActionResult.value` is contract-bounded well below the backend's
    // byte cap, and an oversized read must not slip out through the unvalidated
    // MCP result path.
    if (value.length > COMPUTER_TEXT_MAX_LENGTH) {
      throw new ComputerBackendError(
        `The desktop clipboard holds ${value.length} characters of text, more than the ${COMPUTER_TEXT_MAX_LENGTH} this tool returns.`,
      );
    }
    return this.actionResult(threadId, "computer_read_clipboard", undefined, { value });
  }

  async writeClipboard(threadId: string | undefined, text: string): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const write = this.backend.writeClipboard?.bind(this.backend);
    if (!write) throw clipboardUnsupportedError();
    await write(text);
    // The text is not echoed back on `value`: the caller already has it, and it
    // may be far larger than the contract bound on that field.
    return this.actionResult(threadId, "computer_write_clipboard", undefined, undefined);
  }

  async setValue(
    threadId: string | undefined,
    target: ComputerTarget,
    value: string,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const resolved = await this.resolveSemanticTarget(target);
    await this.prepareResolvedTarget(resolved.node.windowId ?? undefined);
    const result = await this.backend.setValue(resolved, value);
    return this.actionResult(threadId, "computer_set_value", resolved.point, result);
  }

  async performAction(
    threadId: string | undefined,
    target: ComputerTarget,
    action: string,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const resolved = await this.resolveSemanticTarget(target);
    await this.prepareResolvedTarget(resolved.node.windowId ?? undefined);
    const result = await this.backend.performAction(resolved, action);
    return this.actionResult(threadId, "computer_perform_action", resolved.point, result);
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

  /**
   * Take or renew the exclusive desktop lease for a mutating agent action, or
   * refuse the action because another conversation holds it.
   *
   * Ownership is implicit: the first thread to drive the desktop owns it, and
   * keeps owning it until its turn ends. There is no explicit acquire tool
   * because there is nothing sensible for a model to do with one — it would
   * either forget to release, or treat a refusal to acquire as a different
   * failure from a refusal to act.
   *
   * An undefined (or blank) thread is the human driving through the computer
   * pane, which the same rule as `emitAction` identifies. The human is not a
   * competing agent: they are the person the desktop belongs to, so pane input
   * neither takes the lease nor is ever refused by it.
   */
  private async claimDesktopControl(threadId: string | undefined): Promise<void> {
    const owner = agentThreadId(threadId);
    if (owner === undefined) return;
    const now = this.now();
    const held = this.lease;
    if (held && held.threadId !== owner && !this.isLeaseStale(held, now)) {
      throw new ComputerLeaseError();
    }
    const changed = held?.threadId !== owner;
    this.lease = { threadId: owner, lastActivityMs: now };
    // Both panels change: the new owner stops being blocked, and every other
    // thread starts being.
    if (changed) await this.publishAllThreads();
  }

  /**
   * Release the desktop the moment the owning thread stops being able to drive
   * it — its turn reached a terminal state, or its provider session exited.
   * This is the lease's primary release path; idle expiry only covers a runtime
   * that died without reporting either.
   *
   * Scoped to the thread rather than to one turn: the manager never sees turn
   * ids, and it does not need them, because the gateway already refuses every
   * computer tool call outside an active turn. A thread whose turn ended cannot
   * act again regardless of what the lease says.
   */
  async releaseDesktopControl(threadId: string): Promise<void> {
    const owner = agentThreadId(threadId);
    if (owner === undefined || this.lease?.threadId !== owner) return;
    this.lease = null;
    await this.publishAllThreads();
  }

  /**
   * Stale only once nothing is in flight: a call that is still running holds
   * the pointer or the keyboard right now, and elapsed time since it started
   * says nothing about whether it has finished.
   */
  private isLeaseStale(lease: DesktopLease, now: number): boolean {
    if (now - lease.lastActivityMs < this.leaseIdleMs) return false;
    return (this.threads.get(lease.threadId)?.agentActiveCount ?? 0) === 0;
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
    // Deleted after the thread state, so the resulting publish cannot recreate
    // it: a removed thread must not reappear as a lease holder.
    await this.releaseDesktopControl(threadId);
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

  /**
   * Coordinates plus a window id are a window-scoped click: the point is
   * resolved exactly as a bare coordinate, and the window id only decides which
   * window is raised and receives the input. A label or role instead means the
   * coordinate is at most a hint, so those keep going through AT-SPI
   * resolution, which owns the final point.
   */
  private async resolvePointTarget(
    target: ComputerTarget,
  ): Promise<{ point: ComputerPoint; windowId?: string }> {
    if (hasCoordinates(target) && !hasLabelFields(target)) {
      const point = await this.resolveCoordinatePoint(target);
      if (target.windowId === undefined) return { point };
      await this.assertPointInsideWindow(point, target.windowId);
      return { point, windowId: target.windowId };
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

  private async resolveCoordinatePoint(target: ComputerTarget): Promise<ComputerPoint> {
    try {
      return resolveComputerPoint(target, await this.backend.getScreenSize());
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

  /**
   * A scoped click is refused rather than redirected. Input is routed to the
   * named window regardless of what covers that coordinate, so a point outside
   * its bounds would deliver a click to a part of the window that does not
   * exist — the one failure mode scoping is meant to remove.
   */
  private async assertPointInsideWindow(point: ComputerPoint, windowId: string): Promise<void> {
    const window = (await this.backend.listWindows()).find(
      (candidate) => candidate.id === windowId,
    );
    if (!window) {
      throw new ComputerTargetError({
        code: "computer_target_not_found",
        message:
          `No desktop window has id ${JSON.stringify(windowId)}. ` +
          "Call computer_list_windows for the current window ids.",
        notFound: true,
      });
    }
    const { bounds } = window;
    if (
      point.x < bounds.x ||
      point.y < bounds.y ||
      point.x >= bounds.x + bounds.width ||
      point.y >= bounds.y + bounds.height
    ) {
      throw new ComputerTargetError({
        code: "computer_target_offscreen",
        message:
          `Computer target (${point.x}, ${point.y}) is outside window ${JSON.stringify(windowId)}, ` +
          `which covers ${bounds.width}x${bounds.height} at (${bounds.x}, ${bounds.y}). ` +
          "Pass a coordinate inside those bounds, or drop window_id to click whatever is topmost.",
      });
    }
  }

  /**
   * Raise before focus: focus alone routes the agent's input to a window that
   * may still be buried, which leaves the human watching clicks land on pixels
   * they cannot see. Both calls are optional so a backend that supports neither
   * keeps working.
   */
  private async prepareResolvedTarget(windowId: string | undefined): Promise<void> {
    if (windowId !== undefined) {
      await this.backend.raiseWindow?.(windowId);
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
    threadId: string | undefined,
    action: string,
    point: ComputerPoint | undefined,
    result: ComputerBackendActionResult | void,
  ): ComputerActionResult {
    this.emitAction(threadId, action);
    return computerBackendActionResult(this.computerId, action, {
      ...(point ? { point } : {}),
      ...(result ?? {}),
    });
  }

  /**
   * Desktop activity is attributed to the thread that drove it so an observer
   * can tell one agent's work from another's. Pane input carries no thread and
   * stays unattributed rather than borrowing an unrelated thread id.
   */
  private emitAction(threadId: string | undefined, action: string): void {
    const attributed = agentThreadId(threadId);
    this.emit({
      type: "computer.action",
      action,
      ok: true,
      ...(attributed ? { threadId: ThreadId.makeUnsafe(attributed) } : {}),
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
      controlledByOtherThread: this.lease !== null && this.lease.threadId !== threadId,
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

/**
 * The caller as an agent thread, or undefined for desktop input that belongs to
 * no thread — the human at the computer pane. Attribution and the desktop lease
 * must agree on who that is, so both read it here.
 */
function agentThreadId(threadId: string | undefined): string | undefined {
  const trimmed = threadId?.trim();
  return trimmed ? trimmed : undefined;
}

function clipboardUnsupportedError(): ComputerBackendError {
  return new ComputerBackendError("This computer backend does not support clipboard access.");
}

function hasCoordinates(target: ComputerTarget): boolean {
  return typeof target.x === "number" && typeof target.y === "number";
}

/** Fields that only the accessibility tree can resolve. */
function hasLabelFields(target: ComputerTarget): boolean {
  return target.label !== undefined || target.role !== undefined;
}

function hasSemanticFields(target: ComputerTarget): boolean {
  return hasLabelFields(target) || target.windowId !== undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ComputerBackendError || error instanceof ComputerTargetError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
