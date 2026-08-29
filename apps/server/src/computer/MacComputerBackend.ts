import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  COMPUTER_MAC_BACKEND,
  type ComputerAvailability,
  type ComputerCapabilities,
  type ComputerHealth,
  type ComputerId,
  type ComputerLaunchAppResult,
  type ComputerPoint,
  type ComputerRect,
  type ComputerScreenshot,
  type ComputerScreenSize,
  type ComputerState,
  type ComputerUiNode,
  type ComputerWindow,
} from "@synara/contracts";

import {
  clampComputerMessage,
  ComputerBackendError,
  DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION,
  intersectComputerRects,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerBackendEventListener,
  type ComputerCaptureRequest,
  type ComputerFrameListener,
  type ComputerResolvedTarget,
} from "./ComputerBackend.ts";
import {
  alignRect,
  asFiniteNumber,
  asRecord,
  asString,
  formatRect,
  readPngDimensions,
  requireWindowBounds,
  screenSizeFromWindows,
  screenshotFromPng,
  shiftRect,
  workspaceRectFromWindows,
  parseWindows,
  windowInAgentSpace,
} from "./computerGeometry.ts";
import { describeComputerUiTree } from "./atspiTreeTargeting.ts";
import { ComputerHealthState } from "./computerHealthState.ts";
import {
  MacComputerHelperClient,
  MAC_HELPER_METHODS,
  type MacComputerHelperClientOptions,
  type MacHelperTransport,
} from "./macComputerHelperClient.ts";
import {
  MacComputerHelperProvisioner,
  MacHelperBuildError,
  resolveComputerHelperSourceDir,
  type ProcessRunResult,
} from "./macComputerHelperProvisioning.ts";
import { parseMacUiForest } from "./macUiTree.ts";

const DEFAULT_COMPUTER_ID = "desktop";
const DEFAULT_STILL_INTERVAL_MS = 500;
const DEFAULT_DRAG_DURATION_MS = 220;
const UNSUPPORTED_MACOS_MESSAGE =
  "Synara computer control on this host requires macOS with a full Xcode install to build the " +
  "native helper; no Xcode toolchain was found. Install Xcode and run " +
  "`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.";

const execFileAsync = promisify(execFile);

/**
 * Runs a subprocess to completion, capturing stdout/stderr and never throwing
 * on a non-zero exit — the provisioner reads the code. A spawn failure (no such
 * binary, as on a Linux CI host asked about Xcode) rejects, which every caller
 * already treats as "tooling absent".
 */
const runProcess: MacHelperRun = async (command, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      timeout: options.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      ...(options.env ? { env: options.env } : {}),
    });
    return { code: 0, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (error) {
    const record = asRecord(error);
    if (typeof record.code === "number") {
      return {
        code: record.code,
        stdout: typeof record.stdout === "string" ? record.stdout : "",
        stderr: typeof record.stderr === "string" ? record.stderr : "",
      };
    }
    throw error;
  }
};

type MacHelperRun = (
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly env?: NodeJS.ProcessEnv },
) => Promise<ProcessRunResult>;

export interface MacComputerBackendOptions {
  readonly computerId?: string;
  /** Overridden in tests; defaults to `process.platform`. */
  readonly platform?: string;
  /** Absolute path to `apps/server/native/computer-use-macos`; resolved when omitted. */
  readonly helperSourceDir?: string;
  readonly helperCacheRoot?: string;
  readonly now?: () => number;
  readonly stillIntervalMs?: number;
  readonly captureMaxDimension?: number;
  /** Subprocess runner for the toolchain probe and build; injected in tests. */
  readonly run?: MacHelperRun;
  /**
   * Builds the helper client around a binary path. Injected so a test can hand
   * back a fake transport without a real Mach-O on disk. The default constructs
   * the real `MacComputerHelperClient`.
   */
  readonly makeHelperClient?: (options: MacComputerHelperClientOptions) => MacHelperTransport;
  /**
   * Resolves the binary the helper client will spawn. Injected so tests skip
   * the compile entirely; the default is the provisioner's build-or-cache.
   */
  readonly resolveBinary?: () => Promise<string>;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * macOS implementation of the computer backend — the Codex-style "computer use"
 * ported onto Synara's `ComputerBackend` contract.
 *
 * The load-bearing facts, all confirmed by the reverse-engineering research in
 * `docs/computer-use-macos-reference.md`:
 *
 * - The "second cursor" is a picture the native helper draws, not a real
 *   pointer. macOS has one system cursor and the agent never touches it.
 * - Input is delivered by posting a synthetic event to the **target process**
 *   with `CGEventSetWindowLocation` stamping window-local coordinates, so the
 *   event never enters the HID stream that would warp the human's pointer.
 * - Perception is AX-first (structure) with a screenshot (pixels) alongside.
 *
 * All of that lives in the native helper; this class is the same thin
 * orchestration layer the KWin backend is — coordinate translation into the
 * agent's 0-based space, health supervision, still-frame publishing, and the
 * lazy build-and-spawn of the helper on first real use. Nothing here touches a
 * desktop at construction time, so it is safe to build at boot on every host.
 */
export class MacComputerBackend implements ComputerBackend {
  readonly computerId: ComputerId;

  private readonly platform: string;
  private readonly now: () => number;
  private readonly stillIntervalMs: number;
  private readonly captureMaxDimension: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly provisioner: MacComputerHelperProvisioner;
  private readonly makeHelperClient: (
    options: MacComputerHelperClientOptions,
  ) => MacHelperTransport;
  private readonly resolveBinary: () => Promise<string>;
  private readonly healthState: ComputerHealthState;

  private helper: MacHelperTransport | undefined;
  private helperPromise: Promise<MacHelperTransport> | undefined;
  private binaryPromise: Promise<string> | undefined;
  private disposed = false;
  private drivingAgent: string | null = null;
  /** True once `capabilities` reports Screen Recording granted; drives `health.captureAvailable`. */
  private captureGranted = false;
  private buildFailure: string | undefined;

  /** Last known global-space workspace origin, so pointer/capture translate without a fresh read. */
  private lastOrigin: ComputerPoint = { x: 0, y: 0 };
  private lastWorkspaceGlobal: ComputerRect | undefined;

  private streamListener: ComputerFrameListener | undefined;
  private streamTimer: ReturnType<typeof setInterval> | undefined;
  private stillInFlight = false;
  private nextSequence = 1;
  private previousWindowsFingerprint: string | undefined;
  private readonly eventListeners = new Set<ComputerBackendEventListener>();

  constructor(options: MacComputerBackendOptions = {}) {
    this.computerId = (options.computerId ?? DEFAULT_COMPUTER_ID) as ComputerId;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.stillIntervalMs = Math.max(100, options.stillIntervalMs ?? DEFAULT_STILL_INTERVAL_MS);
    this.captureMaxDimension = Math.max(
      1,
      Math.min(
        32_768,
        Math.floor(options.captureMaxDimension ?? DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION),
      ),
    );
    this.env = options.env ?? process.env;
    const run = options.run ?? runProcess;
    const helperSourceDir =
      options.helperSourceDir ?? resolveComputerHelperSourceDir(import.meta.dirname);
    this.provisioner = new MacComputerHelperProvisioner({
      helperSourceDir,
      ...(options.helperCacheRoot ? { helperCacheRoot: options.helperCacheRoot } : {}),
      run,
      env: this.env,
    });
    this.makeHelperClient =
      options.makeHelperClient ?? ((clientOptions) => new MacComputerHelperClient(clientOptions));
    this.resolveBinary = options.resolveBinary ?? (() => this.provisioner.ensureBinary());
    this.healthState = new ComputerHealthState({
      readStatus: () => ({
        status: this.helper?.running ? "connected" : "unavailable",
        captureAvailable: this.captureGranted,
      }),
      emit: (health) => this.emit({ type: "health-changed", health }),
      now: () => this.now(),
      failureFallbackMessage: "The Synara macOS computer backend failed without a message.",
    });
  }

  /**
   * The macOS Tier-1 capability set. The native helper enumerates windows with
   * `CGWindowList` geometry and stacking, captures with ScreenCaptureKit, posts
   * input to target processes, reads and writes `NSPasteboard`, raises windows
   * through AX, and draws the Software Cursor overlay — so every capability is
   * true. `capture` being true is the capability's existence; whether the live
   * Screen Recording grant is present rides on `health.captureAvailable`.
   */
  capabilities(): ComputerCapabilities {
    return {
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      activation: true,
      ghostCursor: true,
      visibleDesktop: true,
    };
  }

  /**
   * "Could this Mac drive its desktop?", answered without spawning the helper.
   *
   * Two ways to be available, both cheap: a helper binary is already cached for
   * this toolchain, or a full Xcode is present so one can be built on first use.
   * Neither builds anything, reads a TCC grant, or starts a process that
   * outlives the call — which matters because this runs at boot for every user.
   * Optimism is intended: a yes that later cannot provision costs one error card
   * at first use; a no costs the user the feature.
   */
  async probeAvailability(): Promise<ComputerAvailability> {
    if (this.platform !== "darwin") {
      return { kind: "unsupported-platform", platform: this.platform };
    }
    if (this.buildFailure) {
      return { kind: "backend-unavailable", message: this.buildFailure };
    }
    if (await this.provisioner.cachedBinaryPath().catch(() => null)) return this.availableNow();
    if (await this.provisioner.xcodeToolchainPresent().catch(() => false))
      return this.availableNow();
    return { kind: "backend-unavailable", message: UNSUPPORTED_MACOS_MESSAGE };
  }

  /**
   * Availability as established: builds the helper if needed, starts it, and
   * reads its capability probe (OS version, arch, TCC grants). Belongs only on
   * paths about to use the desktop — `probeAvailability` is the passive twin.
   */
  async availability(): Promise<ComputerAvailability> {
    if (this.platform !== "darwin") {
      return { kind: "unsupported-platform", platform: this.platform };
    }
    try {
      const capabilities = await this.readCapabilities();
      this.captureGranted = capabilities.screenRecording;
      this.healthState.recordConnected();
      this.publishHealth();
      return this.availableNow();
    } catch (error) {
      this.recordHealthFailure(error);
      this.publishHealth();
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "backend-unavailable",
        message: clampComputerMessage(
          message,
          "The Synara macOS computer backend failed without a message.",
        ),
      };
    }
  }

  private availableNow(): ComputerAvailability {
    return { kind: "available", backend: COMPUTER_MAC_BACKEND };
  }

  /**
   * The settings-panel "Set up" action: compile the native helper for this
   * Xcode toolchain (a cold Swift build) and start it, so the first agent turn
   * does not pay the build. Returns one sentence naming what happened and the
   * grants still needed, which is exactly what the card that pressed it renders.
   */
  async provision(): Promise<string> {
    if (this.platform !== "darwin") {
      throw new ComputerBackendError(
        `The macOS computer backend cannot provision on ${this.platform}.`,
      );
    }
    await this.ensureHelper();
    const capabilities = await this.readCapabilities();
    this.captureGranted = capabilities.screenRecording;
    this.publishHealth();
    const missing: string[] = [];
    if (!capabilities.screenRecording) missing.push("Screen Recording");
    if (!capabilities.accessibility) missing.push("Accessibility");
    return missing.length === 0
      ? "Built and started the macOS computer-use helper; Screen Recording and Accessibility are granted."
      : `Built and started the macOS computer-use helper. Grant ${missing.join(" and ")} in System ` +
          "Settings › Privacy & Security to finish enabling desktop control.";
  }

  health(): ComputerHealth {
    return this.healthState.health();
  }

  async listWindows(): Promise<readonly ComputerWindow[]> {
    const [windows] = await this.readWindows();
    return windows;
  }

  /**
   * One window enumeration, in both coordinate spaces — the macOS twin of the
   * KWin backend's `readWindows`. The helper reports global top-left screen
   * coordinates; a multi-display layout can place a screen above or left of the
   * main one, so the workspace origin can be negative. Everything crossing this
   * boundary speaks agent space (0..screenSize), translated once here.
   */
  private async readWindows(): Promise<readonly [readonly ComputerWindow[], ComputerPoint]> {
    const payload = await this.call(MAC_HELPER_METHODS.listWindows);
    const record = asRecord(payload);
    const raw = parseWindows(record.windows, asString(record.focusedWindowId) ?? null);
    const workspace = this.parseWorkspace(record.workspace) ?? workspaceRectFromWindows(raw);
    const origin = { x: workspace.x, y: workspace.y };
    this.lastOrigin = origin;
    this.lastWorkspaceGlobal = workspace;
    const windows = raw.map((window) => windowInAgentSpace(window, origin));
    const fingerprint = `${asString(record.focusedWindowId) ?? ""} ${JSON.stringify(
      raw.map((window) => [window.id, window.bounds, window.stackingIndex, window.minimized]),
    )}`;
    if (fingerprint !== this.previousWindowsFingerprint) {
      this.previousWindowsFingerprint = fingerprint;
      this.emit({ type: "windows-changed", windows });
    }
    return [windows, origin];
  }

  async getScreenSize(): Promise<ComputerScreenSize> {
    const payload = await this.call(MAC_HELPER_METHODS.screenSize);
    const record = asRecord(payload);
    const width = asFiniteNumber(record.width);
    const height = asFiniteNumber(record.height);
    const scale = asFiniteNumber(record.scale);
    if (width === undefined || height === undefined || width < 1 || height < 1) {
      // Fall back to the window bounding box rather than failing the pane.
      const [windows] = await this.readWindows();
      return screenSizeFromWindows(windows, this.lastWorkspaceGlobal);
    }
    // Cache the workspace so pointer/capture translation has an origin without a
    // second round trip; the helper reports the workspace top-left alongside.
    const originX = asFiniteNumber(record.x) ?? this.lastOrigin.x;
    const originY = asFiniteNumber(record.y) ?? this.lastOrigin.y;
    this.lastOrigin = { x: originX, y: originY };
    this.lastWorkspaceGlobal = { x: originX, y: originY, width, height };
    return {
      width: Math.round(width),
      height: Math.round(height),
      ...(scale && scale > 0 ? { scale } : { scale: 1 }),
    };
  }

  async getState(options: {
    readonly includeScreenshot?: boolean;
    readonly includeText?: boolean;
  }): Promise<ComputerState> {
    const [windows, origin] = await this.readWindows();
    const screenSize = screenSizeFromWindows(windows, this.lastWorkspaceGlobal);
    let root: ComputerUiNode | undefined;
    if (options.includeText) {
      try {
        const payload = await this.call(MAC_HELPER_METHODS.describeUi);
        root = parseMacUiForest(payload, screenSize, origin);
      } catch {
        // AX is an optional perception source: a window with no tree, a helper
        // restarting, or a missing Accessibility grant degrades to windows-only
        // rather than failing the state, exactly as the KWin path does.
      }
    }
    const screenshot =
      options.includeScreenshot && this.captureGranted
        ? await this.captureWorkspaceScreenshot(origin).catch(() => undefined)
        : undefined;
    return {
      computerId: this.computerId,
      windows,
      screenSize,
      ...(root ? { root } : {}),
      ...(root && options.includeText ? { text: describeComputerUiTree(root) } : {}),
      ...(screenshot ? { screenshot } : {}),
      capturedAt: new Date(this.now()).toISOString(),
    };
  }

  async captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot> {
    const maxDimension = request.maxDimension ?? this.captureMaxDimension;
    if (request.kind === "window") {
      const [windows, origin] = await this.readWindows();
      const window = windows.find((candidate) => candidate.id === request.windowId);
      if (!window) {
        throw new ComputerBackendError(
          `No desktop window has id ${JSON.stringify(request.windowId)}. ` +
            "Call computer_list_windows for the current window ids.",
        );
      }
      const captured = await this.callCapture({
        kind: "window",
        windowId: request.windowId,
        maxDimension,
      });
      // The helper reports the region it actually captured, in globals; the
      // window's own frame is the fallback when it omits one.
      const globalRegion =
        captured.region ??
        shiftRect(requireWindowBounds(window, "a window screenshot"), origin.x, origin.y);
      return this.screenshot(captured.bytes, shiftRect(globalRegion, -origin.x, -origin.y));
    }

    const requested = request.region;
    if (
      ![requested.x, requested.y, requested.width, requested.height].every((value) =>
        Number.isFinite(value),
      ) ||
      requested.width <= 0 ||
      requested.height <= 0
    ) {
      throw new ComputerBackendError(
        "A screenshot region needs finite x/y and a positive width and height.",
      );
    }
    const origin = this.currentOrigin();
    const globalWorkspace = await this.workspaceRect();
    const global = intersectComputerRects(
      shiftRect(alignRect(requested), origin.x, origin.y),
      globalWorkspace,
    );
    if (!global) {
      throw new ComputerBackendError(
        `Region ${formatRect(requested)} does not overlap the desktop workspace. ` +
          "Regions use desktop logical pixels, the same space as window bounds.",
      );
    }
    const captured = await this.callCapture({ kind: "region", region: global, maxDimension });
    const region = captured.region ?? global;
    return this.screenshot(captured.bytes, shiftRect(region, -origin.x, -origin.y));
  }

  async launchApp(app: string, args: readonly string[]): Promise<ComputerLaunchAppResult> {
    const payload = asRecord(
      await this.call(MAC_HELPER_METHODS.launchApp, { app, arguments: [...args] }),
    );
    const resolvedCommand = asString(payload.resolvedCommand);
    return {
      computerId: this.computerId,
      app,
      ...(resolvedCommand ? { resolvedCommand } : {}),
      window: null,
    };
  }

  async click(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    return await this.pointerAction(MAC_HELPER_METHODS.click, point);
  }

  async doubleClick(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    return await this.pointerAction(MAC_HELPER_METHODS.doubleClick, point);
  }

  async rightClick(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    return await this.pointerAction(MAC_HELPER_METHODS.rightClick, point);
  }

  async moveCursor(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    return await this.pointerAction(MAC_HELPER_METHODS.move, point);
  }

  async drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
  ): Promise<ComputerBackendActionResult> {
    const origin = this.currentOrigin();
    await this.call(MAC_HELPER_METHODS.drag, {
      fromX: from.x + origin.x,
      fromY: from.y + origin.y,
      toX: to.x + origin.x,
      toY: to.y + origin.y,
      durationMs: durationMs > 0 ? durationMs : DEFAULT_DRAG_DURATION_MS,
    });
    return { point: to };
  }

  async scroll(
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerBackendActionResult> {
    const origin = this.currentOrigin();
    const params: Record<string, unknown> = { deltaX, deltaY };
    if (point) {
      params.x = point.x + origin.x;
      params.y = point.y + origin.y;
    }
    await this.call(MAC_HELPER_METHODS.scroll, params);
    return point ? { point } : {};
  }

  async typeText(text: string): Promise<ComputerBackendActionResult> {
    await this.call(MAC_HELPER_METHODS.type, { text });
    return { value: text };
  }

  async pressKey(key: string): Promise<ComputerBackendActionResult> {
    await this.call(MAC_HELPER_METHODS.pressKey, { key });
    return {};
  }

  async hotkey(keys: readonly string[]): Promise<ComputerBackendActionResult> {
    await this.call(MAC_HELPER_METHODS.hotkey, { keys: [...keys] });
    return {};
  }

  async readClipboard(): Promise<string> {
    const payload = asRecord(await this.call(MAC_HELPER_METHODS.readClipboard));
    return asString(payload.text) ?? "";
  }

  async writeClipboard(text: string): Promise<void> {
    await this.call(MAC_HELPER_METHODS.writeClipboard, { text });
  }

  async setValue(
    target: ComputerResolvedTarget,
    value: string,
  ): Promise<ComputerBackendActionResult> {
    const address = this.writeAddress(target);
    if (address) {
      await this.call(MAC_HELPER_METHODS.setValue, { ...address, value });
    } else {
      // No addressable AX node: focus the control with a click, then type — the
      // same fallback the KWin path takes when AT-SPI cannot address a node.
      await this.click(target.point);
      await this.typeText(value);
    }
    return {
      point: target.point,
      ...(target.node.windowId ? { windowId: target.node.windowId } : {}),
      value,
    };
  }

  async performAction(
    target: ComputerResolvedTarget,
    action: string,
  ): Promise<ComputerBackendActionResult> {
    if (action === "activate" || action === "click") {
      const clicked = await this.click(target.point);
      return {
        ...clicked,
        point: target.point,
        ...(target.node.windowId ? { windowId: target.node.windowId } : {}),
        value: action,
      };
    }
    const address = this.writeAddress(target);
    if (!address) {
      throw new ComputerBackendError(
        `macOS computer action ${JSON.stringify(action)} needs an addressable accessibility node.`,
      );
    }
    await this.call(MAC_HELPER_METHODS.performAction, { ...address, action });
    return {
      point: target.point,
      ...(target.node.windowId ? { windowId: target.node.windowId } : {}),
      value: action,
    };
  }

  async raiseWindow(windowId: string): Promise<void> {
    await this.call(MAC_HELPER_METHODS.raiseWindow, { windowId });
  }

  async setDrivingAgent(name: string | null): Promise<void> {
    this.drivingAgent = name?.trim() ? name.trim() : null;
    if (!this.helper?.running) return;
    // Best effort: the agent cursor's name badge is presentation, so a failure
    // here must never fail the action that changed the holder.
    await this.call(MAC_HELPER_METHODS.setAgentCursor, { name: this.drivingAgent ?? "" }).catch(
      () => undefined,
    );
  }

  onEvent(listener: ComputerBackendEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async attachStream(listener: ComputerFrameListener): Promise<void> {
    if (this.streamTimer !== undefined) clearInterval(this.streamTimer);
    this.streamTimer = undefined;
    await this.ensureHelper();
    if (this.streamTimer !== undefined) clearInterval(this.streamTimer);
    this.streamListener = listener;
    await this.publishStillFrame();
    this.streamTimer = setInterval(() => {
      void this.publishStillFrame();
    }, this.stillIntervalMs);
    this.streamTimer.unref?.();
  }

  async detachStream(): Promise<void> {
    this.streamListener = undefined;
    if (this.streamTimer !== undefined) clearInterval(this.streamTimer);
    this.streamTimer = undefined;
  }

  async requestKeyframe(): Promise<void> {
    if (!this.streamListener) return;
    await this.publishStillFrame();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.detachStream();
    await this.helper?.dispose().catch(() => undefined);
    this.helper = undefined;
    this.eventListeners.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────

  private writeAddress(
    target: ComputerResolvedTarget,
  ): { readonly windowId: string; readonly nodePath: readonly number[] } | undefined {
    const windowId = target.node.windowId;
    const nodePath = target.node.nodePath;
    if (!windowId || !nodePath || nodePath.length === 0) return undefined;
    return { windowId, nodePath };
  }

  private async pointerAction(
    method: string,
    point: ComputerPoint,
  ): Promise<ComputerBackendActionResult> {
    const origin = this.currentOrigin();
    const payload = asRecord(
      await this.call(method, { x: point.x + origin.x, y: point.y + origin.y }),
    );
    // The helper reports where the pointer actually landed when the display
    // clamped it (a coordinate in a gap between screens); shift back to agent
    // space and surface the mismatch, matching the KWin path's `clampedTo`.
    const landedX = asFiniteNumber(payload.x);
    const landedY = asFiniteNumber(payload.y);
    if (landedX !== undefined && landedY !== undefined) {
      const landed = { x: landedX - origin.x, y: landedY - origin.y };
      if (Math.abs(landed.x - point.x) > 2 || Math.abs(landed.y - point.y) > 2) {
        return { point, clampedTo: landed };
      }
    }
    return { point };
  }

  private async captureWorkspaceScreenshot(origin: ComputerPoint): Promise<ComputerScreenshot> {
    const global = await this.workspaceRect();
    const captured = await this.callCapture({
      kind: "region",
      region: global,
      maxDimension: this.captureMaxDimension,
    });
    return this.screenshot(
      captured.bytes,
      shiftRect(captured.region ?? global, -origin.x, -origin.y),
    );
  }

  private async publishStillFrame(): Promise<void> {
    const listener = this.streamListener;
    if (!listener || this.stillInFlight || !this.captureGranted) return;
    this.stillInFlight = true;
    try {
      const global = await this.workspaceRect();
      const captured = await this.callCapture({
        kind: "region",
        region: global,
        maxDimension: this.captureMaxDimension,
      });
      // Fail here rather than in a browser decoder, whose only symptom is a
      // blank pane: a payload that is not a PNG must be caught at the source.
      readPngDimensions(captured.bytes, { source: "Synara macOS capture" });
      if (this.streamListener !== listener) return;
      const frame = {
        sequence: this.nextSequence++,
        timestampMs: this.now(),
        keyframe: true,
        codecConfig: false,
        data: captured.bytes,
      };
      listener(frame);
      this.emit({ type: "frame", frame });
    } catch {
      // A transient capture failure must not tear down a subscribed stream.
    } finally {
      this.stillInFlight = false;
    }
  }

  private screenshot(bytes: Uint8Array, region: ComputerRect): ComputerScreenshot {
    return screenshotFromPng({
      bytes,
      region,
      capturedAt: new Date(this.now()).toISOString(),
      source: "Synara macOS capture",
    });
  }

  /** Workspace geometry in GLOBAL coordinates, from cache when the helper reported one. */
  private async workspaceRect(): Promise<ComputerRect> {
    if (
      this.lastWorkspaceGlobal &&
      this.lastWorkspaceGlobal.width > 0 &&
      this.lastWorkspaceGlobal.height > 0
    ) {
      return this.lastWorkspaceGlobal;
    }
    const [windows, origin] = await this.readWindows();
    return shiftRect(workspaceRectFromWindows(windows), origin.x, origin.y);
  }

  private currentOrigin(): ComputerPoint {
    return this.lastOrigin;
  }

  private parseWorkspace(value: unknown): ComputerRect | undefined {
    const record = asRecord(value);
    const x = asFiniteNumber(record.x);
    const y = asFiniteNumber(record.y);
    const width = asFiniteNumber(record.width);
    const height = asFiniteNumber(record.height);
    if (x === undefined || y === undefined || width === undefined || height === undefined) {
      return undefined;
    }
    if (width <= 0 || height <= 0) return undefined;
    return { x, y, width, height };
  }

  private async readCapabilities(): Promise<{
    readonly screenRecording: boolean;
    readonly accessibility: boolean;
  }> {
    const payload = asRecord(await this.call(MAC_HELPER_METHODS.capabilities));
    return {
      screenRecording: payload.screenRecording === true,
      accessibility: payload.accessibility === true,
    };
  }

  private async callCapture(request: {
    readonly kind: "window" | "region";
    readonly windowId?: string;
    readonly region?: ComputerRect;
    readonly maxDimension: number;
  }): Promise<{ readonly bytes: Uint8Array; readonly region: ComputerRect | undefined }> {
    const params: Record<string, unknown> = {
      kind: request.kind,
      maxDimension: request.maxDimension,
    };
    if (request.kind === "window") params.windowId = request.windowId;
    if (request.region) params.region = request.region;
    const payload = asRecord(await this.call(MAC_HELPER_METHODS.capture, params));
    const base64 = asString(payload.base64);
    if (!base64) {
      throw new ComputerBackendError("The macOS capture returned no image data.");
    }
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    return { bytes, region: this.parseWorkspace(payload.region) };
  }

  /**
   * Ensures the helper is up, sends one request, and normalizes failures.
   *
   * A transport-level failure (the helper process exited, a Screen Recording
   * prompt killed it) invalidates the connection so the next call rebuilds and
   * respawns — the macOS twin of the KWin reconnect, but lazy: the helper is
   * cheap to respawn, so a timer loop earns nothing.
   */
  private async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const helper = await this.ensureHelper();
    try {
      return await helper.request(method, params);
    } catch (error) {
      const record = asRecord(error);
      const code = typeof record.code === "string" ? record.code : "";
      if (
        code === "helper_exited" ||
        code === "helper_unavailable" ||
        code === "helper_spawn_failed"
      ) {
        this.invalidateHelper();
        this.recordHealthFailure(error);
        this.publishHealth();
        throw new ComputerBackendError(error instanceof Error ? error.message : String(error), {
          retryable: true,
          cause: error,
        });
      }
      if (error instanceof ComputerBackendError) throw error;
      throw new ComputerBackendError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
  }

  private async ensureHelper(): Promise<MacHelperTransport> {
    if (this.disposed) throw new ComputerBackendError("macOS computer backend is disposed.");
    if (this.helper?.running) return this.helper;
    this.helperPromise ??= this.startHelper().finally(() => {
      this.helperPromise = undefined;
    });
    return await this.helperPromise;
  }

  private async startHelper(): Promise<MacHelperTransport> {
    let binaryPath: string;
    try {
      binaryPath = await (this.binaryPromise ??= this.resolveBinary().finally(() => {
        this.binaryPromise = undefined;
      }));
    } catch (error) {
      if (error instanceof MacHelperBuildError) this.buildFailure = error.message;
      this.recordHealthFailure(error);
      this.publishHealth();
      throw error instanceof ComputerBackendError
        ? error
        : new ComputerBackendError(error instanceof Error ? error.message : String(error), {
            cause: error,
          });
    }
    this.buildFailure = undefined;
    const helper = this.makeHelperClient({
      binaryPath,
      env: this.env,
      onExit: () => {
        if (this.helper === helper) this.invalidateHelper();
        this.publishHealth();
      },
    });
    helper.start();
    this.helper = helper;
    this.healthState.recordConnected();
    // Push the cached badge name onto the fresh session so a reconnect brings
    // the agent cursor back naming the same thread.
    if (this.drivingAgent) {
      await helper
        .request(MAC_HELPER_METHODS.setAgentCursor, { name: this.drivingAgent })
        .catch(() => undefined);
    }
    this.publishHealth();
    return helper;
  }

  private invalidateHelper(): void {
    const helper = this.helper;
    this.helper = undefined;
    void helper?.dispose().catch(() => undefined);
  }

  private recordHealthFailure(error: unknown): void {
    this.healthState.recordFailure(error);
  }

  private publishHealth(): void {
    this.healthState.publish();
  }

  private emit(event: Parameters<ComputerBackendEventListener>[0]): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // One observer must not prevent the others from seeing an update.
      }
    }
  }
}
