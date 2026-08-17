/**
 * Tier 2: one backend for every non-KDE Wayland desktop.
 *
 * Tier 1 proved that the bulk of a computer backend is not display-server
 * specific — supervision, health accounting, capture serialization, glide
 * timing, stroke sequencing, region/scale math — so this class owns all of it
 * once and delegates only four things to providers the probe resolved at
 * construction: input, capture, windows, clipboard. GNOME supplies them through
 * portals plus a Shell extension, wlroots through unprivileged protocols; this
 * class does not know which.
 *
 * Two rules run through the whole file.
 *
 * **Degrade honestly, never silently.** Every capability-gated path goes
 * through `requireProvider`, which refuses with a non-retryable error naming
 * the missing piece and what to do about it. Nothing here returns an empty
 * window list, a blank screenshot, or a silent success — an agent cannot tell
 * those from the real thing, and the E2E runs showed exactly what it does when
 * it cannot: it relaunches the same app until the turn ends.
 *
 * **A missing grant is not unavailable.** The desktop's own consent dialog is
 * a user action, not a fault. Availability stays `available` while consent is
 * outstanding and health reports `awaiting-consent`, because an `unavailable`
 * badge hides the one thing the user has to do. A denial latches: it is never
 * retried automatically, exactly like the Tier 1 release-hotkey latch.
 */
import { spawn, type ChildProcess } from "node:child_process";

import type {
  ComputerAvailability,
  ComputerCapabilities,
  ComputerHealth,
  ComputerId,
  ComputerLaunchAppResult,
  ComputerPoint,
  ComputerRect,
  ComputerScreenSize,
  ComputerScreenshot,
  ComputerState,
  ComputerWindow,
} from "@synara/contracts";

import {
  ComputerBackendError,
  intersectComputerRects,
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  MAX_COMPUTER_CLIPBOARD_BYTES,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerBackendEvent,
  type ComputerBackendEventListener,
  type ComputerCaptureRequest,
  type ComputerFrameListener,
  type ComputerResolvedTarget,
} from "../ComputerBackend.ts";
import {
  alignRect,
  formatRect,
  requireWindowBounds,
  screenshotFromPng,
} from "../computerGeometry.ts";
import { ComputerHealthState } from "../computerHealthState.ts";
import { EVDEV_BUTTON_CODES, keyStrokeForKey, qwertyTextKeyStrokes } from "../evdevInput.ts";
import {
  glidePointerToDeadline,
  POINTER_SEQUENCE_OPERATIONS,
  pressButtonOnce,
  pressHotkeyStrokes,
  pressKeyStroke,
} from "../pointerSequencing.ts";
import { planPortalProviders, type PortalProbe, type PortalProviderPlan } from "./probe.ts";
import {
  missingProvider,
  requireProvider,
  type PortalProviders,
  type ProviderSlot,
} from "./providers.ts";

const DEFAULT_COMPUTER_ID = "primary" as ComputerId;
const DEFAULT_GLIDE_DURATION_MS = 180;
const DEFAULT_STILL_INTERVAL_MS = 500;
/** Names this backend in a capture failure, which reaches a tool call verbatim. */
const CAPTURE_SOURCE = "Synara portal capture";

/**
 * Where the desktop's permission dialog stands.
 *
 * `denied` is terminal until a user action clears it. Retrying a denied grant
 * re-raises the dialog the user just dismissed, which is indistinguishable from
 * an application that will not take no for an answer.
 */
export type PortalConsentState =
  | "not-required"
  | "not-requested"
  | "awaiting"
  | "granted"
  | "denied";

export interface PortalComputerBackendOptions {
  readonly computerId?: string;
  readonly probe: PortalProbe;
  readonly providers: PortalProviders;
  readonly platform?: string;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly spawnProcess?: (app: string, args: readonly string[]) => ChildProcess;
  readonly glideDurationMs?: number;
  readonly stillIntervalMs?: number;
  readonly captureMaxDimension?: number;
  /**
   * Whether this desktop needs a consent dialog at all. wlroots grants nothing
   * and prompts for nothing, so its consent state starts and stays
   * `not-required`; GNOME's portal starts at `not-requested`.
   */
  readonly consent?: PortalConsentState;
}

export class PortalComputerBackend implements ComputerBackend {
  readonly computerId: ComputerId;

  private readonly probe: PortalProbe;
  private readonly plan: PortalProviderPlan;
  private readonly providers: PortalProviders;
  private readonly platform: string;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly spawnProcess: (app: string, args: readonly string[]) => ChildProcess;
  private readonly glideDurationMs: number;
  private readonly stillIntervalMs: number;
  private readonly captureMaxDimension: number;
  private readonly healthState: ComputerHealthState;
  private readonly capabilitySet: ComputerCapabilities;
  private readonly eventListeners = new Set<ComputerBackendEventListener>();

  private consent: PortalConsentState;
  private consentReason: string | undefined;
  private disposed = false;
  private currentPoint: ComputerPoint | null = null;
  private streamListener: ComputerFrameListener | undefined;
  private streamTimer: ReturnType<typeof setInterval> | undefined;
  private stillInFlight = false;
  private nextSequence = 1;

  constructor(options: PortalComputerBackendOptions) {
    this.computerId = (options.computerId ?? DEFAULT_COMPUTER_ID) as ComputerId;
    this.probe = options.probe;
    this.plan = planPortalProviders(options.probe);
    this.providers = options.providers;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
    this.spawnProcess =
      options.spawnProcess ??
      ((app, args) => spawn(app, [...args], { detached: true, stdio: "ignore" }));
    this.glideDurationMs = Math.max(0, options.glideDurationMs ?? DEFAULT_GLIDE_DURATION_MS);
    this.stillIntervalMs = Math.max(100, options.stillIntervalMs ?? DEFAULT_STILL_INTERVAL_MS);
    this.captureMaxDimension = Math.max(
      1,
      Math.min(
        32_768,
        Math.floor(options.captureMaxDimension ?? DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION),
      ),
    );
    this.consent =
      options.consent ?? (options.probe.portal.present ? "not-requested" : "not-required");
    this.capabilitySet = capabilitiesFromProviders(options.providers);
    this.healthState = new ComputerHealthState({
      readStatus: () => ({
        status: this.healthStatus(),
        captureAvailable: this.providers.capture.available,
      }),
      emit: (health) => this.emit({ type: "health-changed", health }),
      now: () => this.now(),
      failureFallbackMessage: "The Synara portal backend failed without a message.",
    });
  }

  /**
   * What resolved, not what the desktop might manage. A capability derived from
   * the probe rather than from a live provider would promise a tool that then
   * refuses, and the panel badge and tool descriptions read this to decide what
   * to offer.
   */
  capabilities(): ComputerCapabilities {
    return this.capabilitySet;
  }

  /**
   * The provider each capability would use on this desktop, and why any of them
   * is blocked. Read by the availability copy and exposed for diagnostics; the
   * decision itself is a pure function of the probe.
   */
  providerPlan(): PortalProviderPlan {
    return this.plan;
  }

  async availability(): Promise<ComputerAvailability> {
    if (this.platform !== "linux") {
      return { kind: "unsupported-platform", platform: this.platform };
    }
    if (this.probe.sessionType !== "wayland") {
      return {
        kind: "backend-unavailable",
        message:
          this.probe.sessionType === ""
            ? "Linux computer control requires a graphical session, and this server is not in one."
            : `Linux computer control requires a Wayland session; this is an ${this.probe.sessionType} session.`,
      };
    }
    // Perception and action are the floor: a desktop that can supply neither is
    // not a desktop Synara can drive, whatever else resolved. Windows and
    // clipboard missing is a degraded but usable backend — the agent works in
    // desktop coordinates — so it does not fail availability, only capability.
    const blockers = [
      describeSlot("Input", this.providers.input),
      describeSlot("Screen capture", this.providers.capture),
    ].filter((message): message is string => message !== undefined);
    if (blockers.length > 0) {
      return { kind: "backend-unavailable", message: blockers.join(" ") };
    }
    return { kind: "available", backend: "portal" };
  }

  /**
   * Health as the supervision path already knows it: no D-Bus call, no probe.
   * `awaiting-consent` outranks everything else that is true at the same time,
   * because it is the only state whose remedy is a user action rather than a
   * retry, and a panel that showed `reconnecting` instead would have the user
   * waiting on a dialog nobody is going to answer.
   */
  health(): ComputerHealth {
    return this.healthState.health();
  }

  /** Where the desktop's permission dialog stands, and why if it is not moving. */
  consentState(): { readonly state: PortalConsentState; readonly reason?: string } {
    return this.consentReason === undefined
      ? { state: this.consent }
      : { state: this.consent, reason: this.consentReason };
  }

  /**
   * Moves the consent state and republishes health.
   *
   * A denial latches here rather than at the call site so every path that can
   * see one — the first mutating action, the first pane attach, a restore token
   * that stopped working — latches identically.
   */
  setConsentState(state: PortalConsentState, reason?: string): void {
    if (this.consent === "denied" && state !== "not-requested") return;
    this.consent = state;
    this.consentReason = reason;
    this.healthState.publish();
  }

  async listWindows(): Promise<readonly ComputerWindow[]> {
    this.throwIfDisposed();
    const provider = requireProvider(this.providers.windows, "Listing windows");
    return await provider.listWindows();
  }

  async getScreenSize(): Promise<ComputerScreenSize> {
    this.throwIfDisposed();
    const rect = await this.workspaceRect();
    return { width: rect.width, height: rect.height, scale: 1 };
  }

  /**
   * Full perception. Requires the window provider even though the screenshot
   * alone would be useful, because `ComputerState.windows` is a required array
   * with no way to express "unknown": filling it with `[]` on a desktop that
   * cannot enumerate is precisely the lie this tier is built to avoid. The
   * coordinate-only workflow on such a desktop is `getScreenSize` plus
   * `captureScreenshot({ kind: "region" })`, neither of which needs windows.
   */
  async getState(options: {
    readonly includeScreenshot?: boolean;
    readonly includeText?: boolean;
  }): Promise<ComputerState> {
    this.throwIfDisposed();
    const windows = await this.listWindows();
    const rect = await this.workspaceRect();
    const screenshot = options.includeScreenshot
      ? await this.captureRect(rect, this.captureMaxDimension)
      : undefined;
    return {
      computerId: this.computerId,
      windows,
      screenSize: { width: rect.width, height: rect.height, scale: 1 },
      ...(screenshot ? { screenshot } : {}),
      capturedAt: new Date(this.now()).toISOString(),
    };
  }

  async captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot> {
    this.throwIfDisposed();
    const maxDimension = Math.max(
      1,
      Math.min(32_768, Math.floor(request.maxDimension ?? this.captureMaxDimension)),
    );
    if (request.kind === "window") {
      const windows = await this.listWindows();
      const window = windows.find((candidate) => candidate.id === request.windowId);
      if (!window) {
        throw new ComputerBackendError(
          `No window with id ${JSON.stringify(request.windowId)} is open.`,
        );
      }
      return await this.captureRect(
        requireWindowBounds(window, "a window screenshot"),
        maxDimension,
      );
    }
    return await this.captureRect(request.region, maxDimension);
  }

  async launchApp(app: string, args: readonly string[]): Promise<ComputerLaunchAppResult> {
    this.throwIfDisposed();
    const child = this.spawnProcess(app, args);
    child.unref?.();
    await new Promise<void>((resolve, reject) => {
      const settle = () => {
        child.off("error", onError);
        child.off("spawn", onSpawn);
      };
      const onError = (error: Error) => {
        settle();
        reject(
          new ComputerBackendError(`Launching ${app} failed: ${error.message}`, { cause: error }),
        );
      };
      const onSpawn = () => {
        settle();
        resolve();
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    // The window is reported only where enumeration exists. `null` here means
    // "not looked up", which `capabilities.windows === false` already says; the
    // alternative — refusing the launch — would remove a capability that works.
    return { computerId: this.computerId, app, window: null };
  }

  async click(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    return await this.clickWithButton(point, EVDEV_BUTTON_CODES.left, 1);
  }

  async doubleClick(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    return await this.clickWithButton(point, EVDEV_BUTTON_CODES.left, 2);
  }

  async rightClick(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    return await this.clickWithButton(point, EVDEV_BUTTON_CODES.right, 1);
  }

  async moveCursor(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    await this.glidePointer(point, this.glideDurationMs);
    return { point };
  }

  async drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
  ): Promise<ComputerBackendActionResult> {
    const input = this.requireInput("Dragging");
    await this.glidePointer(from, this.glideDurationMs);
    await input.sink.button(EVDEV_BUTTON_CODES.left, true, POINTER_SEQUENCE_OPERATIONS.buttonPress);
    try {
      await this.glidePointer(to, durationMs);
    } finally {
      await input.sink.button(
        EVDEV_BUTTON_CODES.left,
        false,
        POINTER_SEQUENCE_OPERATIONS.buttonRelease,
      );
    }
    return { point: to };
  }

  async scroll(
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerBackendActionResult> {
    const input = this.requireInput("Scrolling");
    if (point) await this.glidePointer(point, this.glideDurationMs);
    await input.scroll(deltaX, deltaY);
    return point ? { point } : {};
  }

  async typeText(text: string): Promise<ComputerBackendActionResult> {
    const input = this.requireInput("Typing");
    for (const stroke of qwertyTextKeyStrokes(text)) {
      this.throwIfDisposed();
      await pressKeyStroke({ sink: input.sink, stroke });
    }
    return {};
  }

  async pressKey(key: string): Promise<ComputerBackendActionResult> {
    const input = this.requireInput("Pressing a key");
    await pressKeyStroke({ sink: input.sink, stroke: keyStrokeForKey(key) });
    return {};
  }

  async hotkey(keys: readonly string[]): Promise<ComputerBackendActionResult> {
    const input = this.requireInput("Pressing a hotkey");
    await pressHotkeyStrokes({ sink: input.sink, strokes: keys.map(keyStrokeForKey) });
    return {};
  }

  async focusWindow(windowId: string): Promise<void> {
    const provider = requireProvider(this.providers.windows, "Focusing a window");
    if (!provider.activateWindow) {
      throw new ComputerBackendError(
        `This desktop's window provider (${provider.id}) reports windows but cannot activate them, ` +
          "so keyboard focus cannot be moved to a window. Type after clicking into the window instead.",
        { retryable: false },
      );
    }
    await provider.activateWindow(windowId);
  }

  async raiseWindow(windowId: string): Promise<void> {
    const provider = requireProvider(this.providers.windows, "Raising a window");
    if (!provider.raiseWindow) {
      throw new ComputerBackendError(
        `This desktop's window provider (${provider.id}) exposes no stacking control, so a window ` +
          "cannot be raised above the ones covering it. Activate it instead, which may also move the human's focus.",
        { retryable: false },
      );
    }
    await provider.raiseWindow(windowId);
  }

  async readClipboard(): Promise<string> {
    const provider = requireProvider(this.providers.clipboard, "Reading the clipboard");
    const text = await provider.read();
    return clampClipboard(text);
  }

  async writeClipboard(text: string): Promise<void> {
    const provider = requireProvider(this.providers.clipboard, "Writing the clipboard");
    await provider.write(clampClipboard(text));
  }

  /**
   * Semantic targeting has no provider slot because it is not a display-server
   * capability: AT-SPI is a separate bus service and is wired per phase. Until
   * then a label-targeted action refuses by name rather than silently becoming
   * a click at whatever coordinate the resolver guessed.
   */
  setValue(target: ComputerResolvedTarget, _value: string): Promise<never> {
    return Promise.reject(this.unsupportedSemanticAction("Setting a value", target));
  }

  performAction(target: ComputerResolvedTarget, action: string): Promise<never> {
    return Promise.reject(this.unsupportedSemanticAction(`The ${action} action`, target));
  }

  onEvent(listener: ComputerBackendEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async attachStream(listener: ComputerFrameListener): Promise<void> {
    this.throwIfDisposed();
    // Fail before subscribing rather than after: a pane that attaches to a
    // stream that can never produce a frame shows a spinner with no error.
    requireProvider(this.providers.capture, "Streaming the screen");
    if (this.streamTimer !== undefined) clearInterval(this.streamTimer);
    this.streamListener = listener;
    await this.publishStillFrame();
    this.streamTimer = setInterval(() => {
      void this.publishStillFrame();
    }, this.stillIntervalMs);
    this.streamTimer.unref?.();
  }

  detachStream(): Promise<void> {
    this.streamListener = undefined;
    if (this.streamTimer !== undefined) clearInterval(this.streamTimer);
    this.streamTimer = undefined;
    return Promise.resolve();
  }

  async requestKeyframe(): Promise<void> {
    if (!this.streamListener) return;
    await this.publishStillFrame();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.detachStream();
    // Disposal order does not matter between providers, but a provider that
    // throws must not strand the others: the portal session and the EIS fd are
    // the kill switch, so every one of them gets its chance to close.
    const slots = [
      this.providers.input,
      this.providers.capture,
      this.providers.windows,
      this.providers.clipboard,
    ];
    await Promise.allSettled(
      slots.map((slot) => (slot.available ? slot.provider.dispose() : Promise.resolve())),
    );
    this.eventListeners.clear();
  }

  private healthStatus(): ComputerHealth["status"] {
    if (this.consent === "awaiting") return "awaiting-consent";
    if (this.consent === "denied") return "unavailable";
    return this.providers.input.available && this.providers.capture.available
      ? "connected"
      : "unavailable";
  }

  private requireInput(attempted: string) {
    this.throwIfDisposed();
    return requireProvider(this.providers.input, attempted);
  }

  private async clickWithButton(
    point: ComputerPoint,
    code: number,
    times: number,
  ): Promise<ComputerBackendActionResult> {
    const input = this.requireInput("Clicking");
    await this.glidePointer(point, this.glideDurationMs);
    for (let index = 0; index < times; index += 1) {
      await pressButtonOnce({ sink: input.sink, code, sleep: this.sleep });
    }
    return { point };
  }

  private async glidePointer(to: ComputerPoint, durationMs: number): Promise<void> {
    const input = this.requireInput("Moving the pointer");
    const from = this.currentPoint ?? (await input.pointerPosition?.()) ?? to;
    await glidePointerToDeadline({
      sink: input.sink,
      from,
      to,
      durationMs,
      now: () => this.now(),
      sleep: this.sleep,
      beforeStep: () => this.throwIfDisposed(),
      onStep: (point) => {
        this.currentPoint = point;
      },
    });
    this.currentPoint = to;
  }

  private async workspaceRect(): Promise<ComputerRect> {
    const provider = requireProvider(this.providers.capture, "Reading the screen size");
    return alignRect(await provider.workspaceRect());
  }

  private async captureRect(
    region: ComputerRect,
    maxDimension: number,
  ): Promise<ComputerScreenshot> {
    const provider = requireProvider(this.providers.capture, "Capturing the screen");
    const workspace = alignRect(await provider.workspaceRect());
    const requested = alignRect(region);
    const clipped = intersectComputerRects(requested, workspace);
    if (!clipped) {
      throw new ComputerBackendError(
        `The requested capture region ${formatRect(requested)} lies outside the desktop ${formatRect(workspace)}.`,
      );
    }
    const captured = await provider.captureRegion(clipped, maxDimension);
    return screenshotFromPng({
      bytes: captured.bytes,
      region: captured.region,
      capturedAt: new Date(this.now()).toISOString(),
      source: CAPTURE_SOURCE,
    });
  }

  private async publishStillFrame(): Promise<void> {
    const listener = this.streamListener;
    if (!listener || this.disposed || this.stillInFlight) return;
    this.stillInFlight = true;
    try {
      const rect = await this.workspaceRect();
      const screenshot = await this.captureRect(rect, this.captureMaxDimension);
      if (this.streamListener !== listener) return;
      const frame = {
        sequence: this.nextSequence++,
        timestampMs: this.now(),
        // Every frame is a complete PNG still, as in Tier 1: there is no codec
        // config or delta frame, so the envelope stays keyframe-only.
        keyframe: true,
        codecConfig: false,
        data: Uint8Array.from(Buffer.from(screenshot.bytesBase64, "base64")),
      };
      listener(frame);
      this.emit({ type: "frame", frame });
    } catch {
      // A transient capture failure must not tear down a subscribed stream.
    } finally {
      this.stillInFlight = false;
    }
  }

  private unsupportedSemanticAction(
    attempted: string,
    target: ComputerResolvedTarget,
  ): ComputerBackendError {
    return new ComputerBackendError(
      `${attempted} on ${JSON.stringify(target.node.label ?? target.node.role)} needs accessibility-tree access, ` +
        "which the portal backend does not wire up yet. Click the control at its coordinates instead.",
      { retryable: false },
    );
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new ComputerBackendError("The portal computer backend has been disposed.");
    }
  }

  private emit(event: ComputerBackendEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

/**
 * Capabilities from what resolved, plus the two questions only the window
 * provider can answer. `sharedSeat` comes off the input provider rather than
 * being assumed true for the tier, because it is what the panel's
 * shared-control warning keys off and getting it wrong in either direction
 * misleads the user about whose cursor is moving.
 */
export function capabilitiesFromProviders(providers: PortalProviders): ComputerCapabilities {
  const windows = providers.windows.available ? providers.windows.provider : undefined;
  const input = providers.input.available ? providers.input.provider : undefined;
  return {
    windows: windows !== undefined,
    windowBounds: windows?.providesBounds === true,
    stacking: windows?.providesStacking === true,
    capture: providers.capture.available,
    input: input !== undefined,
    clipboard: providers.clipboard.available,
    activation: windows?.activateWindow !== undefined || windows?.raiseWindow !== undefined,
    // No Tier 2 mechanism can draw a second pointer: there is no second seat on
    // a portal or wlroots desktop, and a layer-shell marker is decoration.
    ghostCursor: false,
    sharedSeat: input?.sharedSeat === true,
  };
}

/**
 * The providers a probe resolves today.
 *
 * The selection itself is real and lives in `planPortalProviders`; what is not
 * real yet is construction, because the libei, PipeWire, and wlroots providers
 * land in later phases. Each slot therefore carries the sentence the plan
 * produced — which names the provider this desktop *would* use and the phase it
 * arrives in, or the package that is actually missing — so a user is never told
 * "unsupported" when the true answer is "not written yet" or "install this".
 */
export function resolvePortalProviders(probe: PortalProbe): PortalProviders {
  const plan = planPortalProviders(probe);
  const slot = <T>(blockedBy: string | undefined): ProviderSlot<T> =>
    missingProvider<T>(blockedBy ?? "No provider is wired up for this capability yet.");
  return {
    input: slot(plan.input.blockedBy),
    capture: slot(plan.capture.blockedBy),
    windows: slot(plan.windows.blockedBy),
    clipboard: slot(plan.clipboard.blockedBy),
  };
}

/** Builds the Tier 2 backend for an already-probed desktop. */
export function createPortalComputerBackend(
  probe: PortalProbe,
  options: Omit<PortalComputerBackendOptions, "probe" | "providers"> & {
    readonly providers?: PortalProviders;
  } = {},
): PortalComputerBackend {
  const { providers, ...rest } = options;
  return new PortalComputerBackend({
    ...rest,
    probe,
    providers: providers ?? resolvePortalProviders(probe),
  });
}

function describeSlot(capability: string, slot: ProviderSlot<unknown>): string | undefined {
  return slot.available ? undefined : `${capability} is unavailable. ${slot.reason}`;
}

/**
 * Clipboards hold whole documents, so both directions need a ceiling: without
 * one a read would stream unbounded data into a turn and a write would pipe it
 * back out.
 */
function clampClipboard(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_COMPUTER_CLIPBOARD_BYTES) return text;
  return bytes.subarray(0, MAX_COMPUTER_CLIPBOARD_BYTES).toString("utf8");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
