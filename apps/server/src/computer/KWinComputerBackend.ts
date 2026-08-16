import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";

import type {
  ComputerAvailability,
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
import { AtspiHelperClient, type AtspiTreeReader } from "./atspiClient.ts";
import {
  atspiTextWriteAddress,
  describeComputerUiTree,
  fuseAtspiTrees,
  type AtspiWindowTree,
} from "./atspiTreeTargeting.ts";
import {
  createSessionKWinComputerDbus,
  KWinDbusTimeoutError,
  type KWinComputerDbus,
  type KWinComputerPluginApi,
} from "./kwinDbus.ts";
import {
  EVDEV_BUTTON_CODES,
  EVDEV_KEY_CODES,
  keyStrokeForKey,
  pointerGlideSteps,
  qwertyTextKeyStrokes,
  type QwertyKeyStroke,
} from "./kwinInput.ts";

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
const MAX_PLUGIN_ID = /^SynaraComputerUsePlugin(?:V(\d+))?$/;
const INSTALLED_PLUGIN_FILE = /^(SynaraComputerUsePluginV(\d+))\.so$/;
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PNG_IHDR = Uint8Array.of(0x49, 0x48, 0x44, 0x52);

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
  readonly atspi?: AtspiTreeReader;
  readonly installedPluginIds?: () => Promise<readonly string[]>;
  readonly pluginDirectories?: readonly string[];
  readonly platform?: string;
  readonly sessionType?: string;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly spawnProcess?: (app: string, args: readonly string[]) => ChildProcess;
  readonly glideDurationMs?: number;
  readonly stillIntervalMs?: number;
  readonly captureMaxDimension?: number;
  /** Plugin-side session deadline. `0` disables it; see the Phase 3b notes. */
  readonly idleTimeoutMs?: number;
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
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly glideDurationMs: number;
  private readonly stillIntervalMs: number;
  private readonly captureMaxDimension: number;
  private readonly idleTimeoutMs: number;
  private readonly atspi: AtspiTreeReader;
  private readonly dbusFactory: () => Promise<KWinComputerDbus>;
  private readonly installedPluginIds: () => Promise<readonly string[]>;

  private dbus: KWinComputerDbus | undefined;
  private plugin: KWinComputerPluginApi | undefined;
  private pluginId: string | undefined;
  private health: KWinHealth | undefined;
  private disconnect: (() => void) | undefined;
  private connectPromise: Promise<KWinComputerPluginApi> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectFailures = 0;
  private disposed = false;
  private streamListener: ComputerFrameListener | undefined;
  private streamTimer: ReturnType<typeof setInterval> | undefined;
  private stillInFlight = false;
  private captureQueue: Promise<void> = Promise.resolve();
  private capturePending = 0;
  private startPromise: Promise<void> | undefined;
  private readonly spawnProcess: (app: string, args: readonly string[]) => ChildProcess;
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
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
    this.spawnProcess =
      options.spawnProcess ??
      ((app, args) => spawn(app, [...args], { detached: true, stdio: "ignore" }));
    this.glideDurationMs = Math.max(0, options.glideDurationMs ?? DEFAULT_GLIDE_DURATION_MS);
    this.stillIntervalMs = Math.max(100, options.stillIntervalMs ?? DEFAULT_STILL_INTERVAL_MS);
    this.captureMaxDimension = Math.max(
      1,
      Math.min(32_768, Math.floor(options.captureMaxDimension ?? DEFAULT_CAPTURE_MAX_DIMENSION)),
    );
    this.idleTimeoutMs = normalizeIdleTimeout(options.idleTimeoutMs);
    this.atspi = options.atspi ?? new AtspiHelperClient();
    this.dbus = options.dbus;
    this.dbusFactory =
      options.dbusFactory ??
      (options.dbus ? async () => options.dbus! : createSessionKWinComputerDbus);
    this.installedPluginIds =
      options.installedPluginIds ??
      (() => scanInstalledPluginIds(options.pluginDirectories ?? defaultPluginDirectories()));
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
      this.health = health;
      return { kind: "available", backend: "kwin" };
    } catch (error) {
      const failure = this.reportPluginFailure(error);
      return {
        kind: "backend-unavailable",
        message: failure.message,
      };
    }
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
    return screenSizeFromWindows(windows, this.health?.workspace);
  }

  async getState(options: {
    readonly includeScreenshot?: boolean;
    readonly includeText?: boolean;
  }): Promise<ComputerState> {
    await this.ensurePlugin({ start: false });
    // listWindows already reads the plugin state to resolve the focused window,
    // so a second stateJson round trip here would only add latency.
    const windows = await this.listWindows();
    const screenSize = screenSizeFromWindows(windows, this.health?.workspace);
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
      options.includeScreenshot && this.health?.capture === true
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

  async clearFocusWindow(): Promise<void> {
    const plugin = await this.ensurePlugin();
    await this.pluginSuccess("clearFocusWindow", () => plugin.clearFocusWindow());
  }

  async launchApp(app: string, args: readonly string[]): Promise<ComputerLaunchAppResult> {
    await this.ensurePlugin();
    let child: ChildProcess;
    try {
      child = this.spawnProcess(app, args);
    } catch (error) {
      throw launchAppError(app, error);
    }

    return await new Promise<ComputerLaunchAppResult>((resolve, reject) => {
      const result = { computerId: this.computerId, app, window: null } as ComputerLaunchAppResult;
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
    await this.moveCursor(from);
    this.throwIfDisposed();
    await this.pluginSuccess("button", () => plugin.button(EVDEV_BUTTON_CODES.left, true));
    try {
      await this.glidePointer(plugin, from, to, durationMs);
    } finally {
      if (!this.disposed) {
        await this.pluginSuccess("button release", () =>
          plugin.button(EVDEV_BUTTON_CODES.left, false),
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
    for (const stroke of strokes) await this.emitStroke(plugin, stroke);
    return { value: text };
  }

  async pressKey(key: string): Promise<ComputerBackendActionResult> {
    const stroke = keyStrokeForKey(key);
    const plugin = await this.ensurePlugin();
    await this.emitStroke(plugin, stroke);
    return {};
  }

  async hotkey(keys: readonly string[]): Promise<ComputerBackendActionResult> {
    const strokes = keys.map(keyStrokeForKey);
    const plugin = await this.ensurePlugin();
    const releases: number[] = [];
    try {
      for (const stroke of strokes) {
        if (stroke.shift) {
          await this.pluginSuccess("key", () => plugin.key(EVDEV_KEY_CODES.LeftShift, true));
          releases.push(EVDEV_KEY_CODES.LeftShift);
        }
        await this.pluginSuccess("key", () => plugin.key(stroke.code, true));
        releases.push(stroke.code);
      }
    } finally {
      for (const code of releases.toReversed()) {
        await this.pluginSuccess("key release", () => plugin.key(code, false));
      }
    }
    return {};
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
    if (this.health?.capture !== true) {
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
    if (this.health?.capture !== true) {
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
        window.bounds,
        workspaceRectFromWindows(windows, this.health?.workspace),
      );
      if (!region) {
        throw new ComputerBackendError(
          `Window ${JSON.stringify(request.windowId)} sits outside the desktop workspace and has nothing to capture.`,
        );
      }
      return this.screenshotFromPng(
        await this.captureWindow(request.windowId, maxDimension),
        region,
      );
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
    return this.screenshotFromPng(
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
    const plugin = this.plugin;
    if (plugin) await plugin.stop().catch(() => undefined);
    this.disconnect?.();
    this.disconnect = undefined;
    await this.dbus?.close().catch(() => undefined);
    this.dbus = undefined;
    this.plugin = undefined;
    this.health = undefined;
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
    if (this.plugin && this.health?.ok === true) return this.plugin;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectWithBackoff()
      .catch((error) => {
        if (!isMethodLevelDbusError(error)) this.scheduleReconnect();
        throw error;
      })
      .finally(() => {
        this.connectPromise = undefined;
      });
    return this.connectPromise;
  }

  private async startPlugin(plugin: KWinComputerPluginApi): Promise<void> {
    if (this.disposed) throw new ComputerBackendError("KWin computer backend is disposed.");
    if (this.health?.running === true) return;
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
        this.health = runningHealth;
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
    const loadedPlugin = newestPluginId(loaded);
    const installed = loadedPlugin ? [] : await this.installedPluginIds();
    const selectedPlugin = loadedPlugin ?? newestPluginId(installed);
    if (!selectedPlugin) {
      throw new ComputerBackendError(
        "No installed SynaraComputerUsePluginVn was found in the KWin plugin directories.",
      );
    }
    if (!loadedPlugin) {
      const loaded = await dbus.loadPlugin(selectedPlugin);
      if (!loaded) throw new ComputerBackendError(`KWin refused to load ${selectedPlugin}.`);
    }
    const plugin = await dbus.connectPlugin();
    return await this.finishPluginConnection(plugin, selectedPlugin);
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
    this.health = health;
    this.reconnectFailures = 0;
    return plugin;
  }

  private invalidateConnection(): void {
    const dbus = this.dbus;
    this.dbus = undefined;
    this.plugin = undefined;
    this.health = undefined;
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensurePlugin({ start: false }).catch(() => this.scheduleReconnect());
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async readPluginState(plugin: KWinComputerPluginApi): Promise<KWinPluginState> {
    let raw: unknown;
    try {
      raw = await plugin.stateJson();
    } catch (error) {
      throw this.reportPluginFailure(error);
    }
    const parsed = asRecord(parseJson(raw));
    const position = asPoint(parsed.position);
    const targetWindowId =
      asString(parsed.targetWindowId) ?? asString(parsed.focusedWindowId) ?? null;
    if (position) this.currentPoint = position;
    return { position, targetWindowId };
  }

  /**
   * Walks an eased path against a wall-clock deadline instead of a fixed sleep
   * per step, so a glide or drag lands at roughly the duration the caller asked
   * for. Each step sleeps only the remainder up to its deadline, which means a
   * slow D-Bus round trip eats into that step's sleep budget rather than adding
   * to the total, and a duration of `0` sleeps not at all.
   */
  private async glidePointer(
    plugin: KWinComputerPluginApi,
    from: ComputerPoint,
    to: ComputerPoint,
    durationMs: number,
  ): Promise<void> {
    const startedAt = this.now();
    for (const step of pointerGlideSteps(from, to, durationMs)) {
      this.throwIfDisposed();
      await this.pluginSuccess("movePointer", () => plugin.movePointer(step.point.x, step.point.y));
      this.currentPoint = step.point;
      const remainingMs = startedAt + step.offsetMs - this.now();
      if (remainingMs > 0) await this.sleep(remainingMs);
    }
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
    const region = workspaceRectFromWindows(windows, this.health?.workspace);
    const bytes = await this.captureRegion(region.x, region.y, region.width, region.height);
    return this.screenshotFromPng(bytes, region);
  }

  /**
   * The screenshot payload is only useful to a model when the desktop rect it
   * covers travels with it, so every capture path builds it the same way:
   * `desktop = region.origin + screenshot_pixel / scale`.
   */
  private screenshotFromPng(bytes: Uint8Array, region: ComputerRect): ComputerScreenshot {
    const dimensions = readPngDimensions(bytes);
    return {
      mimeType: "image/png",
      width: dimensions.width,
      height: dimensions.height,
      sizeBytes: bytes.byteLength,
      bytesBase64: Buffer.from(bytes).toString("base64"),
      region,
      scale: dimensions.width / region.width,
      capturedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Workspace geometry without a window round trip when KWin reported it. */
  private async workspaceRect(): Promise<ComputerRect> {
    const workspace = this.health?.workspace;
    if (workspace && workspace.width > 0 && workspace.height > 0) {
      return workspaceRectFromWindows([], workspace);
    }
    return workspaceRectFromWindows(await this.listWindows());
  }

  private async publishStillFrame(): Promise<void> {
    const listener = this.streamListener;
    if (!listener || this.health?.capture !== true || this.stillInFlight || this.capturePending > 0)
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

  private async emitStroke(plugin: KWinComputerPluginApi, stroke: QwertyKeyStroke): Promise<void> {
    if (stroke.shift) {
      await this.pluginSuccess("key", () => plugin.key(EVDEV_KEY_CODES.LeftShift, true));
    }
    try {
      await this.pluginSuccess("key", () => plugin.key(stroke.code, true));
      await this.pluginSuccess("key release", () => plugin.key(stroke.code, false));
    } finally {
      if (stroke.shift) {
        await this.pluginSuccess("shift release", () =>
          plugin.key(EVDEV_KEY_CODES.LeftShift, false),
        );
      }
    }
  }

  private async pressButton(code: number): Promise<void> {
    const plugin = await this.ensurePlugin();
    await this.pluginSuccess("button", () => plugin.button(code, true));
    try {
      await this.sleep(20);
    } finally {
      await this.pluginSuccess("button release", () => plugin.button(code, false));
    }
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
    });
  }

  private async restartAfterExternalStop(): Promise<boolean> {
    const plugin = this.plugin;
    if (!plugin || this.disposed) return false;
    const health = parseHealth(await this.pluginValue(() => plugin.healthJson()));
    if (!health.ok || health.running) return false;
    this.health = health;
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
      this.invalidateConnection();
      this.scheduleReconnect();
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
  const record = asRecord(parseJson(value));
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
    parseRect(record.workspaceGeometry) ??
    parseRect(record.workspace) ??
    parseRect(workspace.geometry) ??
    parseRect(workspace.bounds) ??
    null
  );
}

function parseWindows(value: unknown, focusedWindowId: string | null): ComputerWindow[] {
  const parsed = parseJson(value);
  const items = Array.isArray(parsed) ? parsed : [];
  const windows: ComputerWindow[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const id = asString(record.id) ?? asString(record.windowId);
    const bounds = parseRect(record.bounds);
    if (!id || !bounds) continue;
    const title = asString(record.title) ?? "";
    const appName = asString(record.appId) ?? asString(record.resourceClass);
    const pid =
      typeof record.pid === "number" && record.pid > 0 ? Math.trunc(record.pid) : undefined;
    windows.push({
      id: id as ComputerWindow["id"],
      title,
      ...(appName ? { appName } : {}),
      ...(pid ? { pid } : {}),
      bounds,
      focused: record.focused === true || id === focusedWindowId,
      minimized: record.minimized === true,
      visible: record.visible !== false,
    });
  }
  return windows;
}

/**
 * Resolves the global desktop rect. KWin's reported workspace geometry is the
 * source of truth; the window bounding box is the fallback for a plugin build
 * that does not report it yet.
 */
export function workspaceRectFromWindows(
  windows: readonly ComputerWindow[],
  workspace?: ComputerRect | null,
): ComputerRect {
  if (workspace && workspace.width > 0 && workspace.height > 0) {
    return {
      x: Math.floor(workspace.x),
      y: Math.floor(workspace.y),
      width: Math.max(1, Math.ceil(workspace.width)),
      height: Math.max(1, Math.ceil(workspace.height)),
    };
  }
  const left = Math.min(0, ...windows.map((window) => Math.floor(window.bounds.x)));
  const top = Math.min(0, ...windows.map((window) => Math.floor(window.bounds.y)));
  const right = Math.max(
    left + 1,
    ...windows.map((window) => Math.ceil(window.bounds.x + window.bounds.width)),
  );
  const bottom = Math.max(
    top + 1,
    ...windows.map((window) => Math.ceil(window.bounds.y + window.bounds.height)),
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Snaps a requested region onto whole logical pixels without losing coverage:
 * the D-Bus capture signature only takes integers, so a fractional rect must
 * grow outward instead of cropping the edge the caller asked for.
 */
function alignRect(rect: ComputerRect): ComputerRect {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  return {
    x,
    y,
    width: Math.max(1, Math.ceil(rect.x + rect.width) - x),
    height: Math.max(1, Math.ceil(rect.y + rect.height) - y),
  };
}

function formatRect(rect: ComputerRect): string {
  return `${rect.width}x${rect.height} at (${rect.x}, ${rect.y})`;
}

export function screenSizeFromWindows(
  windows: readonly ComputerWindow[],
  workspace?: ComputerRect | null,
): ComputerScreenSize {
  const rect = workspaceRectFromWindows(windows, workspace);
  return { width: rect.width, height: rect.height, scale: 1 };
}

function parseJson(value: unknown): unknown {
  const unwrapped = unwrapDbusValue(value);
  if (typeof unwrapped === "string") {
    try {
      return JSON.parse(unwrapped);
    } catch {
      return null;
    }
  }
  return unwrapped;
}

function unwrapDbusValue(value: unknown): unknown {
  if (isDbusVariant(value)) {
    return unwrapDbusValue((value as { readonly value: unknown }).value);
  }
  return value;
}

function isDbusVariant(
  value: unknown,
): value is { readonly signature: string; readonly value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly signature?: unknown }).signature === "string" &&
    "value" in value
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

export function readPngDimensions(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
} {
  if (
    bytes.byteLength < 24 ||
    !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) ||
    !PNG_IHDR.every((byte, index) => bytes[12 + index] === byte)
  ) {
    throw new ComputerBackendError("Synara KWin capture did not return a PNG image.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1)
    throw new ComputerBackendError("Synara KWin capture has invalid dimensions.");
  return { width, height };
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

function parseRect(value: unknown): ComputerRect | undefined {
  const record = asRecord(value);
  const x = asFiniteNumber(record.x);
  const y = asFiniteNumber(record.y);
  const width = asFiniteNumber(record.width);
  const height = asFiniteNumber(record.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined)
    return undefined;
  if (width < 0 || height < 0) return undefined;
  return { x, y, width, height };
}

function asPoint(value: unknown): ComputerPoint | null {
  const record = asRecord(value);
  const x = asFiniteNumber(record.x);
  const y = asFiniteNumber(record.y);
  return x === undefined || y === undefined ? null : { x, y };
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
