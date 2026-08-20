import {
  ComputerId,
  ComputerPoint,
  ComputerScreenSize,
  COMPUTER_TEXT_MAX_LENGTH,
  ThreadId,
  type ComputerActionResult,
  type ComputerAvailability,
  type ComputerCapabilities,
  type ComputerEvent,
  type ComputerHealth,
  type ComputerScreenshot,
  type ComputerGetScreenSizeResult,
  type ComputerListWindowsResult,
  type ComputerLaunchAppResult,
  type ComputerState,
  type ComputerStatusResult,
  type ComputerTarget,
  type ComputerWindow,
  type ThreadComputerState,
} from "@synara/contracts";
import { encodeComputerFrame } from "@synara/shared/computerFrame";
import { FrameTransport, type FrameSink } from "@synara/shared/frameTransport";

import {
  clampComputerMessage,
  computerBackendActionResult,
  ComputerBackendError,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerCaptureRequest,
  type ComputerStreamFrame,
  type ComputerResolvedTarget,
} from "./ComputerBackend.ts";
import { rectContainsPoint, windowsCoveringPoint } from "./computerGeometry.ts";
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

/**
 * How long the desktop is given to settle before the screenshot that rides on
 * an action result is captured. Long enough for a menu to open or a keystroke
 * to paint, short enough not to throttle the action loop the screenshot exists
 * to speed up.
 */
export const COMPUTER_ACTION_SETTLE_MS = 300;

/**
 * Trailing-edge window on the republish that a backend window change triggers.
 *
 * A publish costs one availability read, one window read and one screen-size
 * read per thread, and the window read is itself what reports a change — so a
 * desktop with a ticking window title (a clock, a download percentage, a video
 * player's timer) publishes, observes its own read as a change, and publishes
 * again, once per thread, without ever settling. Coalescing turns that into at
 * most one pass per window, which is the only rate that is bounded by something
 * other than how fast D-Bus answers.
 *
 * The window list itself is not delayed by this: `computer.windows-changed` is
 * emitted immediately from the event, with no backend call at all.
 */
export const COMPUTER_WINDOWS_PUBLISH_DEBOUNCE_MS = 250;

export type ComputerEventListener = (event: ComputerEvent) => void;

interface ThreadComputerRuntimeState {
  version: number;
  lastError: string | null;
  windows: readonly ComputerWindow[];
  screenSize: ComputerScreenSize;
  availability: ComputerAvailability;
  cursor?: ComputerPoint;
  /**
   * Whether this thread's agent activity has already asked the UI to open the
   * computer pane. Actions arrive every few seconds, so surfacing is once per
   * thread: repeating the request would emit an event per click and could yank
   * a user who deliberately closed the pane back to it.
   */
  paneSurfaced: boolean;
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
  /** Injected for tests, so action-screenshot tests do not sleep for real. */
  readonly actionSettleMs?: number;
  /** Injected for tests, so window-churn tests do not wait out the real window. */
  readonly windowsPublishDebounceMs?: number;
}

/**
 * A resolved pointer target, plus what the window read taken while resolving it
 * showed covering the point. The covering list rides along so the raise-failure
 * path can decide whether to refuse without paying a second window read.
 */
interface ResolvedPointTarget {
  readonly point: ComputerPoint;
  readonly windowId?: string;
  readonly covering?: readonly ComputerWindow[];
}

/**
 * What the raise/focus step needs. The point is optional because keyboard
 * actions name a window without one, and with no point there is nothing an
 * occlusion check could be about.
 */
type PreparedTarget = Omit<ResolvedPointTarget, "point"> & { readonly point?: ComputerPoint };

/** A capture plus which window it covers, when it covers one at all. */
export interface ComputerCapturedWindow {
  readonly screenshot: ComputerScreenshot;
  readonly windowId?: string;
}

/**
 * Post-action perception: the capture, or the discovery that the acted-on
 * window no longer exists. The disappearance is a result in its own right —
 * usually meaning the action closed the window — never a cue to photograph
 * whatever window happens to hold focus instead, which on a live desktop is
 * the human's.
 */
export type ComputerActionObservation =
  | ComputerCapturedWindow
  | { readonly targetWindowClosed: true };

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
  /**
   * Agent calls in flight, per thread. Deliberately not a field on the thread
   * runtime record: a thread can drive the desktop without any record existing
   * — on a visible-desktop backend no pane is ever surfaced, so nothing creates
   * one until a panel asks for that thread's state, which may be never — and
   * this count is what stops the desktop lease being taken from a thread whose
   * drag or keystroke is still running. Entries are deleted as they reach zero,
   * so nothing accumulates and a removed thread is not resurrected by a late
   * call.
   */
  private readonly agentCallsInFlight = new Map<string, number>();
  /** Display names for the agent cursor badge, keyed by thread id. */
  private readonly threadLabels = new Map<string, string>();
  private readonly backendUnsubscribe?: () => void;
  private readonly now: () => number;
  private readonly leaseIdleMs: number;
  private readonly actionSettleMs: number;
  private readonly windowsPublishDebounceMs: number;
  /** Depth rather than a flag: a lease publish can nest inside a window one. */
  private publishAllDepth = 0;
  private windowsPublishPending = false;
  private windowsPublishTimer: ReturnType<typeof setTimeout> | undefined;
  private backendHealth: ComputerHealth;
  /**
   * Read once. A backend's capability set is decided by which providers its
   * probe resolved at construction, so it cannot change under a live backend,
   * and re-reading it per snapshot would put a call on every state publish.
   */
  private readonly backendCapabilities: ComputerCapabilities;
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
    this.actionSettleMs = options.actionSettleMs ?? COMPUTER_ACTION_SETTLE_MS;
    this.windowsPublishDebounceMs =
      options.windowsPublishDebounceMs ?? COMPUTER_WINDOWS_PUBLISH_DEBOUNCE_MS;
    this.backendHealth = options.backend.health();
    this.backendCapabilities = options.backend.capabilities();
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
          this.scheduleWindowsPublish();
        } else if (event.type === "health-changed") {
          this.backendHealth = event.health;
          this.republishAllThreads();
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

  /**
   * Thread-independent status for surfaces outside any conversation, such as
   * the settings screen. A probe failure becomes `backend-unavailable` rather
   * than an error: the caller is asking whether the desktop works, and "the
   * probe itself failed" is an answer to that question, not a failure to
   * answer it.
   */
  async getStatus(): Promise<ComputerStatusResult> {
    let availability: ComputerAvailability;
    try {
      availability = await this.backend.availability();
    } catch (error) {
      availability = { kind: "backend-unavailable", message: errorMessage(error) };
    }
    return {
      computerId: this.computerId,
      availability: this.correctedAvailability(availability),
      health: this.backendHealth,
      capabilities: this.backendCapabilities,
    };
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

  /**
   * Zoomed capture of the window that holds input focus, falling back to the
   * whole workspace when no visible window with known bounds has it. This is
   * what a perception request with no explicit target means: "show me where
   * input is going", at window resolution rather than as a workspace-wide
   * downscale that loses small text.
   */
  async captureFocusedWindow(
    maxDimension?: number,
    options: { readonly agentFocusOnly?: boolean } = {},
  ): Promise<ComputerCapturedWindow> {
    const limit = maxDimension === undefined ? {} : { maxDimension };
    const window = await this.focusedCapturableWindow(options.agentFocusOnly === true);
    if (window) {
      return {
        screenshot: await this.backend.captureScreenshot({
          kind: "window",
          windowId: window.id,
          ...limit,
        }),
        windowId: window.id,
      };
    }
    const screenSize = await this.backend.getScreenSize();
    return {
      screenshot: await this.backend.captureScreenshot({
        kind: "region",
        region: { x: 0, y: 0, width: screenSize.width, height: screenSize.height },
        ...limit,
      }),
    };
  }

  /**
   * Best-effort perception for an action that already happened: wait for the
   * UI to settle, then capture the window the action affected — the caller's
   * hint when it named one, otherwise the agent's own focus target. Failures
   * return no screenshot instead of throwing, because the action itself
   * succeeded and a capture problem must not turn that success into an error.
   *
   * A hinted window that has vanished is reported as `targetWindowClosed`,
   * never replaced by another window. The E2E run that forced this rule ended
   * with the close-Firefox click's "fallback" screenshot handing the agent
   * the human's own browser — the focused window is the human's whenever the
   * agent's target is gone — which both leaked their screen and convinced the
   * agent its click had landed there. For the same reason the untargeted path
   * only ever observes the agent's focus target or the whole workspace,
   * never the compositor-active (human's) window.
   */
  async captureActionScreenshot(
    windowIdHint?: string,
  ): Promise<ComputerActionObservation | undefined> {
    if (!this.backendCapabilities.capture) return undefined;
    if (this.actionSettleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.actionSettleMs));
    }
    if (windowIdHint !== undefined) {
      try {
        return {
          screenshot: await this.backend.captureScreenshot({
            kind: "window",
            windowId: windowIdHint,
          }),
          windowId: windowIdHint,
        };
      } catch {
        try {
          const stillListed = (await this.backend.listWindows()).some(
            (window) => window.id === windowIdHint,
          );
          if (!stillListed) return { targetWindowClosed: true };
        } catch {
          // The listing failed too; report nothing rather than guessing.
        }
        return undefined;
      }
    }
    try {
      return await this.captureFocusedWindow(undefined, { agentFocusOnly: true });
    } catch {
      return undefined;
    }
  }

  /**
   * The window an untargeted capture should cover: the agent seat's focus
   * target first, then the window the compositor reports active, then the
   * topmost visible one. Windows without bounds cannot be captured — wlroots
   * exposes no geometry — so they are skipped rather than attempted.
   * `agentFocusOnly` stops after the first step: action observation must not
   * drift to the human's active window when the agent's focus is nowhere.
   */
  private async focusedCapturableWindow(
    agentFocusOnly = false,
  ): Promise<ComputerWindow | undefined> {
    const candidates = (await this.backend.listWindows()).filter(
      (window) => window.bounds !== undefined && window.visible && !window.minimized,
    );
    const agentFocused = candidates.find((window) => window.focused);
    if (agentFocused !== undefined || agentFocusOnly) return agentFocused;
    return (
      candidates.find((window) => window.active === true) ??
      candidates.toSorted(
        (first, second) =>
          (first.stackingIndex ?? Number.MAX_SAFE_INTEGER) -
          (second.stackingIndex ?? Number.MAX_SAFE_INTEGER),
      )[0]
    );
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
    await this.prepareResolvedTarget(resolved);
    const result = await this.injectScoped("computer_click", resolved, () =>
      this.backend.click(resolved.point),
    );
    return this.actionResult(threadId, "computer_click", resolved.point, result, resolved.windowId);
  }

  async doubleClick(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const resolved = await this.resolvePointTarget(target);
    await this.prepareResolvedTarget(resolved);
    const result = await this.injectScoped("computer_double_click", resolved, () =>
      this.backend.doubleClick(resolved.point),
    );
    return this.actionResult(
      threadId,
      "computer_double_click",
      resolved.point,
      result,
      resolved.windowId,
    );
  }

  async rightClick(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const resolved = await this.resolvePointTarget(target);
    await this.prepareResolvedTarget(resolved);
    const result = await this.injectScoped("computer_right_click", resolved, () =>
      this.backend.rightClick(resolved.point),
    );
    return this.actionResult(
      threadId,
      "computer_right_click",
      resolved.point,
      result,
      resolved.windowId,
    );
  }

  async moveCursor(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const resolved = await this.resolvePointTarget(target);
    await this.prepareResolvedTarget(resolved);
    const result = await this.injectScoped("computer_move_cursor", resolved, () =>
      this.backend.moveCursor(resolved.point),
    );
    return this.actionResult(
      threadId,
      "computer_move_cursor",
      resolved.point,
      result,
      resolved.windowId,
    );
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
    // The drag is grabbed by the window it starts in, so that window is the one
    // raised and focused; the destination only scopes it when the origin names
    // no window at all.
    const grabbed = resolvedFrom.windowId ? resolvedFrom : resolvedTo;
    await this.prepareResolvedTarget(grabbed);
    const result = await this.injectScoped("computer_drag", grabbed, () =>
      this.backend.drag(resolvedFrom.point, resolvedTo.point, durationMs),
    );
    return this.actionResult(
      threadId,
      "computer_drag",
      resolvedTo.point,
      result,
      resolvedTo.windowId ?? resolvedFrom.windowId,
    );
  }

  async scroll(
    threadId: string | undefined,
    target: ComputerTarget | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const resolved = target ? await this.resolvePointTarget(target) : null;
    await this.prepareResolvedTarget(resolved ?? undefined);
    const result = await this.injectScoped("computer_scroll", resolved ?? {}, () =>
      this.backend.scroll(resolved?.point ?? null, deltaX, deltaY),
    );
    return this.actionResult(
      threadId,
      "computer_scroll",
      resolved?.point,
      result,
      resolved?.windowId,
    );
  }

  async typeText(
    threadId: string | undefined,
    text: string,
    windowId?: string,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    await this.prepareKeyboardTarget(windowId);
    const result = await this.backend.typeText(text);
    return this.actionResult(threadId, "computer_type_text", undefined, result, windowId);
  }

  async pressKey(
    threadId: string | undefined,
    key: string,
    windowId?: string,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    await this.prepareKeyboardTarget(windowId);
    const result = await this.backend.pressKey(key);
    return this.actionResult(threadId, "computer_press_key", undefined, result, windowId);
  }

  async hotkey(
    threadId: string | undefined,
    keys: readonly string[],
    windowId?: string,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    await this.prepareKeyboardTarget(windowId);
    const result = await this.backend.hotkey(keys);
    return this.actionResult(threadId, "computer_hotkey", undefined, result, windowId);
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
    await this.prepareResolvedTarget(semanticPointTarget(resolved));
    const result = await this.backend.setValue(resolved, value);
    return this.actionResult(
      threadId,
      "computer_set_value",
      resolved.point,
      result,
      resolved.node.windowId ?? undefined,
    );
  }

  async performAction(
    threadId: string | undefined,
    target: ComputerTarget,
    action: string,
  ): Promise<ComputerActionResult> {
    await this.claimDesktopControl(threadId);
    const resolved = await this.resolveSemanticTarget(target);
    await this.prepareResolvedTarget(semanticPointTarget(resolved));
    const result = await this.backend.performAction(resolved, action);
    return this.actionResult(
      threadId,
      "computer_perform_action",
      resolved.point,
      result,
      resolved.node.windowId ?? undefined,
    );
  }

  /**
   * Runs one agent tool call with this thread counted as driving the desktop.
   *
   * The count is kept whether or not this thread has a runtime record, because
   * the lease's in-flight guard reads it: while it was a field on the record,
   * every thread on a visible-desktop backend counted as idle from the first
   * call to the last, and the desktop could be taken from a thread in the
   * middle of a drag. Publishing the badge still requires a record, since a
   * thread nobody is watching has no panel to update.
   */
  async withAgentActivity<A>(threadId: string, action: () => Promise<A>): Promise<A> {
    const owner = agentThreadId(threadId);
    if (owner === undefined) return await action();
    const depth = (this.agentCallsInFlight.get(owner) ?? 0) + 1;
    this.agentCallsInFlight.set(owner, depth);
    if (depth === 1) await this.publish(owner, true).catch(() => undefined);
    try {
      return await action();
    } finally {
      const remaining = Math.max(0, (this.agentCallsInFlight.get(owner) ?? 1) - 1);
      if (remaining === 0) {
        this.agentCallsInFlight.delete(owner);
        await this.publish(owner, true).catch(() => undefined);
      } else {
        this.agentCallsInFlight.set(owner, remaining);
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
    if (changed) {
      await this.announceDrivingAgent(owner);
      // Both panels change: the new owner stops being blocked, and every other
      // thread starts being.
      await this.publishAllThreads();
    }
  }

  /**
   * Names the thread driving the desktop so a backend that draws an agent
   * cursor can label it. Best effort: a missing or failed label is a cosmetic
   * loss, and must never turn into a refused action.
   */
  private async announceDrivingAgent(threadId: string | null): Promise<void> {
    if (!this.backend.setDrivingAgent) return;
    const label = threadId === null ? null : (this.threadLabels.get(threadId) ?? null);
    await this.backend.setDrivingAgent(label).catch(() => undefined);
  }

  /**
   * The display name for a thread's agent cursor badge. Pushed in by the tool
   * layer, which is the only place that knows a thread's title, rather than
   * queried from here — the manager is built without any orchestration
   * dependency and reading a title on every action would put a database read
   * inside the lease claim.
   */
  setThreadLabel(threadId: string, label: string | null): void {
    const owner = agentThreadId(threadId);
    if (owner === undefined) return;
    const trimmed = label?.trim();
    if (trimmed) {
      if (this.threadLabels.get(owner) === trimmed) return;
      this.threadLabels.set(owner, trimmed);
    } else {
      if (!this.threadLabels.delete(owner)) return;
    }
    // Only when this thread is the one on screen; every other thread's label is
    // just recorded for whenever it takes the desktop.
    if (this.lease?.threadId === owner) void this.announceDrivingAgent(owner);
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
    await this.announceDrivingAgent(null);
    await this.publishAllThreads();
  }

  /**
   * Stale only once nothing is in flight: a call that is still running holds
   * the pointer or the keyboard right now, and elapsed time since it started
   * says nothing about whether it has finished.
   */
  private isLeaseStale(lease: DesktopLease, now: number): boolean {
    if (now - lease.lastActivityMs < this.leaseIdleMs) return false;
    return (this.agentCallsInFlight.get(lease.threadId) ?? 0) === 0;
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
    this.threadLabels.delete(threadId);
    // Deleted after the thread state, so the resulting publish cannot recreate
    // it: a removed thread must not reappear as a lease holder.
    await this.releaseDesktopControl(threadId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.windowsPublishTimer !== undefined) clearTimeout(this.windowsPublishTimer);
    this.windowsPublishTimer = undefined;
    this.windowsPublishPending = false;
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

  /**
   * Frames travel on the binary transport and nowhere else. A parallel
   * `computer.frame` notice on the JSON event channel used to be emitted here
   * too; its only consumer read the header and did nothing with it, so every
   * still frame paid for a serialized event that told no one anything.
   */
  private handleFrame(frame: ComputerStreamFrame): void {
    if (this.disposed || (!this.streamDesired && !this.streamAttached)) return;
    this.transport.publish(this.computerId, frame);
  }

  /**
   * Coordinates plus a window id are a window-scoped click: the point is
   * resolved exactly as a bare coordinate, and the window id only decides which
   * window is raised and receives the input. A label or role instead means the
   * coordinate is at most a hint, so those keep going through AT-SPI
   * resolution, which owns the final point.
   */
  private async resolvePointTarget(target: ComputerTarget): Promise<ResolvedPointTarget> {
    if (hasCoordinates(target) && !hasLabelFields(target)) {
      const point = await this.resolveCoordinatePoint(target);
      if (target.windowId === undefined) return { point };
      const covering = await this.scopedPointOcclusion(point, target.windowId);
      return { point, windowId: target.windowId, covering };
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
   * Checks a scoped coordinate against the window it names, and reports the
   * windows stacked above it that also contain the point.
   *
   * A scoped click is refused rather than redirected. Input is routed to the
   * named window regardless of what covers that coordinate, so a point outside
   * its bounds would deliver a click to a part of the window that does not
   * exist — the one failure mode scoping is meant to remove. The covering list
   * comes from the same window read, so the raise path downstream never has to
   * repeat it.
   */
  private async scopedPointOcclusion(
    point: ComputerPoint,
    windowId: string,
  ): Promise<readonly ComputerWindow[]> {
    const windows = await this.backend.listWindows();
    const window = windows.find((candidate) => candidate.id === windowId);
    if (!window) throw windowNotFoundError(windowId);
    const bounds = window.bounds;
    if (!bounds) {
      // Scoping exists to guarantee the point is inside the named window. A
      // display server with no geometry cannot answer that, and letting the
      // click through unchecked would silently drop the guarantee the caller
      // asked for by passing window_id at all.
      throw new ComputerTargetError({
        code: "computer_target_offscreen",
        message:
          `This desktop reports no geometry for window ${JSON.stringify(windowId)}, so a coordinate ` +
          "cannot be checked against it. Drop window_id to click whatever is topmost at that point, " +
          "or target the control by label instead.",
      });
    }
    if (!rectContainsPoint(bounds, point)) {
      throw new ComputerTargetError({
        code: "computer_target_offscreen",
        message:
          `Computer target (${point.x}, ${point.y}) is outside window ${JSON.stringify(windowId)}, ` +
          `which covers ${bounds.width}x${bounds.height} at (${bounds.x}, ${bounds.y}). ` +
          "Pass a coordinate inside those bounds, or drop window_id to click whatever is topmost.",
      });
    }
    return windowsCoveringPoint(windows, windowId, point);
  }

  /**
   * Raise before focus: focus alone routes the agent's input to a window that
   * may still be buried, which leaves the human watching clicks land on pixels
   * they cannot see. Both calls are optional so a backend that supports neither
   * keeps working.
   *
   * A raise this desktop cannot perform is not by itself a failed action — the
   * compositor still routes the agent's input to the named window — so it only
   * refuses when a different window really does cover the point, which is the
   * one case where proceeding would deliver the click somewhere the caller did
   * not ask for and could not see coming.
   */
  private async prepareResolvedTarget(target: PreparedTarget | undefined): Promise<void> {
    const windowId = target?.windowId;
    if (windowId === undefined) {
      await this.backend.clearFocusWindow?.();
      return;
    }
    const raiseFailure = await this.raiseTargetWindow(windowId);
    if (raiseFailure !== undefined && target?.point) {
      const covering = target.covering ?? (await this.coveringWindowsAt(target.point, windowId));
      if (covering.length > 0) {
        throw occludedTargetError(windowId, target.point, covering, raiseFailure);
      }
    }
    await this.backend.focusWindow?.(windowId);
  }

  /**
   * Points the agent seat's keyboard at a window before a keystroke, or leaves
   * focus alone when the caller named none.
   *
   * Keyboard input carries no coordinate to scope it, so without a window it
   * lands wherever the seat's focus already is — usually where the last click
   * put it, which is what a click-then-type sequence depends on. Focus is
   * therefore never cleared here; only an explicit window moves it, and a stale
   * id fails before any key is sent rather than typing into another application.
   */
  private async prepareKeyboardTarget(windowId: string | undefined): Promise<void> {
    if (windowId === undefined) return;
    const windows = await this.backend.listWindows();
    if (!windows.some((candidate) => candidate.id === windowId)) {
      throw windowNotFoundError(windowId);
    }
    await this.prepareResolvedTarget({ windowId });
  }

  /** The restack, or the reason this desktop did not perform one. */
  private async raiseTargetWindow(windowId: string): Promise<string | undefined> {
    const raise = this.backend.raiseWindow?.bind(this.backend);
    if (!raise) return "this backend exposes no stacking control";
    try {
      await raise(windowId);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  }

  /**
   * Runs a pointer injection that named a window, and replaces the desktop's
   * bare refusal with something the caller can act on.
   *
   * The compositor refuses instead of retargeting, so a refusal is the one
   * failure that guarantees nothing was delivered — worth saying, because the
   * caller's alternative reading is that the control is broken. It reports only
   * which call it declined, so the cause has to be supplied here.
   */
  private async injectScoped<T>(
    action: string,
    target: PreparedTarget,
    inject: () => Promise<T>,
  ): Promise<T> {
    try {
      return await inject();
    } catch (error) {
      const windowId = target.windowId;
      const point = target.point;
      if (windowId === undefined || !point) throw error;
      if (!(error instanceof ComputerBackendError) || error.rejectedOperation === undefined) {
        throw error;
      }
      throw refusedInjectionError(action, windowId, point);
    }
  }

  private async coveringWindowsAt(
    point: ComputerPoint,
    windowId: string,
  ): Promise<readonly ComputerWindow[]> {
    const windows = await this.backend.listWindows().catch(() => []);
    return windowsCoveringPoint(windows, windowId, point);
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

  /**
   * The window id is the one targeting resolved, so the result reports where
   * input was routed; a backend that reports its own window id wins, being
   * closer to what actually happened.
   */
  private actionResult(
    threadId: string | undefined,
    action: string,
    point: ComputerPoint | undefined,
    result: ComputerBackendActionResult | void,
    windowId?: string,
  ): ComputerActionResult {
    this.emitAction(threadId, action);
    return computerBackendActionResult(this.computerId, action, {
      ...(point ? { point } : {}),
      ...(windowId !== undefined ? { windowId } : {}),
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
    if (attributed) this.surfacePaneForAgent(attributed);
    this.emit({
      type: "computer.action",
      action,
      ok: true,
      ...(attributed ? { threadId: ThreadId.makeUnsafe(attributed) } : {}),
    });
  }

  /**
   * Put the desktop in front of the user the moment an agent starts driving it.
   * Emitted before the action event so the pane is already opening when the
   * first attributed action reaches the store. Mirrors
   * DeviceManager.requestOpenPane; see paneSurfaced for the once-per-thread
   * rule. On a visible-desktop backend the actions are already happening on the
   * human's own screen, so no pane is requested at all — mirroring their
   * display back at them adds nothing.
   *
   * The runtime record is still created in that case, before the decision: it
   * is what carries this thread's activity count and last error, and a thread
   * that drives the desktop needs one whether or not a pane is opened for it.
   */
  private surfacePaneForAgent(threadId: string): void {
    const state = this.threadRuntime(threadId);
    if (this.backendCapabilities.visibleDesktop || state.paneSurfaced) return;
    state.paneSurfaced = true;
    this.emit({
      type: "computer.open-pane-requested",
      threadId: ThreadId.makeUnsafe(threadId),
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
    this.publishAllDepth += 1;
    try {
      for (const threadId of this.threads.keys()) await this.publish(threadId, true);
    } finally {
      this.publishAllDepth -= 1;
      if (this.publishAllDepth === 0 && this.windowsPublishPending) {
        this.windowsPublishPending = false;
        this.scheduleWindowsPublish();
      }
    }
  }

  /**
   * Queue one republish for a window change, coalescing everything that arrives
   * before it runs — including the changes this pass's own window reads report,
   * which is the loop that made this necessary. A pass already running never
   * starts a second one on top of itself; it re-arms the timer on the way out.
   */
  private scheduleWindowsPublish(): void {
    if (this.disposed) return;
    if (this.publishAllDepth > 0) {
      this.windowsPublishPending = true;
      return;
    }
    if (this.windowsPublishTimer !== undefined) return;
    this.windowsPublishTimer = setTimeout(() => {
      this.windowsPublishTimer = undefined;
      if (this.disposed) return;
      void this.publishAllThreads().catch(() => undefined);
    }, this.windowsPublishDebounceMs);
    this.windowsPublishTimer.unref?.();
  }

  /**
   * Republish every thread from cached state. A backend health transition
   * changes what a panel must show but nothing the backend could tell us, and
   * querying it from the handler of the supervision loop's own event would put
   * a D-Bus round trip — and another connect attempt — on every failure the
   * loop reports, which is how a reconnect turns into a storm.
   */
  private republishAllThreads(): void {
    if (this.disposed) return;
    for (const [threadId, state] of this.threads) {
      state.version += 1;
      this.emit({ type: "computer.thread-state", state: this.threadSnapshot(threadId, state) });
    }
  }

  private threadRuntime(threadId: string): ThreadComputerRuntimeState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {
        version: 0,
        lastError: null,
        windows: [],
        screenSize: { width: 1, height: 1 },
        availability: {
          kind: "backend-unavailable",
          message: "Computer state has not been queried yet",
        },
        paneSurfaced: false,
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
      agentActive: (this.agentCallsInFlight.get(threadId) ?? 0) > 0,
      controlledByOtherThread: this.lease !== null && this.lease.threadId !== threadId,
      availability: this.correctedAvailability(state.availability),
      health: this.backendHealth,
      capabilities: this.backendCapabilities,
      lastError: state.lastError,
    };
  }

  /**
   * The last availability read, corrected by live backend health. The cached
   * value is whatever the last successful query said, so without this a panel
   * keeps being told the desktop is available while the supervision loop is
   * still trying to get it back. Only a claim of `available` is overridden:
   * anything already blocked carries its own, better explanation — the platform
   * it is running on, or the plugin it could not load.
   *
   * `awaiting-consent` is deliberately not an override either. The backend is
   * installed and reachable and nothing has failed; the desktop's own permission
   * dialog is simply unanswered. Reporting that as unavailable would hide the
   * one thing the user can act on behind a badge that says to give up.
   */
  private correctedAvailability(availability: ComputerAvailability): ComputerAvailability {
    if (
      this.backendHealth.status === "connected" ||
      this.backendHealth.status === "awaiting-consent" ||
      availability.kind !== "available"
    ) {
      return availability;
    }
    return { kind: "backend-unavailable", message: healthUnavailableMessage(this.backendHealth) };
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

/**
 * Why a healthy-looking availability is being withheld. The failure text comes
 * from the display server, so the whole message is clamped rather than only the
 * part this composes.
 */
function healthUnavailableMessage(health: ComputerHealth): string {
  const reason =
    health.status === "reconnecting"
      ? "Reconnecting to the desktop."
      : "The desktop backend is not connected.";
  return clampComputerMessage(
    health.lastFailure ? `${reason} Last failure: ${health.lastFailure.message}` : reason,
    reason,
  );
}

function windowNotFoundError(windowId: string): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_not_found",
    message:
      `No desktop window has id ${JSON.stringify(windowId)}. ` +
      "Call computer_list_windows for the current window ids.",
    notFound: true,
  });
}

/**
 * The raise/focus target for a control resolved through the accessibility tree.
 * The point comes along so a failed raise is still checked for occlusion:
 * nothing consulted the stacking order while matching the label, and the click
 * that follows is as misroutable as any other.
 */
function semanticPointTarget(resolved: ComputerResolvedTarget): PreparedTarget {
  return {
    point: resolved.point,
    ...(resolved.node.windowId ? { windowId: resolved.node.windowId } : {}),
  };
}

/**
 * Refusal for a scoped action whose window is covered at the point and could
 * not be raised out from under the windows covering it.
 *
 * Refusing beats warning. The input would land in another application, and a
 * warning read after the fact cannot undo a click that already fired — the live
 * failure this exists for was a model clicking a buried window repeatedly and
 * concluding the button was broken. The message names what is in the way and
 * both ways out, so the next call is a correct one rather than a retry.
 */
function occludedTargetError(
  windowId: string,
  point: ComputerPoint,
  covering: readonly ComputerWindow[],
  reason: string,
): ComputerTargetError {
  const blockers = covering
    .slice(0, 4)
    .map((window) => `${JSON.stringify(window.title || window.id)} (${window.id})`)
    .join(", ");
  return new ComputerTargetError({
    code: "computer_target_occluded",
    message:
      `Window ${JSON.stringify(windowId)} is covered at (${point.x}, ${point.y}) by ${blockers}, ` +
      `and this desktop could not raise it: ${reason}. The input would go to the covering window. ` +
      "Aim at a part of the target window that nothing covers, or move the covering window out of " +
      "the way first; or drop window_id to act on whatever is topmost at that point.",
  });
}

/**
 * Refusal for a scoped pointer action the desktop declined to deliver.
 *
 * A coordinate is validated against the window's frame, which includes the
 * invisible resize and shadow margins around it, so a point can sit inside
 * those bounds and still be outside the region the window accepts input in.
 * The window may equally have closed since it was listed. Either way the
 * remedy is the same, and it is not retrying the identical coordinate.
 */
function refusedInjectionError(
  action: string,
  windowId: string,
  point: ComputerPoint,
): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_refused",
    message:
      `The desktop refused to deliver ${action} to window ${JSON.stringify(windowId)} at ` +
      `(${point.x}, ${point.y}), so no input was sent. The window is not accepting input at that ` +
      "point: a window's bounds include invisible resize and shadow margins, and the window may " +
      "also have closed since it was listed. Aim nearer the middle of the control, target it by " +
      "label instead of a coordinate, or drop window_id to act on whatever is topmost there.",
  });
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
