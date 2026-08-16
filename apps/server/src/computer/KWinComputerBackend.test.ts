import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import type { ComputerWindow } from "@synara/contracts";

import {
  KWinComputerBackend,
  newestPluginId,
  type KWinComputerBackendOptions,
} from "./KWinComputerBackend.ts";
import type { AtspiTreeReader } from "./atspiClient.ts";
import type { KWinComputerDbus, KWinComputerPluginApi } from "./kwinDbus.ts";

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

class FakePlugin implements KWinComputerPluginApi {
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
  capture = true;
  running = false;
  workspace:
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined;
  captureFailure: Error | undefined;
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
      kwinVersion: "6.7.3",
      ...(this.workspace ? { workspaceGeometry: this.workspace } : {}),
    });
  stateJson = async () => JSON.stringify({ position: this.position, targetWindowId: "window-1" });
  windowsJson = async () => JSON.stringify(this.windows);
  start = async () => {
    this.running = true;
    return this.recordResult("start");
  };
  stop = async () => {
    this.running = false;
    return this.recordResult("stop");
  };
  focusWindow = async (windowId: string) => this.recordResult("focusWindow", windowId);
  clearFocusWindow = async () => this.recordResult("clearFocusWindow");
  movePointer = async (x: number, y: number) => {
    this.position = this.clampPointer?.(x, y) ?? { x, y };
    return this.recordResult("movePointer", x, y);
  };
  button = async (code: number, pressed: boolean) => this.recordResult("button", code, pressed);
  axis = async (horizontal: number, vertical: number) =>
    this.recordResult("axis", horizontal, vertical);
  key = async (code: number, pressed: boolean) => this.recordResult("key", code, pressed);
  captureWindow = async (windowId: string, maxDimension: number) => {
    this.calls.push({ method: "captureWindow", args: [windowId, maxDimension] });
    if (this.captureFailure) throw this.captureFailure;
    return this.capture ? PNG_1X1 : Uint8Array.of();
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
    return this.capture ? PNG_1X1 : Uint8Array.of();
  };

  private recordResult(method: string, ...args: readonly unknown[]): true {
    this.calls.push({ method, args });
    return true;
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
  dispose: async () => undefined,
};

function makeBackend(
  dbus: FakeDbus,
  options: Omit<KWinComputerBackendOptions, "dbus" | "atspi"> = {},
): KWinComputerBackend {
  return new KWinComputerBackend({
    ...options,
    dbus,
    atspi,
    platform: "linux",
    sessionType: "wayland",
    installedPluginIds:
      options.installedPluginIds ??
      (async () => ["SynaraComputerUsePluginV2", "SynaraComputerUsePluginV10"]),
    sleep: options.sleep ?? (async () => undefined),
  });
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
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

    await expect(backend.availability()).resolves.toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("No installed SynaraComputerUsePluginVn"),
    });
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
    for (let attempt = 0; attempt < 10 && calls.length === 0; attempt += 1) {
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
