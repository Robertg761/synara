import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  ComputerAvailability,
  ComputerCapabilities,
  ComputerHealth,
  ComputerId,
  ComputerLaunchAppResult,
  ComputerPoint,
  ComputerRect,
  ComputerScreenshot,
  ComputerScreenSize,
  ComputerState,
  ComputerUiNode,
  ComputerWindow,
} from "@synara/contracts";

import {
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
import { resolveAppLaunchOnHost, type AppLaunchResolver } from "./appLaunchResolution.ts";
import { AtspiHelperClient, type AtspiTreeReader } from "./atspiClient.ts";
import {
  atspiTextWriteAddress,
  describeComputerUiTree,
  fuseAtspiTrees,
  type AtspiWindowTree,
} from "./atspiTreeTargeting.ts";
import {
  alignRect,
  asRecord,
  asString,
  formatRect,
  parseComputerPoint,
  parseComputerRect,
  parseJsonPayload,
  parseWindows,
  requireWindowBounds,
  screenSizeFromWindows,
  screenshotFromPng,
  unwrapDbusValue,
  workspaceRectFromWindows,
} from "./computerGeometry.ts";
import { ComputerHealthState } from "./computerHealthState.ts";
import {
  createSessionKWinComputerDbus,
  KWinDbusTimeoutError,
  type KWinComputerDbus,
  type KWinComputerPluginApi,
} from "./kwinDbus.ts";
import { EVDEV_BUTTON_CODES, keyStrokeForKey, qwertyTextKeyStrokes } from "./evdevInput.ts";
import {
  glidePointerToDeadline,
  POINTER_SEQUENCE_OPERATIONS,
  pressButtonOnce,
  pressHotkeyStrokes,
  pressKeyStroke,
  type ComputerInputSink,
} from "./pointerSequencing.ts";
import {
  readWlClipboard,
  spawnClipboardCommand,
  writeWlClipboard,
  type ClipboardCommandRunner,
} from "./wlClipboard.ts";

const DEFAULT_COMPUTER_ID = "desktop";
const DEFAULT_GLIDE_DURATION_MS = 180;
const DEFAULT_STILL_INTERVAL_MS = 500;
const DEFAULT_CAPTURE_MAX_DIMENSION = DEFAULT_COMPUTER_CAPTURE_MAX_DIMENSION;
const POINTER_CLAMP_TOLERANCE_PX = 2;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const KWIN_RECONNECT_BASE_DELAY_MS = 250;
const KWIN_RECONNECT_MAX_DELAY_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
const MIN_IDLE_TIMEOUT_MS = 1_000;
const MAX_IDLE_TIMEOUT_MS = 60 * 60 * 1_000;
/** Must match `releaseShortcut()` in the KWin plugin. */
const RELEASE_CONTROL_HOTKEY = "Meta+Shift+Esc";
const CONTROL_RELEASED_ERROR_TYPE = "org.synara.ComputerUse.Error.ControlReleased";
const CONTROL_RELEASED_MESSAGE =
  `Computer control was released with the ${RELEASE_CONTROL_HOTKEY} hotkey. ` +
  `Press ${RELEASE_CONTROL_HOTKEY} again to hand control back.`;
const INSTALL_SCRIPT_PATH = "apps/server/native/computer-use-kwin/scripts/install-and-load.sh";
const ENABLE_REBUILD_SCRIPT_PATH = "apps/server/native/computer-use-kwin/systemd/enable.sh";
const KWIN_VERSION_PATTERN = /\d+(?:\.\d+)+/;
const KWIN_VERSION_PROBE_TIMEOUT_MS = 2_000;
const MAX_PLUGIN_ID = /^SynaraComputerUsePlugin(?:V(\d+))?$/;
const INSTALLED_PLUGIN_FILE = /^(SynaraComputerUsePluginV(\d+))\.so$/;
/** Names this backend in a capture failure, which reaches a tool call verbatim. */
const CAPTURE_SOURCE = "Synara KWin capture";

interface KWinHealth {
  readonly ok: boolean;
  readonly running: boolean;
  readonly capture: boolean;
  readonly releasedByUser: boolean;
  readonly workspace: ComputerRect | null;
}

interface KWinPluginState {
  readonly position: ComputerPoint | null;
  readonly targetWindowId: string | null;
}

export interface KWinComputerBackendOptions {
  readonly computerId?: string;
  readonly dbus?: KWinComputerDbus;
  readonly dbusFactory?: () => Promise<KWinComputerDbus>;
  /**
   * A private session bus carrying the compositor, set only by the nested
   * Tier 3 session. Absent, KWin is reached on the ambient session bus.
   */
  readonly busAddress?: string;
  readonly atspi?: AtspiTreeReader;
  readonly installedPluginIds?: () => Promise<readonly string[]>;
  readonly pluginDirectories?: readonly string[];
  readonly platform?: string;
  readonly sessionType?: string;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly spawnProcess?: (app: string, args: readonly string[]) => ChildProcess;
  /** Name-to-executable resolution, replaced in tests to avoid host lookups. */
  readonly resolveApp?: AppLaunchResolver;
  /** wl-clipboard process runner, replaced in tests. */
  readonly runClipboardCommand?: ClipboardCommandRunner;
  readonly glideDurationMs?: number;
  readonly stillIntervalMs?: number;
  readonly captureMaxDimension?: number;
  /**
   * Plugin-side session deadline. `0` disables it; see the Phase 3b notes.
   * Falls back to `SYNARA_COMPUTER_IDLE_TIMEOUT_MS`, then to five minutes.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Whether the driven compositor renders on the human's own display. True for
   * the host session (the default), false when the backend is bound to a
   * nested, offscreen compositor — see `nestedKWinBackendOptions`.
   */
  readonly visibleDesktop?: boolean;
  /** Installer stamp consulted when KWin refuses to load the plugin. */
  readonly installStampPath?: string;
  readonly readInstallStamp?: () => Promise<string | undefined>;
  /** Running KWin version, read only to explain a load refusal. */
  readonly runningKwinVersion?: () => Promise<string | undefined>;
}

/**
 * Linux/KWin implementation of the Phase 1 computer backend.
 *
 * All KWin calls go through the user-session D-Bus proxy in kwinDbus.ts. The
 * backend never shells out to busctl, which keeps method calls typed at the
 * boundary, makes service errors observable, and avoids paying a process spawn
 * plus shell parsing cost for every pointer or key event.
 */
export class KWinComputerBackend implements ComputerBackend {
  readonly computerId: ComputerId;

  private readonly platform: string;
  private readonly sessionType: string;
  private readonly visibleDesktop: boolean;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly glideDurationMs: number;
  private readonly stillIntervalMs: number;
  private readonly captureMaxDimension: number;
  private readonly idleTimeoutMs: number;
  private readonly atspi: AtspiTreeReader;
  private readonly dbusFactory: () => Promise<KWinComputerDbus>;
  private readonly installedPluginIds: () => Promise<readonly string[]>;
  private readonly readInstallStamp: () => Promise<string | undefined>;
  private readonly runningKwinVersion: () => Promise<string | undefined>;
  private runningKwinVersionPromise: Promise<string | undefined> | undefined;

  private dbus: KWinComputerDbus | undefined;
  private plugin: KWinComputerPluginApi | undefined;
  private pluginId: string | undefined;
  private pluginHealth: KWinHealth | undefined;
  private disconnect: (() => void) | undefined;
  private connectPromise: Promise<KWinComputerPluginApi> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectFailures = 0;
  /** A retry is pending or running, which is what `reconnecting` reports. */
  private reconnecting = false;
  private readonly healthState: ComputerHealthState;
  private disposed = false;
  private streamListener: ComputerFrameListener | undefined;
  private streamTimer: ReturnType<typeof setInterval> | undefined;
  private stillInFlight = false;
  private captureQueue: Promise<void> = Promise.resolve();
  private capturePending = 0;
  private startPromise: Promise<void> | undefined;
  private readonly spawnProcess: (app: string, args: readonly string[]) => ChildProcess;
  private readonly resolveApp: AppLaunchResolver;
  private readonly runClipboardCommand: ClipboardCommandRunner;
  private nextSequence = 1;
  private currentPoint: ComputerPoint | null = null;
  private previousWindowsFingerprint: string | undefined;
  private readonly eventListeners = new Set<ComputerBackendEventListener>();

  constructor(options: KWinComputerBackendOptions = {}) {
    this.computerId = (options.computerId ?? DEFAULT_COMPUTER_ID) as ComputerId;
    this.platform = options.platform ?? process.platform;
    this.sessionType =
      options.sessionType ??
      process.env.XDG_SESSION_TYPE ??
      (process.env.WAYLAND_DISPLAY ? "wayland" : "");
    this.visibleDesktop = options.visibleDesktop ?? true;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
    this.spawnProcess =
      options.spawnProcess ??
      ((app, args) => spawn(app, [...args], { detached: true, stdio: "ignore" }));
    this.resolveApp = options.resolveApp ?? resolveAppLaunchOnHost;
    this.runClipboardCommand = options.runClipboardCommand ?? spawnClipboardCommand;
    this.glideDurationMs = Math.max(0, options.glideDurationMs ?? DEFAULT_GLIDE_DURATION_MS);
    this.stillIntervalMs = Math.max(100, options.stillIntervalMs ?? DEFAULT_STILL_INTERVAL_MS);
    this.captureMaxDimension = Math.max(
      1,
      Math.min(32_768, Math.floor(options.captureMaxDimension ?? DEFAULT_CAPTURE_MAX_DIMENSION)),
    );
    this.idleTimeoutMs = normalizeIdleTimeout(
      options.idleTimeoutMs ?? parseIdleTimeoutEnv(process.env.SYNARA_COMPUTER_IDLE_TIMEOUT_MS),
    );
    this.atspi = options.atspi ?? new AtspiHelperClient();
    this.dbus = options.dbus;
    this.dbusFactory =
      options.dbusFactory ??
      (options.dbus
        ? async () => options.dbus!
        : () =>
            createSessionKWinComputerDbus(
              options.busAddress ? { busAddress: options.busAddress } : {},
            ));
    this.installedPluginIds =
      options.installedPluginIds ??
      (() => scanInstalledPluginIds(options.pluginDirectories ?? defaultPluginDirectories()));
    this.readInstallStamp =
      options.readInstallStamp ??
      (() => readInstallStamp(options.installStampPath ?? defaultInstallStampPath()));
    this.runningKwinVersion = options.runningKwinVersion ?? detectRunningKwinVersion;
    this.healthState = new ComputerHealthState({
      readStatus: () => ({
        status: this.connectedPlugin()
          ? "connected"
          : this.reconnecting
            ? "reconnecting"
            : "unavailable",
        captureAvailable: this.pluginHealth?.capture === true,
      }),
      emit: (health) => this.emit({ type: "health-changed", health }),
      now: () => this.now(),
      failureFallbackMessage: "The Synara KWin backend failed without a message.",
    });
  }

  /**
   * Tier 1's whole capability set. The KWin plugin owns a dedicated seat inside
   * the compositor, which is what makes every one of these true at once:
   * enumeration with real `frameGeometry`, a stacking order and its occlusion,
   * focus and raise, and a second pointer drawn without touching the human's.
   * `sharedSeat` is false for exactly that reason, and the panel's shared-control
   * warning keys off it.
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
      sharedSeat: false,
      visibleDesktop: this.visibleDesktop,
    };
  }

  async availability(): Promise<ComputerAvailability> {
    if (this.platform !== "linux") {
      return { kind: "unsupported-platform", platform: this.platform };
    }
    if (this.sessionType.toLowerCase() !== "wayland") {
      return {
        kind: "backend-unavailable",
        message: "Linux computer control requires a Wayland session.",
      };
    }
    try {
      const plugin = await this.ensurePlugin({ start: false });
      const health = parseHealth(await plugin.healthJson());
      if (!health.ok) {
        throw new ComputerBackendError("Synara KWin computer-use health check failed.");
      }
      this.pluginHealth = health;
      this.publishHealth();
      return { kind: "available", backend: "kwin" };
    } catch (error) {
      const failure = this.reportPluginFailure(error);
      // A refusal the reconnect path never sees — no installed plugin, a KWin
      // version mismatch — is still the newest thing that went wrong, so it is
      // recorded here rather than only where a retry is scheduled.
      this.recordHealthFailure(error);
      this.publishHealth();
      return {
        kind: "backend-unavailable",
        message: failure.message,
      };
    }
  }

  /**
   * Health as the supervision path already knows it: no D-Bus call, no probe.
   * `connected` is exactly the condition `ensureConnectedPlugin` reuses a live
   * plugin under, so what a panel is told and what the next action will find
   * cannot drift apart.
   */
  health(): ComputerHealth {
    return this.healthState.health();
  }

  async listWindows(): Promise<readonly ComputerWindow[]> {
    const plugin = await this.ensurePlugin({ start: false });
    try {
      const state = await this.readPluginState(plugin);
      const windows = parseWindows(await plugin.windowsJson(), state.targetWindowId);
      const fingerprint = JSON.stringify(windows);
      if (fingerprint !== this.previousWindowsFingerprint) {
        this.previousWindowsFingerprint = fingerprint;
        this.emit({ type: "windows-changed", windows });
      }
      return windows;
    } catch (error) {
      throw this.reportPluginFailure(error);
    }
  }

  async getScreenSize(): Promise<ComputerScreenSize> {
    await this.ensurePlugin({ start: false });
    const windows = await this.listWindows();
    return screenSizeFromWindows(windows, this.pluginHealth?.workspace);
  }

  async getState(options: {
    readonly includeScreenshot?: boolean;
    readonly includeText?: boolean;
  }): Promise<ComputerState> {
    await this.ensurePlugin({ start: false });
    // listWindows already reads the plugin state to resolve the focused window,
    // so a second stateJson round trip here would only add latency.
    const windows = await this.listWindows();
    const screenSize = screenSizeFromWindows(windows, this.pluginHealth?.workspace);
    let root: ComputerUiNode | undefined;
    if (options.includeText) {
      try {
        const trees = await this.atspi.readTrees(windows);
        root = fuseAtspiTrees({ windows, trees, screenSize });
      } catch {
        // AT-SPI is an optional perception source. KWin window state and
        // coordinate actions stay usable when an application has no tree or
        // the helper is temporarily restarting.
      }
    }

    const screenshot =
      options.includeScreenshot && this.pluginHealth?.capture === true
        ? await this.captureWorkspaceScreenshot(windows).catch(() => undefined)
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

  async focusWindow(windowId: string): Promise<void> {
    const plugin = await this.ensurePlugin();
    await this.pluginSuccess("focusWindow", () => plugin.focusWindow(windowId));
  }

  async raiseWindow(windowId: string): Promise<void> {
    const plugin = await this.ensurePlugin();
    try {
      await this.pluginSuccess("raiseWindow", () => plugin.raiseWindow(windowId));
    } catch (error) {
      // A loaded plugin that predates raiseWindow cannot restack, and the
      // caller has to hear that: focus routes keyboard input, not pointer
      // input, so a click on a covered window lands in whatever is on top of
      // it. Swallowing this is what made buried clicks look like dead buttons.
      if (!isUnknownMethodDbusError(error)) throw error;
      throw new ComputerBackendError(
        "The loaded Synara KWin plugin has no raiseWindow, so windows cannot be raised above " +
          `what covers them. Build, install, and load the current plugin with ${INSTALL_SCRIPT_PATH}.`,
      );
    }
  }

  async clearFocusWindow(): Promise<void> {
    const plugin = await this.ensurePlugin();
    await this.pluginSuccess("clearFocusWindow", () => plugin.clearFocusWindow());
  }

  async launchApp(app: string, args: readonly string[]): Promise<ComputerLaunchAppResult> {
    await this.ensurePlugin();
    const launch = this.resolveApp(app, args);
    let child: ChildProcess;
    try {
      child = this.spawnProcess(launch.command, launch.args);
    } catch (error) {
      throw launchAppError(app, error);
    }

    return await new Promise<ComputerLaunchAppResult>((resolve, reject) => {
      const result = {
        computerId: this.computerId,
        app,
        resolvedCommand: launch.command,
        window: null,
      } as ComputerLaunchAppResult;
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve(result);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(launchAppError(app, error));
      };

      child.once("error", onError);
      child.once("spawn", onSpawn);
      try {
        child.unref();
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async click(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    const moved = await this.moveCursor(point);
    await this.pressButton(EVDEV_BUTTON_CODES.left);
    return moved;
  }

  async doubleClick(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    const moved = await this.moveCursor(point);
    await this.pressButton(EVDEV_BUTTON_CODES.left);
    await this.sleep(60);
    await this.pressButton(EVDEV_BUTTON_CODES.left);
    return moved;
  }

  async rightClick(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    const moved = await this.moveCursor(point);
    await this.pressButton(EVDEV_BUTTON_CODES.right);
    return moved;
  }

  async moveCursor(point: ComputerPoint): Promise<ComputerBackendActionResult> {
    const plugin = await this.ensurePlugin();
    const from = this.currentPoint ?? (await this.readPluginState(plugin)).position ?? point;
    await this.glidePointer(plugin, from, point, this.glideDurationMs);
    this.currentPoint = point;
    return await this.pointerResult(plugin, point);
  }

  async drag(
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
  ): Promise<ComputerBackendActionResult> {
    const plugin = await this.ensurePlugin();
    const sink = this.inputSink(plugin);
    await this.moveCursor(from);
    this.throwIfDisposed();
    await sink.button(EVDEV_BUTTON_CODES.left, true, POINTER_SEQUENCE_OPERATIONS.buttonPress);
    try {
      await this.glidePointer(plugin, from, to, durationMs);
    } finally {
      if (!this.disposed) {
        await sink.button(
          EVDEV_BUTTON_CODES.left,
          false,
          POINTER_SEQUENCE_OPERATIONS.buttonRelease,
        );
      }
    }
    this.currentPoint = to;
    return await this.pointerResult(plugin, to);
  }

  async scroll(
    point: ComputerPoint | null,
    deltaX: number,
    deltaY: number,
  ): Promise<ComputerBackendActionResult> {
    const plugin = await this.ensurePlugin();
    const moved = point ? await this.moveCursor(point) : {};
    await this.pluginSuccess("axis", () => plugin.axis(deltaX, deltaY));
    return moved;
  }

  async typeText(text: string): Promise<ComputerBackendActionResult> {
    const strokes = qwertyTextKeyStrokes(text);
    const plugin = await this.ensurePlugin();
    const sink = this.inputSink(plugin);
    for (const stroke of strokes) await pressKeyStroke({ sink, stroke });
    return { value: text };
  }

  async pressKey(key: string): Promise<ComputerBackendActionResult> {
    const stroke = keyStrokeForKey(key);
    const plugin = await this.ensurePlugin();
    await pressKeyStroke({ sink: this.inputSink(plugin), stroke });
    return {};
  }

  async hotkey(keys: readonly string[]): Promise<ComputerBackendActionResult> {
    const strokes = keys.map(keyStrokeForKey);
    const plugin = await this.ensurePlugin();
    await pressHotkeyStrokes({ sink: this.inputSink(plugin), strokes });
    return {};
  }

  /**
   * The human's clipboard, shared on purpose: see wlClipboard.ts for why the
   * agent seat cannot own a private one. Neither direction uses the KWin plugin
   * or the agent seat, so both work without an input session.
   */
  async readClipboard(): Promise<string> {
    return await readWlClipboard(this.runClipboardCommand);
  }

  async writeClipboard(text: string): Promise<void> {
    await writeWlClipboard(this.runClipboardCommand, text);
  }

  /**
   * Writes through AT-SPI when the resolved control exposes `EditableText`, and
   * types the value otherwise.
   *
   * The semantic write is atomic, replaces the whole contents rather than
   * appending to them, and carries text no QWERTY key map can express. The
   * click still runs first in both paths: it raises and focuses the control,
   * which the toolkit needs for anything the user or the agent does next, and a
   * semantic write on its own leaves keyboard focus wherever it was.
   */
  async setValue(
    target: ComputerResolvedTarget,
    value: string,
  ): Promise<ComputerBackendActionResult> {
    const clicked = await this.click(target.point);
    if (!(await this.writeValueThroughAtspi(target, value))) await this.typeText(value);
    return {
      ...clicked,
      point: target.point,
      ...(target.node.windowId ? { windowId: target.node.windowId } : {}),
      value,
    };
  }

  /**
   * Never throws: AT-SPI is an optional actuation path, so a stopped helper, a
   * moved node, or a toolkit that refuses the write all fall back to typing,
   * which is the only path older sessions ever had.
   */
  private async writeValueThroughAtspi(
    target: ComputerResolvedTarget,
    value: string,
  ): Promise<boolean> {
    const address = atspiTextWriteAddress(target.node);
    if (!address) return false;
    try {
      const window = (await this.listWindows()).find(
        (candidate) => candidate.id === address.windowId,
      );
      if (!window) return false;
      return await this.atspi.setText({
        window,
        path: address.path,
        text: value,
        role: target.node.role,
        label: target.node.label,
      });
    } catch {
      return false;
    }
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
    throw new ComputerBackendError(
      `KWin computer action ${JSON.stringify(action)} has no safe input mapping.`,
    );
  }

  onEvent(listener: ComputerBackendEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async attachStream(listener: ComputerFrameListener): Promise<void> {
    if (this.streamTimer !== undefined) clearInterval(this.streamTimer);
    this.streamTimer = undefined;
    await this.ensurePlugin();
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

  async captureWindow(
    windowId: string,
    maxDimension = this.captureMaxDimension,
  ): Promise<Uint8Array> {
    const plugin = await this.ensurePlugin();
    if (this.pluginHealth?.capture !== true) {
      throw new ComputerBackendError("The loaded Synara KWin plugin has no capture support.");
    }
    return readByteArray(
      await this.enqueueCapture(() =>
        this.pluginValue(() => plugin.captureWindow(windowId, normalizeDimension(maxDimension))),
      ),
    );
  }

  async captureRegion(
    x: number,
    y: number,
    width: number,
    height: number,
    maxDimension = this.captureMaxDimension,
  ): Promise<Uint8Array> {
    const plugin = await this.ensurePlugin();
    if (this.pluginHealth?.capture !== true) {
      throw new ComputerBackendError("The loaded Synara KWin plugin has no capture support.");
    }
    return readByteArray(
      await this.enqueueCapture(() =>
        this.pluginValue(() =>
          plugin.captureRegion(x, y, width, height, normalizeDimension(maxDimension)),
        ),
      ),
    );
  }

  /**
   * Zoomed perception for the agent. The workspace shot in `getState` is one
   * downscaled image of every monitor, so small text is unreadable; this
   * captures a single window or region, which spends the same pixel budget on a
   * fraction of the desktop.
   *
   * The returned `region` is always what KWin actually captured: the plugin
   * clips both forms to the workspace geometry, and a window capture uses the
   * window's `frameGeometry`, which is the same rect `windowsJson` reports. The
   * scale is derived from the encoded PNG rather than assumed, because the
   * plugin renders at the output's device pixel ratio and only then downscales
   * to `maxDimension`.
   */
  async captureScreenshot(request: ComputerCaptureRequest): Promise<ComputerScreenshot> {
    const maxDimension = request.maxDimension ?? this.captureMaxDimension;
    if (request.kind === "window") {
      const windows = await this.listWindows();
      const window = windows.find((candidate) => candidate.id === request.windowId);
      if (!window) {
        throw new ComputerBackendError(
          `No desktop window has id ${JSON.stringify(request.windowId)}. ` +
            "Call computer_list_windows for the current window ids.",
        );
      }
      const region = intersectComputerRects(
        requireWindowBounds(window, "a window screenshot"),
        workspaceRectFromWindows(windows, this.pluginHealth?.workspace),
      );
      if (!region) {
        throw new ComputerBackendError(
          `Window ${JSON.stringify(request.windowId)} sits outside the desktop workspace and has nothing to capture.`,
        );
      }
      return this.screenshot(await this.captureWindow(request.windowId, maxDimension), region);
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
    const region = intersectComputerRects(alignRect(requested), await this.workspaceRect());
    if (!region) {
      throw new ComputerBackendError(
        `Region ${formatRect(requested)} does not overlap the desktop workspace. ` +
          "Regions use global desktop logical pixels, the same space as window bounds.",
      );
    }
    return this.screenshot(
      await this.captureRegion(region.x, region.y, region.width, region.height, maxDimension),
      region,
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.connectPromise?.catch(() => undefined);
    await this.startPromise?.catch(() => undefined);
    await this.detachStream();
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnecting = false;
    const plugin = this.plugin;
    if (plugin) await plugin.stop().catch(() => undefined);
    this.disconnect?.();
    this.disconnect = undefined;
    await this.dbus?.close().catch(() => undefined);
    this.dbus = undefined;
    this.plugin = undefined;
    this.pluginHealth = undefined;
    await this.atspi.dispose().catch(() => undefined);
    this.eventListeners.clear();
  }

  private async ensurePlugin(
    options: { readonly start?: boolean } = {},
  ): Promise<KWinComputerPluginApi> {
    const plugin = await this.ensureConnectedPlugin();
    if (options.start !== false) await this.startPlugin(plugin);
    return plugin;
  }

  private async ensureConnectedPlugin(): Promise<KWinComputerPluginApi> {
    if (this.disposed) throw new ComputerBackendError("KWin computer backend is disposed.");
    const connected = this.connectedPlugin();
    if (connected) return connected;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectWithBackoff()
      .catch((error) => {
        if (!isMethodLevelDbusError(error)) this.scheduleReconnect();
        this.recordHealthFailure(error);
        this.publishHealth();
        throw error;
      })
      .finally(() => {
        this.connectPromise = undefined;
      });
    return this.connectPromise;
  }

  private async startPlugin(plugin: KWinComputerPluginApi): Promise<void> {
    if (this.disposed) throw new ComputerBackendError("KWin computer backend is disposed.");
    if (this.pluginHealth?.running === true) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        const started = readBoolean(await plugin.start());
        if (!started) {
          throw new ComputerBackendError("Synara KWin computer-use plugin failed to start.");
        }
        // A plugin build without setIdleTimeout keeps its own default deadline,
        // so an older loaded plugin must not fail the session.
        await plugin.setIdleTimeout(this.idleTimeoutMs).catch(() => undefined);
        const runningHealth = parseHealth(await plugin.healthJson());
        if (!runningHealth.ok || !runningHealth.running) {
          throw new ComputerBackendError("Synara KWin computer-use plugin is not running.");
        }
        this.pluginHealth = runningHealth;
        this.publishHealth();
      } catch (error) {
        throw this.reportPluginFailure(error);
      }
    })().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async connectWithBackoff(): Promise<KWinComputerPluginApi> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.connectOnce();
      } catch (error) {
        lastError = error;
        if (isMethodLevelDbusError(error)) throw error;
        this.invalidateConnection();
        if (attempt < 2) await this.sleep(KWIN_RECONNECT_BASE_DELAY_MS * 2 ** attempt);
      }
    }
    throw new ComputerBackendError(
      lastError instanceof Error ? lastError.message : String(lastError),
      { retryable: true, cause: lastError },
    );
  }

  private async connectOnce(): Promise<KWinComputerPluginApi> {
    const dbus = this.dbus ?? (this.dbus = await this.dbusFactory());
    if (!this.disconnect) {
      this.disconnect = dbus.onDisconnect(() => {
        this.invalidateConnection();
        this.scheduleReconnect();
      });
    }
    let loaded: readonly string[];
    try {
      loaded = await dbus.listLoadedPluginIds();
    } catch (error) {
      if (isConnectionLevelFailure(error)) throw error;
      // Older KWin builds may not expose loadedPlugins. If the Synara service
      // already exists, use it directly; otherwise continue with the
      // installed-file scan below and let LoadPlugin establish the service.
      try {
        const plugin = await dbus.connectPlugin();
        return await this.finishPluginConnection(plugin, undefined);
      } catch (fallbackError) {
        if (isConnectionLevelFailure(fallbackError)) throw fallbackError;
        loaded = [];
      }
    }
    const plan = resolveSynaraPluginLoad({ loaded, installed: await this.installedPluginIds() });
    if (!plan) {
      throw new ComputerBackendError(
        "No installed SynaraComputerUsePluginVn was found in the KWin plugin directories. " +
          `Build, install, and load it with ${INSTALL_SCRIPT_PATH}.`,
      );
    }
    if (plan.kind === "replace") {
      // A false reply means the id was already gone, which is the state the
      // unload was after, so the replies are deliberately ignored.
      for (const staleId of plan.unload) await dbus.unloadPlugin(staleId);
      const accepted = await dbus.loadPlugin(plan.pluginId);
      if (!accepted) throw new ComputerBackendError(await this.describeLoadRefusal(plan.pluginId));
    }
    const plugin = await dbus.connectPlugin();
    return await this.finishPluginConnection(plugin, plan.pluginId);
  }

  /**
   * KWin only logs why it refused a plugin ("has mismatching plugin version"),
   * so the D-Bus `false` reply carries no reason at all. The plugin is a binary
   * KWin module tied to the KWin version it was compiled against, which makes a
   * KWin upgrade the overwhelmingly likely cause. Name the version pair when the
   * installer stamp and the KWin binary can supply it, and always point at the
   * rebuild, because this message is all the availability card can show.
   */
  private async describeLoadRefusal(pluginId: string): Promise<string> {
    const mismatch = await this.readKwinVersionMismatch();
    const cause = mismatch
      ? `it was built for KWin ${mismatch.builtFor}, but KWin ${mismatch.running} is running`
      : "a KWin plugin only loads into the exact KWin version it was built against";
    return (
      `KWin refused to load ${pluginId}: ${cause}. ` +
      `If KWin was upgraded, rebuild and reload the plugin with ${INSTALL_SCRIPT_PATH}; ` +
      `automatic rebuilds can be enabled with ${ENABLE_REBUILD_SCRIPT_PATH}.`
    );
  }

  private async readKwinVersionMismatch(): Promise<
    { readonly builtFor: string; readonly running: string } | undefined
  > {
    const [builtFor, running] = await Promise.all([
      this.readInstallStamp().then(stampKwinVersion, () => undefined),
      this.probeRunningKwinVersion(),
    ]);
    // Equal versions mean the refusal has some other cause, and a half-known
    // pair says nothing, so only a real mismatch is worth naming.
    if (!builtFor || !running || builtFor === running) return undefined;
    return { builtFor, running };
  }

  private probeRunningKwinVersion(): Promise<string | undefined> {
    // KWin cannot change under a live session, so probing once keeps the
    // connect retry loop from spawning a process per attempt.
    this.runningKwinVersionPromise ??= this.runningKwinVersion().catch(() => undefined);
    return this.runningKwinVersionPromise;
  }

  private async finishPluginConnection(
    plugin: KWinComputerPluginApi,
    pluginId: string | undefined,
  ): Promise<KWinComputerPluginApi> {
    if (this.disposed) {
      await plugin.stop().catch(() => undefined);
      throw new ComputerBackendError("KWin computer backend is disposed.");
    }
    const health = parseHealth(await plugin.healthJson());
    if (!health.ok) throw new ComputerBackendError("Synara KWin computer-use health check failed.");
    this.plugin = plugin;
    this.pluginId = pluginId;
    this.pluginHealth = health;
    this.reconnectFailures = 0;
    this.reconnecting = false;
    this.healthState.recordConnected();
    this.publishHealth();
    return plugin;
  }

  private invalidateConnection(): void {
    const dbus = this.dbus;
    this.dbus = undefined;
    this.plugin = undefined;
    this.pluginHealth = undefined;
    this.pluginId = undefined;
    this.disconnect?.();
    this.disconnect = undefined;
    void dbus?.close().catch(() => undefined);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return;
    const delayMs = Math.min(
      KWIN_RECONNECT_MAX_DELAY_MS,
      KWIN_RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectFailures,
    );
    this.reconnectFailures = Math.min(this.reconnectFailures + 1, 5);
    // Set before the timer, and cleared only by a successful connection: the
    // attempt the timer runs is part of the same reconnecting state, so a
    // reader between the timer firing and the connection landing must not see
    // the backend as given up on.
    this.reconnecting = true;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensurePlugin({ start: false }).catch(() => this.scheduleReconnect());
    }, delayMs);
    this.reconnectTimer.unref?.();
    this.publishHealth();
  }

  private async readPluginState(plugin: KWinComputerPluginApi): Promise<KWinPluginState> {
    let raw: unknown;
    try {
      raw = await plugin.stateJson();
    } catch (error) {
      throw this.reportPluginFailure(error);
    }
    const parsed = asRecord(parseJsonPayload(raw));
    const position = parseComputerPoint(parsed.position);
    const targetWindowId =
      asString(parsed.targetWindowId) ?? asString(parsed.focusedWindowId) ?? null;
    if (position) this.currentPoint = position;
    return { position, targetWindowId };
  }

  /**
   * The shared glide, driven through the plugin's D-Bus surface. Every timing
   * decision lives in pointerSequencing.ts so a second backend's pointer moves
   * the same way; all this supplies is the transport and the disposal check.
   */
  private async glidePointer(
    plugin: KWinComputerPluginApi,
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
  ): Promise<void> {
    await glidePointerToDeadline({
      sink: this.inputSink(plugin),
      from,
      to,
      durationMs,
      now: () => this.now(),
      sleep: (milliseconds) => this.sleep(milliseconds),
      beforeStep: () => this.throwIfDisposed(),
      onStep: (point) => {
        this.currentPoint = point;
      },
    });
  }

  /**
   * The plugin's evdev-shaped D-Bus API as the shared sequencing sink. Each
   * method carries the operation name through so a refusal still says which half
   * of a press/release pair KWin rejected.
   */
  private inputSink(plugin: KWinComputerPluginApi): ComputerInputSink {
    return {
      movePointer: (x, y, operation) =>
        this.pluginSuccess(operation, () => plugin.movePointer(x, y)),
      button: (code, pressed, operation) =>
        this.pluginSuccess(operation, () => plugin.button(code, pressed)),
      key: (code, pressed, operation) =>
        this.pluginSuccess(operation, () => plugin.key(code, pressed)),
    };
  }

  /**
   * Pointer requests are advisory: KWin clamps a move to the nearest output
   * when the global coordinate lands in a gap between monitors. One state read
   * after the final move tells the caller where the pointer really is without
   * paying a round trip for every intermediate glide step.
   */
  private async pointerResult(
    plugin: KWinComputerPluginApi,
    point: ComputerPoint,
  ): Promise<ComputerBackendActionResult> {
    const actual = await this.readPluginState(plugin)
      .then((state) => state.position)
      .catch(() => null);
    if (
      !actual ||
      (Math.abs(actual.x - point.x) <= POINTER_CLAMP_TOLERANCE_PX &&
        Math.abs(actual.y - point.y) <= POINTER_CLAMP_TOLERANCE_PX)
    ) {
      return { point };
    }
    return { point, clampedTo: actual };
  }

  /**
   * Captures the whole workspace instead of one window. A window capture cannot
   * tell the model where anything sits in the global coordinate space that the
   * pointer tools use, and the focused-window fallback silently resolved to the
   * desktop wallpaper whenever KWin had no better candidate.
   */
  private async captureWorkspaceScreenshot(
    windows: readonly ComputerWindow[],
  ): Promise<ComputerScreenshot> {
    const region = workspaceRectFromWindows(windows, this.pluginHealth?.workspace);
    const bytes = await this.captureRegion(region.x, region.y, region.width, region.height);
    return this.screenshot(bytes, region);
  }

  private screenshot(bytes: Uint8Array, region: ComputerRect): ComputerScreenshot {
    return screenshotFromPng({
      bytes,
      region,
      capturedAt: new Date(this.now()).toISOString(),
      source: CAPTURE_SOURCE,
    });
  }

  /** Workspace geometry without a window round trip when KWin reported it. */
  private async workspaceRect(): Promise<ComputerRect> {
    const workspace = this.pluginHealth?.workspace;
    if (workspace && workspace.width > 0 && workspace.height > 0) {
      return workspaceRectFromWindows([], workspace);
    }
    return workspaceRectFromWindows(await this.listWindows());
  }

  private async publishStillFrame(): Promise<void> {
    const listener = this.streamListener;
    if (
      !listener ||
      this.pluginHealth?.capture !== true ||
      this.stillInFlight ||
      this.capturePending > 0
    )
      return;
    this.stillInFlight = true;
    try {
      const windows = await this.listWindows();
      if (this.capturePending > 0) return;
      const screenshot = await this.captureWorkspaceScreenshot(windows);
      if (this.streamListener !== listener) return;
      const frame = {
        sequence: this.nextSequence++,
        timestampMs: this.now(),
        // Every frame is a complete PNG still. There is no H.264 codec config
        // or delta frame in Tier 1, so the envelope remains keyframe-only.
        keyframe: true,
        codecConfig: false,
        data: Uint8Array.from(Buffer.from(screenshot.bytesBase64, "base64")),
      };
      listener(frame);
      this.emit({ type: "frame", frame });
    } catch {
      // A transient capture failure should not tear down a subscribed stream.
    } finally {
      this.stillInFlight = false;
    }
  }

  private async pressButton(code: number): Promise<void> {
    const plugin = await this.ensurePlugin();
    await pressButtonOnce({
      sink: this.inputSink(plugin),
      code,
      sleep: (milliseconds) => this.sleep(milliseconds),
    });
  }

  /**
   * The plugin refuses input while its session is stopped, which is how the
   * server learns about a stop it never asked for: the idle deadline expiring
   * during a long model turn, or the user's release hotkey. An idle stop is
   * routine, so the session is restarted and the call retried once. A hotkey
   * release is a deliberate human takeover, so it surfaces as a clear error
   * instead of the agent silently grabbing the desktop back.
   */
  private async pluginSuccess(operation: string, invoke: () => Promise<unknown>): Promise<void> {
    if (readBoolean(await this.pluginValue(invoke))) return;
    if (await this.restartAfterExternalStop()) {
      if (readBoolean(await this.pluginValue(invoke))) return;
    }
    throw new ComputerBackendError(`Synara KWin plugin rejected ${operation}.`, {
      retryable: true,
      rejectedOperation: operation,
    });
  }

  private async restartAfterExternalStop(): Promise<boolean> {
    const plugin = this.plugin;
    if (!plugin || this.disposed) return false;
    const health = parseHealth(await this.pluginValue(() => plugin.healthJson()));
    if (!health.ok || health.running) return false;
    this.pluginHealth = health;
    this.publishHealth();
    if (health.releasedByUser) throw new ComputerBackendError(CONTROL_RELEASED_MESSAGE);
    await this.startPlugin(plugin);
    return true;
  }

  private async pluginValue<T>(invoke: () => Promise<T>): Promise<T> {
    try {
      return await invoke();
    } catch (error) {
      throw this.reportPluginFailure(error);
    }
  }

  private enqueueCapture<T>(invoke: () => Promise<T>): Promise<T> {
    this.capturePending += 1;
    const queued = this.captureQueue.then(() => {
      this.throwIfDisposed();
      return invoke();
    });
    this.captureQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued.finally(() => {
      this.capturePending -= 1;
    });
  }

  private throwIfDisposed(): void {
    if (this.disposed) throw new ComputerBackendError("KWin computer backend is disposed.");
  }

  /** The live plugin, or undefined while the connection must be re-established. */
  private connectedPlugin(): KWinComputerPluginApi | undefined {
    return this.pluginHealth?.ok === true ? this.plugin : undefined;
  }

  private recordHealthFailure(error: unknown): void {
    this.healthState.recordFailure(error);
  }

  /** Health rides the window/frame listeners, and only on a real change. */
  private publishHealth(): void {
    this.healthState.publish();
  }

  private emit(event: Parameters<ComputerBackendEventListener>[0]): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // One observer must not prevent the remaining observers from seeing a
        // window or frame update.
      }
    }
  }

  private reportPluginFailure(error: unknown): ComputerBackendError {
    if (dbusErrorType(error) === CONTROL_RELEASED_ERROR_TYPE) {
      return new ComputerBackendError(CONTROL_RELEASED_MESSAGE, { cause: error });
    }
    if (isConnectionLevelFailure(error)) {
      this.recordHealthFailure(error);
      this.invalidateConnection();
      this.scheduleReconnect();
      this.publishHealth();
    }
    if (error instanceof ComputerBackendError) return error;
    return new ComputerBackendError(error instanceof Error ? error.message : String(error), {
      retryable: isConnectionLevelFailure(error),
      cause: error,
    });
  }
}

export function newestPluginId(ids: readonly string[]): string | undefined {
  return ids
    .map((id) => id.replace(/\.so$/, ""))
    .filter((id) => MAX_PLUGIN_ID.test(id))
    .sort((left, right) => pluginVersion(right) - pluginVersion(left))[0];
}

/** Separates Synara plugin ids from the rest of KWin's loaded plugin list. */
export function isSynaraPluginId(id: string): boolean {
  return MAX_PLUGIN_ID.test(id);
}

export type SynaraPluginLoadPlan =
  | { readonly kind: "keep"; readonly pluginId: string }
  | {
      /** Loaded generations to unload, the target included when it is loaded. */
      readonly kind: "replace";
      readonly unload: readonly string[];
      readonly pluginId: string;
    };

/**
 * The one healthy compositor state is exactly one loaded Synara plugin: the
 * newest generation known, loaded or installed. The plugin claims the
 * `org.synara.ComputerUse` bus name only in its constructor, so when several
 * generations are loaded the first registrant owns the name and the rest sit
 * silent — a session that once loaded an old build keeps answering with it (no
 * capture, missing methods) no matter how many newer builds are loaded after
 * it, and an explicit LoadPlugin of the newest returns `false` (already
 * loaded) while the old build keeps serving. Anything other than exactly
 * [newest] is therefore a "replace": unload every loaded generation so the
 * name is free, then load the target. Shared by the host backend's connect
 * path and the nested session's first load. `undefined` when no Synara plugin
 * exists at all, which is not recoverable here.
 */
export function resolveSynaraPluginLoad(options: {
  readonly loaded: readonly string[];
  readonly installed: readonly string[];
}): SynaraPluginLoadPlan | undefined {
  const loadedSynara = options.loaded.filter(isSynaraPluginId);
  const pluginId = newestPluginId([...loadedSynara, ...options.installed]);
  if (!pluginId) return undefined;
  if (loadedSynara.length === 1 && loadedSynara[0] === pluginId) return { kind: "keep", pluginId };
  return { kind: "replace", unload: loadedSynara, pluginId };
}

export async function scanInstalledPluginIds(
  directories: readonly string[] = defaultPluginDirectories(),
): Promise<readonly string[]> {
  const ids = new Set<string>();
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(INSTALLED_PLUGIN_FILE);
      if (match?.[1]) ids.add(match[1]);
    }
  }
  return [...ids].toSorted((left, right) => pluginVersion(right) - pluginVersion(left));
}

function defaultPluginDirectories(): readonly string[] {
  const configured = process.env.SYNARA_KWIN_PLUGIN_DIR;
  return [
    ...(configured ? [configured] : []),
    "/usr/lib64/qt6/plugins/kwin/plugins",
    "/usr/lib/qt6/plugins/kwin/plugins",
  ];
}

/** Mirrors `STATE_ROOT`/`STAMP_FILE` in scripts/install-and-load.sh. */
function defaultInstallStampPath(): string {
  const stateRoot =
    process.env.SYNARA_KWIN_STATE_ROOT ??
    join(
      process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      "synara",
      "kwin-computer-use-plugin",
    );
  return join(stateRoot, "install.stamp");
}

async function readInstallStamp(path: string): Promise<string | undefined> {
  return await readFile(path, "utf8").catch(() => undefined);
}

/** Reads the `kwin_version=` line the installer records for the built plugin. */
function stampKwinVersion(stamp: string | undefined): string | undefined {
  const line = stamp?.split("\n").find((entry) => entry.startsWith("kwin_version="));
  return line ? (KWIN_VERSION_PATTERN.exec(line)?.[0] ?? undefined) : undefined;
}

/**
 * `kwin_wayland --version` prints `kwin <version>` and exits, and it is only
 * spawned on the cold load-refusal path, so a missing or exotic binary just
 * costs the caller the version detail.
 */
function detectRunningKwinVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "kwin_wayland",
      ["--version"],
      { timeout: KWIN_VERSION_PROBE_TIMEOUT_MS },
      (error, stdout) => {
        resolve(error ? undefined : (KWIN_VERSION_PATTERN.exec(stdout)?.[0] ?? undefined));
      },
    );
  });
}

function pluginVersion(id: string): number {
  const match = id.match(MAX_PLUGIN_ID);
  return match?.[1] ? Number(match[1]) : 0;
}

function launchAppError(app: string, error: unknown): ComputerBackendError {
  const message = error instanceof Error ? error.message : String(error);
  return new ComputerBackendError(`Failed to launch ${app}: ${message}`, { cause: error });
}

const CONNECTION_DBUS_ERROR_TYPES = new Set([
  "org.freedesktop.DBus.Error.NoReply",
  "org.freedesktop.DBus.Error.Disconnected",
  "org.freedesktop.DBus.Error.IOError",
  "org.freedesktop.DBus.Error.Timeout",
  // A KWin crash does not drop this backend's session-bus connection — only
  // KWin's bus names vanish, so calls to the stale proxy fail with these two
  // instead of a disconnect. The remedy is the connection-level one: drop the
  // proxy, reconnect, and re-load the plugin into the restarted compositor.
  "org.freedesktop.DBus.Error.ServiceUnknown",
  "org.freedesktop.DBus.Error.NameHasNoOwner",
]);

function isMethodLevelDbusError(error: unknown): boolean {
  const type = dbusErrorType(error);
  if (type?.startsWith("org.synara.ComputerUse.Error.")) return true;
  if (type?.startsWith("org.freedesktop.DBus.Error.")) {
    return !CONNECTION_DBUS_ERROR_TYPES.has(type);
  }
  const cause = errorCause(error);
  return cause !== undefined && cause !== error ? isMethodLevelDbusError(cause) : false;
}

function isUnknownMethodDbusError(error: unknown): boolean {
  if (dbusErrorType(error) === "org.freedesktop.DBus.Error.UnknownMethod") return true;
  const cause = errorCause(error);
  return cause !== undefined && cause !== error ? isUnknownMethodDbusError(cause) : false;
}

function isConnectionLevelFailure(error: unknown): boolean {
  if (error instanceof KWinDbusTimeoutError || hasConnectionLevelMarker(error)) return true;
  if (isMethodLevelDbusError(error)) return false;

  const type = dbusErrorType(error);
  if (type && CONNECTION_DBUS_ERROR_TYPES.has(type)) return true;

  const code = errorField(error, "code");
  if (code === "ENOENT" || code === "ECONNRESET" || code === "EPIPE") return true;

  const message = error instanceof Error ? error.message : String(error);
  if (/(?:closed|disconnected|not connected).*(?:bus|stream|socket|connection)/i.test(message))
    return true;
  if (
    /(?:bus|stream|socket|connection).*(?:closed|disconnected|not connected|reset|refused)/i.test(
      message,
    )
  )
    return true;
  if (/\b(?:ENOENT|ECONNRESET|EPIPE)\b/i.test(message)) return true;

  const cause = errorCause(error);
  if (cause !== undefined && cause !== error) return isConnectionLevelFailure(cause);
  if (error instanceof ComputerBackendError) return error.retryable;
  return true;
}

function dbusErrorType(error: unknown): string | undefined {
  const type = errorField(error, "type");
  if (typeof type === "string") return type;
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/org\.(?:synara\.ComputerUse|freedesktop\.DBus)\.Error\.[\w.]+/)?.[0];
}

function errorCause(error: unknown): unknown {
  return errorField(error, "cause");
}

function errorField(error: unknown, field: string): unknown {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

function hasConnectionLevelMarker(error: unknown): boolean {
  return errorField(error, "connectionLevel") === true;
}

function parseHealth(value: unknown): KWinHealth {
  const record = asRecord(parseJsonPayload(value));
  return {
    ok: record.ok === true,
    running: record.running === true,
    capture: record.capture === true,
    releasedByUser: record.releasedByUser === true,
    workspace: parseWorkspaceGeometry(record),
  };
}

function parseWorkspaceGeometry(record: Record<string, unknown>): ComputerRect | null {
  const workspace = asRecord(record.workspace);
  return (
    parseComputerRect(record.workspaceGeometry) ??
    parseComputerRect(record.workspace) ??
    parseComputerRect(workspace.geometry) ??
    parseComputerRect(workspace.bounds) ??
    null
  );
}

function readBoolean(value: unknown): boolean {
  const unwrapped = unwrapDbusValue(value);
  return unwrapped === true;
}

function readByteArray(value: unknown): Uint8Array {
  const unwrapped = unwrapDbusValue(value);
  if (unwrapped instanceof Uint8Array) {
    if (unwrapped.byteLength === 0 || unwrapped.byteLength > MAX_CAPTURE_BYTES) {
      throw new ComputerBackendError("Synara KWin capture exceeded the PNG size limit.");
    }
    return Uint8Array.from(unwrapped);
  }
  if (
    Array.isArray(unwrapped) &&
    unwrapped.length > 0 &&
    unwrapped.length <= MAX_CAPTURE_BYTES &&
    unwrapped.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return Uint8Array.from(unwrapped as number[]);
  }
  throw new ComputerBackendError("Synara KWin capture returned invalid PNG bytes.");
}

/**
 * `SYNARA_COMPUTER_IDLE_TIMEOUT_MS` is an operator override, so a typo must
 * neither crash the backend nor silently disable the plugin-side deadline:
 * anything that is not `0` or a millisecond count up to an hour is dropped and
 * the default applies. Accepted values still pass through normalizeIdleTimeout.
 */
function parseIdleTimeoutEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAX_IDLE_TIMEOUT_MS) {
    return undefined;
  }
  return milliseconds;
}

function normalizeIdleTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_IDLE_TIMEOUT_MS;
  const milliseconds = Math.floor(value);
  if (milliseconds <= 0) return 0;
  return Math.max(MIN_IDLE_TIMEOUT_MS, Math.min(MAX_IDLE_TIMEOUT_MS, milliseconds));
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CAPTURE_MAX_DIMENSION;
  return Math.max(1, Math.min(32_768, Math.floor(value)));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
