import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComputerWindow } from "@synara/contracts";

import {
  KWinComputerBackend,
  newestPluginId,
  type KWinComputerBackendOptions,
} from "./KWinComputerBackend.ts";
import type { ComputerResolvedTarget } from "./ComputerBackend.ts";
import type { AtspiTextWrite, AtspiTreeReader } from "./atspiClient.ts";
import type { KWinComputerDbus, KWinComputerPluginApi } from "./kwinDbus.ts";
import { GLIDE_FRAME_INTERVAL_MS } from "./kwinInput.ts";

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

/**
 * A PNG header carrying the requested dimensions. Only the IHDR size fields are
 * read back, which is what the region/scale mapping is derived from.
 */
function pngOfSize(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(PNG_1X1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

class FakePlugin implements KWinComputerPluginApi {
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  capture = true;
  captureBytes: Uint8Array = PNG_1X1;
  running = false;
  workspace:
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined;
  captureFailure: Error | undefined;
  releasedByUser = false;
  idleTimeoutMs: number | undefined;
  idleTimeoutFailure: Error | undefined;
  position: { readonly x: number; readonly y: number } = { x: 0, y: 0 };
  /** Mirrors KWin clamping a pointer move to the nearest output. */
  clampPointer: ((x: number, y: number) => { readonly x: number; readonly y: number }) | undefined;
  windows: readonly ComputerWindow[] = [
    {
      id: "window-1",
      title: "Terminal",
      appName: "org.kde.konsole",
      pid: 123,
      bounds: { x: 956, y: 1519, width: 648, height: 518 },
      focused: true,
      minimized: false,
      visible: true,
    },
  ];

  healthJson = async () =>
    JSON.stringify({
      ok: true,
      running: this.running,
      capture: this.capture,
      releasedByUser: this.releasedByUser,
      idleTimeoutMs: this.idleTimeoutMs ?? 300_000,
      kwinVersion: "6.7.3",
      ...(this.workspace ? { workspaceGeometry: this.workspace } : {}),
    });
  stateJson = async () => JSON.stringify({ position: this.position, targetWindowId: "window-1" });
  windowsJson = async () => JSON.stringify(this.windows);
  start = async () => {
    this.calls.push({ method: "start", args: [] });
    if (this.releasedByUser) {
      throw dbusError(
        "org.synara.ComputerUse.Error.ControlReleased",
        "computer control was released with Meta+Shift+Esc",
      );
    }
    this.running = true;
    return true;
  };
  stop = async () => {
    this.running = false;
    this.releasedByUser = false;
    return this.recordResult("stop");
  };
  setIdleTimeout = async (milliseconds: number) => {
    this.calls.push({ method: "setIdleTimeout", args: [milliseconds] });
    if (this.idleTimeoutFailure) throw this.idleTimeoutFailure;
    this.idleTimeoutMs = milliseconds;
    return true;
  };
  focusWindow = async (windowId: string) => this.recordInput("focusWindow", windowId);
  raiseWindowFailure: Error | undefined;
  raiseWindow = async (windowId: string) => {
    if (this.raiseWindowFailure) {
      this.calls.push({ method: "raiseWindow", args: [windowId] });
      throw this.raiseWindowFailure;
    }
    return this.recordInput("raiseWindow", windowId);
  };
  clearFocusWindow = async () => this.recordInput("clearFocusWindow");
  movePointer = async (x: number, y: number) => {
    if (this.running) this.position = this.clampPointer?.(x, y) ?? { x, y };
    return this.recordInput("movePointer", x, y);
  };
  button = async (code: number, pressed: boolean) => this.recordInput("button", code, pressed);
  axis = async (horizontal: number, vertical: number) =>
    this.recordInput("axis", horizontal, vertical);
  key = async (code: number, pressed: boolean) => this.recordInput("key", code, pressed);
  captureWindow = async (windowId: string, maxDimension: number) => {
    this.calls.push({ method: "captureWindow", args: [windowId, maxDimension] });
    if (this.captureFailure) throw this.captureFailure;
    return this.capture ? this.captureBytes : Uint8Array.of();
  };
  captureRegion = async (
    x: number,
    y: number,
    width: number,
    height: number,
    maxDimension: number,
  ) => {
    this.calls.push({ method: "captureRegion", args: [x, y, width, height, maxDimension] });
    if (this.captureFailure) throw this.captureFailure;
    return this.capture ? this.captureBytes : Uint8Array.of();
  };

  private recordResult(method: string, ...args: readonly unknown[]): true {
    this.calls.push({ method, args });
    return true;
  }

  /** Mirrors the plugin refusing every input while the session is stopped. */
  private recordInput(method: string, ...args: readonly unknown[]): boolean {
    this.calls.push({ method, args });
    return this.running;
  }
}

class FakeDbus implements KWinComputerDbus {
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  readonly plugin: FakePlugin;
  loaded: readonly string[] = [];
  private disconnectListener: (() => void) | undefined;

  constructor(plugin = new FakePlugin()) {
    this.plugin = plugin;
  }

  listLoadedPluginIds = async () => {
    this.calls.push({ method: "loadedPlugins", args: [] });
    return this.loaded;
  };
  loadPlugin = async (pluginId: string) => {
    this.calls.push({ method: "LoadPlugin", args: [pluginId] });
    this.loaded = [pluginId];
    return true;
  };
  connectPlugin = async () => {
    this.calls.push({ method: "connectPlugin", args: [] });
    return this.plugin;
  };
  onDisconnect = (listener: () => void) => {
    this.disconnectListener = listener;
    return () => {
      if (this.disconnectListener === listener) this.disconnectListener = undefined;
    };
  };
  close = async () => {
    this.calls.push({ method: "close", args: [] });
  };
  disconnect = () => this.disconnectListener?.();
}

const atspi: AtspiTreeReader = {
  readTrees: async () => [],
  setText: async () => false,
  dispose: async () => undefined,
};

function makeBackend(
  dbus: FakeDbus,
  options: Omit<KWinComputerBackendOptions, "dbus"> = {},
): KWinComputerBackend {
  return new KWinComputerBackend({
    ...options,
    dbus,
    atspi: options.atspi ?? atspi,
    platform: "linux",
    sessionType: "wayland",
    installedPluginIds:
      options.installedPluginIds ??
      (async () => ["SynaraComputerUsePluginV2", "SynaraComputerUsePluginV10"]),
    sleep: options.sleep ?? (async () => undefined),
    // Never let a test read the real installer stamp or spawn kwin_wayland.
    installStampPath: options.installStampPath ?? join(tmpdir(), "synara-absent-install.stamp"),
    runningKwinVersion: options.runningKwinVersion ?? (async () => undefined),
  });
}

/** A semantic target resolved against the fake plugin's only window. */
function resolvedTarget(options: { readonly editable: boolean }): ComputerResolvedTarget {
  return {
    target: { label: "Name", role: "entry" },
    point: { x: 1_000, y: 1_600 },
    node: {
      role: "entry",
      label: "Name",
      value: null,
      description: null,
      frame: { x: 980, y: 1_580, width: 200, height: 40 },
      activationPoint: null,
      onScreen: true,
      windowId: "window-1" as ComputerWindow["id"],
      nodePath: [1, 2],
      editable: options.editable,
      children: [],
    },
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

interface FakeClock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly advance: (milliseconds: number) => void;
  readonly sleeps: number[];
}

/** Virtual clock: an injected sleep is the only thing that passes time for free. */
function fakeClock(): FakeClock {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      nowMs += milliseconds;
    },
    advance: (milliseconds) => {
      nowMs += milliseconds;
    },
    sleeps,
  };
}

interface PointerTimelineEntry {
  readonly method: "movePointer" | "press" | "release";
  readonly at: number;
}

/**
 * Makes every pointer D-Bus call cost `callMs` of virtual time so a test can
 * tell duration-derived pacing (latency comes out of the sleep budget) from the
 * old fixed per-step sleep (latency was added on top).
 */
function instrumentPointer(
  plugin: FakePlugin,
  clock: FakeClock,
  callMs: number,
): PointerTimelineEntry[] {
  const timeline: PointerTimelineEntry[] = [];
  const movePointer = plugin.movePointer;
  plugin.movePointer = async (x, y) => {
    timeline.push({ method: "movePointer", at: clock.now() });
    clock.advance(callMs);
    return movePointer(x, y);
  };
  const button = plugin.button;
  plugin.button = async (code, pressed) => {
    timeline.push({ method: pressed ? "press" : "release", at: clock.now() });
    return button(code, pressed);
  };
  return timeline;
}

function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function dbusError(type: string, message: string): Error {
  const error = new Error(message) as Error & { type: string };
  error.name = "DBusError";
  error.type = type;
  return error;
}

class FakeChild extends EventEmitter {
  readonly unref = vi.fn();
}

describe("newestPluginId", () => {
  it("selects the newest versioned plugin id", () => {
    expect(newestPluginId(["SynaraComputerUsePluginV2", "SynaraComputerUsePluginV10"])).toBe(
      "SynaraComputerUsePluginV10",
    );
    expect(newestPluginId(["OtherPlugin"])).toBeUndefined();
  });
});

describe("KWinComputerBackend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads the newest installed plugin and passes the health gate", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await expect(backend.availability()).resolves.toEqual({ kind: "available", backend: "kwin" });
    expect(dbus.plugin.calls.some((call) => call.method === "start")).toBe(false);
    expect(dbus.calls).toContainEqual({
      method: "LoadPlugin",
      args: ["SynaraComputerUsePluginV10"],
    });

    await backend.dispose();
    expect(dbus.plugin.calls).toContainEqual({ method: "stop", args: [] });
    expect(dbus.calls).toContainEqual({ method: "close", args: [] });
  });

  it("starts the plugin on the first real action after a side-effect-free probe", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(0);

    await backend.focusWindow("window-1");
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(1);

    await backend.availability();
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(1);
    await backend.dispose();
  });

  it("configures the plugin idle timeout on every session start", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { idleTimeoutMs: 90_000 });

    await backend.focusWindow("window-1");
    expect(dbus.plugin.calls).toContainEqual({ method: "setIdleTimeout", args: [90_000] });
    expect(dbus.plugin.idleTimeoutMs).toBe(90_000);

    await backend.dispose();
  });

  it("takes the idle timeout from SYNARA_COMPUTER_IDLE_TIMEOUT_MS", async () => {
    vi.stubEnv("SYNARA_COMPUTER_IDLE_TIMEOUT_MS", "120000");
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await backend.focusWindow("window-1");
    expect(dbus.plugin.idleTimeoutMs).toBe(120_000);

    await backend.dispose();
  });

  it("disables the idle timeout when the environment sets it to zero", async () => {
    vi.stubEnv("SYNARA_COMPUTER_IDLE_TIMEOUT_MS", "0");
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await backend.focusWindow("window-1");
    expect(dbus.plugin.idleTimeoutMs).toBe(0);

    await backend.dispose();
  });

  it.each(["not-a-number", "", "-1", "3600001"])(
    "falls back to the default idle timeout for %j",
    async (value) => {
      vi.stubEnv("SYNARA_COMPUTER_IDLE_TIMEOUT_MS", value);
      const dbus = new FakeDbus();
      const backend = makeBackend(dbus);

      await backend.focusWindow("window-1");
      expect(dbus.plugin.idleTimeoutMs).toBe(300_000);

      await backend.dispose();
    },
  );

  it("prefers an explicit idle timeout over the environment", async () => {
    vi.stubEnv("SYNARA_COMPUTER_IDLE_TIMEOUT_MS", "120000");
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { idleTimeoutMs: 45_000 });

    await backend.focusWindow("window-1");
    expect(dbus.plugin.idleTimeoutMs).toBe(45_000);

    await backend.dispose();
  });

  it("keeps the session usable when the plugin has no setIdleTimeout", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.idleTimeoutFailure = dbusError(
      "org.freedesktop.DBus.Error.UnknownMethod",
      "No such method 'setIdleTimeout'",
    );
    const backend = makeBackend(dbus);

    await expect(backend.focusWindow("window-1")).resolves.toBeUndefined();

    await backend.dispose();
  });

  it("restarts the session when the plugin idle timeout stopped it mid-turn", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.focusWindow("window-1");
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(1);

    // The plugin auto-stopped while the model was thinking; the server still
    // believes the session is running.
    dbus.plugin.running = false;

    await expect(backend.click({ x: 44, y: 44 })).resolves.toEqual({ point: { x: 44, y: 44 } });
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(2);
    expect(dbus.plugin.running).toBe(true);

    await backend.dispose();
  });

  it("refuses to take control back after the release hotkey", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.focusWindow("window-1");

    dbus.plugin.running = false;
    dbus.plugin.releasedByUser = true;

    await expect(backend.click({ x: 44, y: 44 })).rejects.toThrow(/Meta\+Shift\+Esc/);
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(1);
    expect(dbus.plugin.running).toBe(false);

    await backend.dispose();
  });

  it("explains a released-control error raised by start itself", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.releasedByUser = true;
    const backend = makeBackend(dbus);

    await expect(backend.focusWindow("window-1")).rejects.toThrow(/hand control back/);

    await backend.dispose();
  });

  it("does not load when KWin already reports a Synara plugin", async () => {
    const dbus = new FakeDbus();
    dbus.loaded = ["SynaraComputerUsePluginV4"];
    const backend = makeBackend(dbus);

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(dbus.calls.some((call) => call.method === "LoadPlugin")).toBe(false);
    await backend.dispose();
  });

  it("falls back to the existing Synara service when loadedPlugins is unavailable", async () => {
    const dbus = new FakeDbus();
    dbus.listLoadedPluginIds = async () => {
      throw new Error("org.freedesktop.DBus.Error.UnknownMethod");
    };
    const backend = makeBackend(dbus);

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(dbus.calls.some((call) => call.method === "LoadPlugin")).toBe(false);
    await backend.dispose();
  });

  it("reports an installed-plugin diagnostic when the KWin bus has no candidate", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { installedPluginIds: async () => [] });

    const availability = await backend.availability();
    expect(availability).toMatchObject({ kind: "backend-unavailable" });
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).toContain("No installed SynaraComputerUsePluginVn");
    expect(message).toContain("scripts/install-and-load.sh");
    await backend.dispose();
  });

  it("names the KWin version mismatch when LoadPlugin is refused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "synara-kwin-stamp-"));
    const installStampPath = join(directory, "install.stamp");
    await writeFile(
      installStampPath,
      "signature=abc\nplugin_id=SynaraComputerUsePluginV10\nkwin_version=kwin 6.7.2\n",
      "utf8",
    );
    const dbus = new FakeDbus();
    dbus.loadPlugin = async () => false;
    const backend = makeBackend(dbus, {
      installStampPath,
      runningKwinVersion: async () => "6.7.3",
    });

    const availability = await backend.availability();
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).toContain("KWin refused to load SynaraComputerUsePluginV10");
    expect(message).toContain("built for KWin 6.7.2, but KWin 6.7.3 is running");
    expect(message).toContain("scripts/install-and-load.sh");
    expect(message).toContain("systemd/enable.sh");
    await backend.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps the load-refusal message generic when no version pair is known", async () => {
    const dbus = new FakeDbus();
    dbus.loadPlugin = async () => false;
    const backend = makeBackend(dbus);

    const availability = await backend.availability();
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).toContain("KWin refused to load SynaraComputerUsePluginV10");
    expect(message).toContain("built against");
    expect(message).not.toContain("is running.");
    expect(message).toContain("scripts/install-and-load.sh");
    expect(message).toContain("systemd/enable.sh");
    await backend.dispose();
  });

  it("omits the versions when the stamp matches the running KWin", async () => {
    const dbus = new FakeDbus();
    dbus.loadPlugin = async () => false;
    const backend = makeBackend(dbus, {
      readInstallStamp: async () => "kwin_version=kwin 6.7.3\n",
      runningKwinVersion: async () => "6.7.3",
    });

    const availability = await backend.availability();
    const message = availability.kind === "backend-unavailable" ? availability.message : "";
    expect(message).not.toContain("6.7.3");
    expect(message).toContain("built against");
    await backend.dispose();
  });

  it("probes the running KWin version once across connect retries", async () => {
    const dbus = new FakeDbus();
    const loadPlugin = vi.fn(async () => false);
    dbus.loadPlugin = loadPlugin;
    const runningKwinVersion = vi.fn(async () => "6.7.3");
    const backend = makeBackend(dbus, {
      readInstallStamp: async () => "kwin_version=kwin 6.7.2\n",
      runningKwinVersion,
    });

    await backend.availability();
    expect(loadPlugin.mock.calls.length).toBeGreaterThan(1);
    expect(runningKwinVersion).toHaveBeenCalledTimes(1);
    await backend.dispose();
  });

  it("decodes capture PNG bytes and degrades state when capture fails", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { captureMaxDimension: 800 });
    await backend.availability();

    const bytes = await backend.captureWindow("window-1");
    expect(bytes).toEqual(PNG_1X1);
    expect(dbus.plugin.calls).toContainEqual({
      method: "captureWindow",
      args: ["window-1", 800],
    });
    await expect(backend.getState({ includeScreenshot: true })).resolves.toMatchObject({
      screenshot: { width: 1, height: 1, mimeType: "image/png" },
    });

    dbus.plugin.captureFailure = new Error("org.synara.ComputerUse.Error.CaptureFailed");
    const degraded = await backend.getState({ includeScreenshot: true });
    expect(degraded.screenshot).toBeUndefined();
    await backend.dispose();
  });

  it("captures the whole workspace and reports the region and scale", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    const backend = makeBackend(dbus);
    await backend.availability();

    const state = await backend.getState({ includeScreenshot: true });
    expect(dbus.plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [0, 0, 5_120, 2_520, 2_048],
    });
    expect(dbus.plugin.calls.some((call) => call.method === "captureWindow")).toBe(false);
    expect(state.screenshot).toMatchObject({
      width: 1,
      height: 1,
      region: { x: 0, y: 0, width: 5_120, height: 2_520 },
      scale: 1 / 5_120,
    });
    await backend.dispose();
  });

  it("falls back to the window bounding box when KWin reports no workspace", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = undefined;
    const backend = makeBackend(dbus);
    await backend.availability();

    const state = await backend.getState({ includeScreenshot: true });
    // The single fake window spans (956, 1519) to (1604, 2037).
    expect(dbus.plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [0, 0, 1_604, 2_037, 2_048],
    });
    expect(state.screenshot?.region).toEqual({ x: 0, y: 0, width: 1_604, height: 2_037 });
    await backend.dispose();
  });

  it("maps a window capture through the window's bounds", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    // The compositor renders at the output's device pixel ratio, so a window
    // capture can come back larger than its logical size.
    dbus.plugin.captureBytes = pngOfSize(1_296, 1_036);
    const backend = makeBackend(dbus);
    await backend.availability();

    // The single fake window is 648x518 logical pixels at (956, 1519).
    await expect(
      backend.captureScreenshot({ kind: "window", windowId: "window-1" }),
    ).resolves.toMatchObject({
      width: 1_296,
      height: 1_036,
      region: { x: 956, y: 1_519, width: 648, height: 518 },
      scale: 2,
    });
    expect(dbus.plugin.calls).toContainEqual({
      method: "captureWindow",
      args: ["window-1", 2_048],
    });
    await backend.dispose();
  });

  it("clips a window capture to the workspace, the way the plugin does", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 1_200, height: 1_800 };
    dbus.plugin.captureBytes = pngOfSize(244, 281);
    const backend = makeBackend(dbus);
    await backend.availability();

    await expect(
      backend.captureScreenshot({ kind: "window", windowId: "window-1", maxDimension: 512 }),
    ).resolves.toMatchObject({
      region: { x: 956, y: 1_519, width: 244, height: 281 },
      scale: 1,
    });
    expect(dbus.plugin.calls).toContainEqual({ method: "captureWindow", args: ["window-1", 512] });
    await backend.dispose();
  });

  it("refuses an unknown window id before spending a capture", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);
    await backend.availability();

    await expect(
      backend.captureScreenshot({ kind: "window", windowId: "window-404" }),
    ).rejects.toThrow('No desktop window has id "window-404"');
    expect(dbus.plugin.calls.some((call) => call.method === "captureWindow")).toBe(false);
    await backend.dispose();
  });

  it("aligns a fractional region and forwards the requested max dimension", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    dbus.plugin.captureBytes = pngOfSize(301, 102);
    const backend = makeBackend(dbus);
    await backend.availability();

    const screenshot = await backend.captureScreenshot({
      kind: "region",
      region: { x: 100.4, y: 200.6, width: 300.2, height: 100.9 },
      maxDimension: 512,
    });
    // D-Bus takes integers, so the rect grows outward instead of cropping.
    expect(dbus.plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [100, 200, 301, 102, 512],
    });
    expect(screenshot).toMatchObject({
      region: { x: 100, y: 200, width: 301, height: 102 },
      scale: 1,
    });
    await backend.dispose();
  });

  it("clips a region to the workspace and reports the clipped mapping", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    dbus.plugin.captureBytes = pngOfSize(150, 125);
    const backend = makeBackend(dbus);
    await backend.availability();

    await expect(
      backend.captureScreenshot({
        kind: "region",
        region: { x: -100, y: -50, width: 400, height: 300 },
      }),
    ).resolves.toMatchObject({
      region: { x: 0, y: 0, width: 300, height: 250 },
      scale: 0.5,
    });
    expect(dbus.plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [0, 0, 300, 250, 2_048],
    });
    await backend.dispose();
  });

  it("refuses a region that misses the workspace entirely", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    const backend = makeBackend(dbus);
    await backend.availability();

    await expect(
      backend.captureScreenshot({
        kind: "region",
        region: { x: 9_000, y: 0, width: 10, height: 10 },
      }),
    ).rejects.toThrow("does not overlap the desktop workspace");
    await expect(
      backend.captureScreenshot({ kind: "region", region: { x: 0, y: 0, width: 0, height: 10 } }),
    ).rejects.toThrow("positive width and height");
    expect(dbus.plugin.calls.some((call) => call.method === "captureRegion")).toBe(false);
    await backend.dispose();
  });

  it("propagates the compositor's capture failure reason to the caller", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    const backend = makeBackend(dbus);
    await backend.availability();
    dbus.plugin.captureFailure = dbusError(
      "org.synara.ComputerUse.Error.CaptureFailed",
      "window not visible",
    );

    await expect(
      backend.captureScreenshot({ kind: "window", windowId: "window-1" }),
    ).rejects.toThrow("window not visible");
    await expect(
      backend.captureScreenshot({ kind: "region", region: { x: 0, y: 0, width: 10, height: 10 } }),
    ).rejects.toThrow("window not visible");
    await backend.dispose();
  });

  it("streams workspace stills to the panel instead of one window", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.workspace = { x: 0, y: 0, width: 5_120, height: 2_520 };
    const backend = makeBackend(dbus);
    await backend.attachStream(() => undefined);

    expect(dbus.plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [0, 0, 5_120, 2_520, 2_048],
    });
    expect(dbus.plugin.calls.some((call) => call.method === "captureWindow")).toBe(false);
    await backend.dispose();
  });

  it("writes an editable control through AT-SPI instead of typing it", async () => {
    const dbus = new FakeDbus();
    const writes: AtspiTextWrite[] = [];
    const backend = makeBackend(dbus, {
      glideDurationMs: 0,
      atspi: {
        readTrees: async () => [],
        setText: async (write) => {
          writes.push(write);
          return true;
        },
        dispose: async () => undefined,
      },
    });
    await backend.availability();

    await expect(backend.setValue(resolvedTarget({ editable: true }), "naïve")).resolves.toEqual({
      point: { x: 1_000, y: 1_600 },
      windowId: "window-1",
      value: "naïve",
    });

    // The write travels with the window KWin reports now, not the one the tree
    // was read from, so the helper re-resolves against live geometry.
    expect(writes).toEqual([
      {
        window: {
          id: "window-1",
          title: "Terminal",
          pid: 123,
          bounds: { x: 956, y: 1_519, width: 648, height: 518 },
          focused: true,
          minimized: false,
          visible: true,
        },
        path: [1, 2],
        text: "naïve",
        role: "entry",
        label: "Name",
      },
    ]);
    // The click still focuses the control, and nothing is typed into it.
    expect(dbus.plugin.calls.some((call) => call.method === "button")).toBe(true);
    expect(dbus.plugin.calls.some((call) => call.method === "key")).toBe(false);
    await backend.dispose();
  });

  it("falls back to typing when the AT-SPI helper fails", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, {
      glideDurationMs: 0,
      atspi: {
        readTrees: async () => [],
        setText: async () => {
          throw new Error("AT-SPI helper exited (code=1, signal=null).");
        },
        dispose: async () => undefined,
      },
    });
    await backend.availability();

    await expect(backend.setValue(resolvedTarget({ editable: true }), "ab")).resolves.toEqual({
      point: { x: 1_000, y: 1_600 },
      windowId: "window-1",
      value: "ab",
    });

    expect(dbus.plugin.calls.filter((call) => call.method === "key")).toHaveLength(4);
    await backend.dispose();
  });

  it("types into a control that exposes no editable-text interface", async () => {
    const dbus = new FakeDbus();
    let writes = 0;
    const backend = makeBackend(dbus, {
      glideDurationMs: 0,
      atspi: {
        readTrees: async () => [],
        setText: async () => {
          writes += 1;
          return true;
        },
        dispose: async () => undefined,
      },
    });
    await backend.availability();

    await backend.setValue(resolvedTarget({ editable: false }), "ab");

    expect(writes).toBe(0);
    expect(dbus.plugin.calls.filter((call) => call.method === "key")).toHaveLength(4);
    await backend.dispose();
  });

  it("reports the clamped landing point when KWin refuses a pointer move", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.clampPointer = (x, y) => ({ x, y: Math.max(y, 1_080) });
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.availability();

    await expect(backend.click({ x: 44, y: 44 })).resolves.toEqual({
      point: { x: 44, y: 44 },
      clampedTo: { x: 44, y: 1_080 },
    });
    await expect(backend.moveCursor({ x: 44, y: 1_080 })).resolves.toEqual({
      point: { x: 44, y: 1_080 },
    });
    await backend.dispose();
  });

  it("omits clamp feedback when the pointer lands on the requested point", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.availability();

    await expect(backend.doubleClick({ x: 300, y: 400 })).resolves.toEqual({
      point: { x: 300, y: 400 },
    });
    await expect(backend.drag({ x: 10, y: 10 }, { x: 20, y: 20 }, 0)).resolves.toEqual({
      point: { x: 20, y: 20 },
    });
    await expect(backend.scroll({ x: 30, y: 30 }, 1, 1)).resolves.toEqual({
      point: { x: 30, y: 30 },
    });
    await backend.dispose();
  });

  it("spends the requested duration on a drag instead of a fixed sleep per step", async () => {
    const dbus = new FakeDbus();
    const clock = fakeClock();
    const callMs = 5;
    const timeline = instrumentPointer(dbus.plugin, clock, callMs);
    const backend = makeBackend(dbus, {
      now: clock.now,
      sleep: clock.sleep,
      // The lead-in move to the drag origin must not contribute any sleeps.
      glideDurationMs: 0,
    });
    await backend.availability();

    await backend.drag({ x: 0, y: 0 }, { x: 200, y: 0 }, 480);

    const pressedAt = timeline.find((entry) => entry.method === "press")?.at;
    const releasedAt = timeline.find((entry) => entry.method === "release")?.at;
    expect(pressedAt).toBeDefined();
    expect(releasedAt! - pressedAt!).toBeCloseTo(480, 6);

    const dragMoves = timeline.filter(
      (entry) => entry.method === "movePointer" && entry.at >= pressedAt!,
    );
    // D-Bus latency comes out of the sleep budget rather than adding to it.
    expect(total(clock.sleeps)).toBeCloseTo(480 - dragMoves.length * callMs, 6);
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(GLIDE_FRAME_INTERVAL_MS);
    await backend.dispose();
  });

  it("issues no sleeps for a zero-duration drag", async () => {
    const dbus = new FakeDbus();
    const clock = fakeClock();
    instrumentPointer(dbus.plugin, clock, 5);
    const backend = makeBackend(dbus, {
      now: clock.now,
      sleep: clock.sleep,
      glideDurationMs: 0,
    });
    await backend.availability();

    await backend.drag({ x: 0, y: 0 }, { x: 200, y: 0 }, 0);

    expect(clock.sleeps).toEqual([]);
    await backend.dispose();
  });

  it("spends the glide duration on a cursor move", async () => {
    const dbus = new FakeDbus();
    const clock = fakeClock();
    const callMs = 4;
    const timeline = instrumentPointer(dbus.plugin, clock, callMs);
    const backend = makeBackend(dbus, { now: clock.now, sleep: clock.sleep, glideDurationMs: 240 });
    await backend.availability();

    const startedAt = clock.now();
    await backend.moveCursor({ x: 400, y: 0 });

    expect(clock.now() - startedAt).toBeCloseTo(240, 6);
    expect(total(clock.sleeps)).toBeCloseTo(240 - timeline.length * callMs, 6);
    await backend.dispose();
  });

  it("stops sleeping when pointer calls are slower than the frame budget", async () => {
    const dbus = new FakeDbus();
    const clock = fakeClock();
    instrumentPointer(dbus.plugin, clock, 40);
    const backend = makeBackend(dbus, { now: clock.now, sleep: clock.sleep, glideDurationMs: 240 });
    await backend.availability();

    await backend.moveCursor({ x: 400, y: 0 });

    // Every deadline is already in the past, so pacing must not pile extra
    // waiting on top of a glide that is already over budget.
    expect(clock.sleeps).toEqual([]);
    await backend.dispose();
  });

  it("serializes window and region captures through one queue", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);
    await backend.availability();

    const gate = deferred<Uint8Array>();
    let active = 0;
    let maximumActive = 0;
    const calls: string[] = [];
    const capture = async (kind: string): Promise<Uint8Array<ArrayBuffer>> => {
      calls.push(kind);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (calls.length === 1) await gate.promise;
        return PNG_1X1;
      } finally {
        active -= 1;
      }
    };
    dbus.plugin.captureWindow = async () => capture("window");
    dbus.plugin.captureRegion = async () => capture("region");

    const first = backend.captureWindow("window-1");
    for (let attempt = 0; attempt < 50 && calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    const second = backend.captureRegion(0, 0, 10, 10);
    await Promise.resolve();
    expect(calls).toEqual(["window"]);
    expect(maximumActive).toBe(1);

    gate.resolve(PNG_1X1);
    await Promise.all([first, second]);
    expect(calls).toEqual(["window", "region"]);
    expect(maximumActive).toBe(1);
    await backend.dispose();
  });

  it("skips still ticks while an agent capture is pending", async () => {
    vi.useFakeTimers();
    try {
      const dbus = new FakeDbus();
      const backend = makeBackend(dbus, { stillIntervalMs: 100 });
      await backend.attachStream(() => undefined);
      const stillCaptures = () =>
        dbus.plugin.calls.filter((call) => call.method === "captureRegion").length;
      expect(stillCaptures()).toBe(1);

      const gate = deferred<Uint8Array<ArrayBuffer>>();
      let captureCalls = 0;
      dbus.plugin.captureWindow = async () => {
        captureCalls += 1;
        if (captureCalls === 1) return await gate.promise;
        return PNG_1X1;
      };
      const agentCapture = backend.captureWindow("window-1");
      for (let attempt = 0; attempt < 10 && captureCalls === 0; attempt += 1) {
        await Promise.resolve();
      }

      await vi.advanceTimersByTimeAsync(500);
      expect(captureCalls).toBe(1);
      expect(stillCaptures()).toBe(1);
      gate.resolve(PNG_1X1);
      await agentCapture;
      await backend.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the D-Bus connection for a method-level capture error", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);
    await backend.availability();
    dbus.plugin.captureFailure = dbusError(
      "org.synara.ComputerUse.Error.CaptureFailed",
      "window is not visible",
    );

    await expect(backend.captureWindow("window-1")).rejects.toThrow("window is not visible");
    expect(dbus.calls.some((call) => call.method === "close")).toBe(false);
    await expect(backend.listWindows()).resolves.toHaveLength(1);
    await backend.dispose();
  });

  it("surfaces plugin stacking and occlusion metadata without trusting its shape", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.windowsJson = async () =>
      JSON.stringify([
        {
          id: "window-top",
          title: "Browser",
          bounds: { x: 0, y: 0, width: 1_600, height: 900 },
          visible: true,
          stackingIndex: 0,
          occludedBy: [],
        },
        {
          id: "window-1",
          title: "Calculator",
          bounds: { x: 100, y: 100, width: 300, height: 400 },
          visible: true,
          stackingIndex: 1,
          occludedBy: ["window-top", 7, ""],
        },
        // A plugin build predating the stacking fields, plus values a corrupt
        // one could emit: the window itself must still list.
        {
          id: "window-legacy",
          title: "Legacy",
          bounds: { x: 1_700, y: 0, width: 200, height: 200 },
          visible: true,
          stackingIndex: -3,
          occludedBy: "not-an-array",
        },
      ]);
    const backend = makeBackend(dbus);

    const windows = await backend.listWindows();
    expect(windows.map((window) => window.id)).toEqual(["window-top", "window-1", "window-legacy"]);
    expect(windows[0]).toMatchObject({ stackingIndex: 0 });
    expect(windows[0]).not.toHaveProperty("occludedBy");
    expect(windows[1]).toMatchObject({ stackingIndex: 1, occludedBy: ["window-top"] });
    expect(windows[2]).not.toHaveProperty("stackingIndex");
    expect(windows[2]).not.toHaveProperty("occludedBy");

    await backend.dispose();
  });

  it("raises a window through the plugin under the same session rules as focus", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);

    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(0);

    await backend.raiseWindow("window-1");
    expect(dbus.plugin.calls).toContainEqual({ method: "raiseWindow", args: ["window-1"] });
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(1);

    // An idle stop the server never asked for is recovered and the call retried.
    dbus.plugin.running = false;
    await backend.raiseWindow("window-1");
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(2);

    // A human takeover is not.
    dbus.plugin.running = false;
    dbus.plugin.releasedByUser = true;
    await expect(backend.raiseWindow("window-1")).rejects.toThrow(/Meta\+Shift\+Esc/);
    expect(dbus.plugin.calls.filter((call) => call.method === "start")).toHaveLength(2);

    await backend.dispose();
  });

  it("skips the restack when the loaded plugin has no raiseWindow", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.raiseWindowFailure = dbusError(
      "org.freedesktop.DBus.Error.UnknownMethod",
      "No such method 'raiseWindow'",
    );
    const backend = makeBackend(dbus);

    await expect(backend.raiseWindow("window-1")).resolves.toBeUndefined();
    expect(dbus.plugin.calls).toContainEqual({ method: "raiseWindow", args: ["window-1"] });

    await backend.dispose();
  });

  it("still surfaces real raiseWindow failures", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.raiseWindowFailure = dbusError(
      "org.synara.ComputerUse.Error.SomethingBroke",
      "restack failed",
    );
    const backend = makeBackend(dbus);

    await expect(backend.raiseWindow("window-1")).rejects.toThrow(/restack failed/);

    await backend.dispose();
  });

  it("uses workspace geometry when KWin reports no windows", async () => {
    const dbus = new FakeDbus();
    dbus.plugin.windows = [];
    dbus.plugin.workspace = { x: 0, y: 0, width: 2_560, height: 1_440 };
    const backend = makeBackend(dbus);

    await backend.availability();
    await expect(backend.getScreenSize()).resolves.toEqual({
      width: 2_560,
      height: 1_440,
      scale: 1,
    });
    await backend.dispose();
  });

  it("rejects launchApp on an asynchronous spawn error", async () => {
    const dbus = new FakeDbus();
    const child = new FakeChild();
    let spawned = false;
    const backend = makeBackend(dbus, {
      spawnProcess: () => {
        spawned = true;
        return child as unknown as ChildProcess;
      },
    });
    await backend.availability();
    await backend.focusWindow("window-1");

    const launch = backend.launchApp("missing-program", []);
    for (let attempt = 0; attempt < 10 && !spawned; attempt += 1) {
      await Promise.resolve();
    }
    expect(spawned).toBe(true);
    expect(child.unref).toHaveBeenCalledTimes(1);
    child.emit("error", new Error("spawn failed: ENOENT"));
    await expect(launch).rejects.toThrow("spawn failed: ENOENT");
    await backend.dispose();
  });

  it("maps eased pointer input, evdev buttons, scroll, text, and hotkeys", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus, { glideDurationMs: 0 });
    await backend.availability();

    await backend.click({ x: 100, y: 100 });
    await backend.rightClick({ x: 110, y: 120 });
    await backend.scroll({ x: 110, y: 120 }, 2, -3);
    await backend.typeText("A!");
    await backend.hotkey(["Ctrl", "a"]);
    await backend.focusWindow("window-1");
    await backend.clearFocusWindow();

    expect(dbus.plugin.calls).toContainEqual({ method: "button", args: [272, true] });
    expect(dbus.plugin.calls).toContainEqual({ method: "button", args: [272, false] });
    expect(dbus.plugin.calls).toContainEqual({ method: "button", args: [273, true] });
    expect(dbus.plugin.calls).toContainEqual({ method: "axis", args: [2, -3] });
    expect(dbus.plugin.calls).toContainEqual({ method: "key", args: [42, true] });
    expect(dbus.plugin.calls).toContainEqual({ method: "key", args: [30, true] });
    expect(dbus.plugin.calls).toContainEqual({ method: "focusWindow", args: ["window-1"] });
    expect(dbus.plugin.calls).toContainEqual({ method: "clearFocusWindow", args: [] });
    await backend.dispose();
  });

  it("clears the old stream timer before attaching a replacement listener", async () => {
    vi.useFakeTimers();
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    try {
      const dbus = new FakeDbus();
      const backend = makeBackend(dbus, { stillIntervalMs: 100 });
      await backend.attachStream(() => undefined);
      const firstTimer = (backend as unknown as { streamTimer: ReturnType<typeof setInterval> })
        .streamTimer;

      await backend.attachStream(() => undefined);
      expect(clearInterval).toHaveBeenCalledWith(firstTimer);
      await backend.dispose();
    } finally {
      clearInterval.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stops an eased pointer glide after disposal", async () => {
    const dbus = new FakeDbus();
    const gate = deferred<undefined>();
    let sleepCalls = 0;
    const backend = makeBackend(dbus, {
      sleep: async () => {
        sleepCalls += 1;
        if (sleepCalls === 1) await gate.promise;
      },
    });
    await backend.availability();
    await backend.focusWindow("window-1");

    const glide = backend.moveCursor({ x: 400, y: 0 });
    for (let attempt = 0; attempt < 10 && sleepCalls === 0; attempt += 1) {
      await Promise.resolve();
    }
    const disposal = backend.dispose();
    gate.resolve(undefined);

    await expect(glide).rejects.toThrow("disposed");
    await disposal;
    expect(dbus.plugin.calls.filter((call) => call.method === "movePointer")).toHaveLength(1);
  });

  it("reconnects through the same supervision seam after a D-Bus disconnect", async () => {
    const dbus = new FakeDbus();
    const backend = makeBackend(dbus);
    await backend.availability();
    dbus.disconnect();
    await expect(backend.availability()).resolves.toMatchObject({ kind: "available" });
    await backend.dispose();
  });
});
