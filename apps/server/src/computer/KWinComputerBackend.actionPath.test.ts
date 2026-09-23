/**
 * The action and capture path of the shared Linux engine against plugins that
 * do and do not advertise the interface-version-2 features: every newer path
 * has an older plugin's fallback beside it, and both are pinned here.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { KWinComputerBackend, type KWinComputerBackendOptions } from "./KWinComputerBackend.ts";
import type { AtspiTreeReader } from "./atspiClient.ts";
import { FakeDbus, FakePlugin, pngOfSize } from "./computerPluginTestDoubles.ts";
import { withPaneInput } from "./paneInput.ts";

const atspi: AtspiTreeReader = {
  readTrees: async () => [],
  setText: async () => false,
  dispose: async () => undefined,
};

const backends: KWinComputerBackend[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
});

function makeBackend(
  plugin: FakePlugin,
  options: Omit<KWinComputerBackendOptions, "dbus"> = {},
): KWinComputerBackend {
  const dbus = new FakeDbus(plugin);
  dbus.loaded = ["SynaraComputerUsePluginV10"];
  const backend = new KWinComputerBackend({
    clipboardToolsPresent: () => true,
    provisionClipboardTools: async () => {
      throw new Error("Unexpected clipboard installation");
    },
    linuxDistribution: () => ({ id: "arch" }),
    atspi,
    platform: "linux",
    sessionType: "wayland",
    installedPluginIds: async () => ["SynaraComputerUsePluginV10"],
    sleep: async () => undefined,
    resolveApp: (app, args) => ({ command: app, args: [...args], via: "path" }),
    installStampPath: join(tmpdir(), "synara-absent-install.stamp"),
    runningKwinVersion: async () => undefined,
    installedKwinVersion: async () => undefined,
    busNamesHaveOwners: async (names) => names.map(() => false),
    prebuiltRoot: () => undefined,
    buildToolingPresent: () => false,
    provisionPlugin: async () => {
      throw new Error("provisionPlugin was not stubbed in this test");
    },
    ...options,
    dbus,
  });
  backends.push(backend);
  return backend;
}

function callsOf(plugin: FakePlugin, method: string): number {
  return plugin.calls.filter((call) => call.method === method).length;
}

describe("pointer glides", () => {
  it("glides an agent's pointer but sends the pane's straight to the point", async () => {
    const plugin = new FakePlugin();
    const sleeps: number[] = [];
    const backend = makeBackend(plugin, {
      glideDurationMs: 180,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    await backend.moveCursor({ x: 0, y: 0 });
    plugin.calls.length = 0;
    sleeps.length = 0;

    await backend.moveCursor({ x: 100, y: 0 });
    expect(callsOf(plugin, "movePointer")).toBeGreaterThanOrEqual(12);
    expect(sleeps.length).toBeGreaterThan(0);

    plugin.calls.length = 0;
    sleeps.length = 0;
    await withPaneInput(() => backend.moveCursor({ x: 200, y: 0 }));
    expect(callsOf(plugin, "movePointer")).toBeLessThanOrEqual(2);
    expect(sleeps).toEqual([]);
    expect(plugin.position).toEqual({ x: 200, y: 0 });
  });

  it("does not glide to the spot the pointer already occupies", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, { glideDurationMs: 180 });
    await backend.moveCursor({ x: 50, y: 50 });
    plugin.calls.length = 0;

    await backend.click({ x: 50, y: 50 });
    expect(callsOf(plugin, "movePointer")).toBe(1);
  });

  it("carries the pane marker through the manager's queued operation", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, { glideDurationMs: 180 });
    const manager = new (await import("./ComputerManager.ts")).ComputerManager({
      backend,
      actionSettleMs: 0,
    });
    try {
      await backend.availability();
      await backend.moveCursor({ x: 0, y: 0 });
      plugin.calls.length = 0;
      await withPaneInput(() => manager.click(undefined, { x: 400, y: 0 }));
      // 400 px at the 80 px step bound, with no time-driven samples added.
      expect(callsOf(plugin, "movePointer")).toBeLessThanOrEqual(5);
      expect(plugin.position).toEqual({ x: 400, y: 0 });
    } finally {
      await manager.dispose();
    }
  });
});

/** Counts the plugin's window reads, which the double does not record itself. */
function countWindowReads(plugin: FakePlugin): { stateJson: number; windowsJson: number } {
  const counts = { stateJson: 0, windowsJson: 0 };
  const stateJson = plugin.stateJson;
  const windowsJson = plugin.windowsJson;
  plugin.stateJson = async () => {
    counts.stateJson += 1;
    return stateJson();
  };
  plugin.windowsJson = async () => {
    counts.windowsJson += 1;
    return windowsJson();
  };
  return counts;
}

describe("one window snapshot per desktop operation", () => {
  it("serves a click's repeated window reads from one enumeration", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, { glideDurationMs: 0 });
    const manager = new (await import("./ComputerManager.ts")).ComputerManager({
      backend,
      actionSettleMs: 0,
    });
    try {
      await backend.availability();
      const counts = countWindowReads(plugin);
      await manager.withAgentActivity("thread-a", () =>
        manager.click("thread-a", { x: 1_000, y: 1_600, windowId: "window-1" }),
      );
      // Before the snapshot every read paid a stateJson + windowsJson pair.
      expect(counts.windowsJson).toBeLessThanOrEqual(2);
    } finally {
      await manager.dispose();
    }
  });

  it("reads afresh after input, and after the snapshot ages out", async () => {
    const plugin = new FakePlugin();
    let now = 1_000;
    const backend = makeBackend(plugin, { glideDurationMs: 0, now: () => now });
    const { DesktopOperationQueue } = await import("./DesktopOperationQueue.ts");
    const queue = new DesktopOperationQueue();
    await backend.availability();
    const counts = countWindowReads(plugin);
    await queue.run(async () => {
      await backend.listWindows();
      await backend.listWindows();
      expect(counts.windowsJson).toBe(1);
      await backend.click({ x: 10, y: 10 });
      await backend.listWindows();
      expect(counts.windowsJson).toBe(2);
      now += 100;
      await backend.listWindows();
      expect(counts.windowsJson).toBe(3);
    });
    // Outside any operation nothing is cached at all.
    await backend.listWindows();
    await backend.listWindows();
    expect(counts.windowsJson).toBe(5);
  });

  it("uses windowsStateJson in place of the stateJson + windowsJson pair when advertised", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["windowsStateJson"];
    plugin.workspace = { x: -1_920, y: 0, width: 3_840, height: 1_080 };
    const backend = makeBackend(plugin);
    await backend.availability();
    const counts = countWindowReads(plugin);
    const windows = await backend.listWindows();
    expect(counts).toEqual({ stateJson: 0, windowsJson: 0 });
    expect(callsOf(plugin, "windowsStateJson")).toBe(1);
    expect(windows.map((window) => window.id)).toEqual(["window-1"]);
    expect(windows[0]?.focused).toBe(true);
    // Agent space is anchored at the reported workspace origin.
    expect(windows[0]?.bounds).toEqual({ x: 956 + 1_920, y: 1_519, width: 648, height: 518 });

    // A monitor added to the left moves the origin at the next read.
    plugin.workspace = { x: -3_840, y: 0, width: 5_760, height: 1_080 };
    const moved = await backend.listWindows();
    expect(moved[0]?.bounds?.x).toBe(956 + 3_840);
  });

  it("treats the combined document's lock flag as the answer, windows or not", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["windowsStateJson"];
    const backend = makeBackend(plugin);
    await backend.availability();
    // Hyprland keeps listing windows while locked; KWin sends none.
    plugin.windowsStateJson = async () =>
      JSON.stringify({ windows: plugin.windows, targetWindowId: null, locked: true });
    const events: string[] = [];
    backend.onEvent((event) => {
      if (event.type === "desktop-interrupted") events.push(event.pauses.join(","));
    });
    const error = await backend.listWindows().catch((caught: unknown) => caught);
    expect(String(error)).toContain("computer_session_locked");
    expect((error as { inputPause?: unknown }).inputPause).toBeDefined();
    expect(events).toEqual(["screen-lock"]);
  });

  it("keeps the version-1 reads on a plugin that does not advertise the combined document", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin);
    await backend.availability();
    const counts = countWindowReads(plugin);
    await backend.listWindows();
    expect(counts).toEqual({ stateJson: 1, windowsJson: 1 });
    expect(callsOf(plugin, "windowsStateJson")).toBe(0);
  });
});

const PNG_A = pngOfSize(10, 10);
const PNG_B = pngOfSize(10, 11);
const JPEG_BYTES = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);

describe("preview stills", () => {
  it("asks a captureEx plugin for passive JPEG stills at the preview budget", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["captureEx"];
    plugin.captureMime = "image/jpeg";
    plugin.captureBytes = JPEG_BYTES;
    plugin.workspace = { x: 0, y: 0, width: 1_920, height: 1_080 };
    const backend = makeBackend(plugin);
    const frames: { mimeType?: string; data: Uint8Array }[] = [];
    await backend.attachStream((frame) => frames.push(frame));
    expect(plugin.calls).toContainEqual({
      method: "captureRegionEx",
      args: [0, 0, 1_920, 1_080, 1_280, 1 | 2],
    });
    expect(callsOf(plugin, "captureRegion")).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.mimeType).toBe("image/jpeg");
    // The session was never started for watching.
    expect(callsOf(plugin, "start")).toBe(0);
  });

  it("refuses a still whose bytes are not the image they claim to be", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["captureEx"];
    plugin.captureMime = "image/jpeg";
    const backend = makeBackend(plugin);
    const frames: unknown[] = [];
    await backend.attachStream((frame) => frames.push(frame));
    expect(frames).toEqual([]);
  });

  it("keeps PNG stills from captureRegion on a plugin without captureEx", async () => {
    const plugin = new FakePlugin();
    plugin.workspace = { x: 0, y: 0, width: 1_920, height: 1_080 };
    const backend = makeBackend(plugin);
    const frames: { mimeType?: string }[] = [];
    await backend.attachStream((frame) => frames.push(frame));
    expect(plugin.calls).toContainEqual({
      method: "captureRegion",
      args: [0, 0, 1_920, 1_080, 1_280],
    });
    expect(callsOf(plugin, "captureRegionEx")).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.mimeType).toBeUndefined();
  });

  it("slows an idle pane to one still every two seconds and wakes on an action", async () => {
    vi.useFakeTimers({ now: 0 });
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, { now: () => Date.now() });
    await backend.attachStream(() => undefined);
    const captures = () => callsOf(plugin, "captureRegion");
    await vi.advanceTimersByTimeAsync(2_000);
    // 500 ms ticks until four identical stills, then the idle interval.
    expect(captures()).toBe(1 + 4);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(captures()).toBe(1 + 5);

    const { DesktopOperationQueue } = await import("./DesktopOperationQueue.ts");
    await new DesktopOperationQueue().run(() => backend.click({ x: 10, y: 10 }));
    const afterAction = captures();
    await vi.advanceTimersByTimeAsync(600);
    expect(captures()).toBeGreaterThan(afterAction);
  });

  it("holds stills while a desktop operation runs and takes one right after it", async () => {
    vi.useFakeTimers({ now: 0 });
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, { now: () => Date.now() });
    await backend.attachStream(() => undefined);
    const captures = () => callsOf(plugin, "captureRegion");
    const { DesktopOperationQueue } = await import("./DesktopOperationQueue.ts");
    const release = Promise.withResolvers<void>();
    const operation = new DesktopOperationQueue().run(async () => {
      await backend.moveCursor({ x: 10, y: 10 });
      await release.promise;
    });
    await vi.advanceTimersByTimeAsync(0);
    const during = captures();
    await vi.advanceTimersByTimeAsync(900);
    expect(captures()).toBe(during);
    release.resolve();
    await operation;
    await vi.advanceTimersByTimeAsync(60);
    expect(captures()).toBe(during + 1);
  });

  it("lets a still through a long operation once a second", async () => {
    vi.useFakeTimers({ now: 0 });
    const plugin = new FakePlugin();
    let frame = 0;
    // Changing stills, so the idle backoff stays out of the picture.
    plugin.captureRegion = async () => {
      plugin.calls.push({ method: "captureRegion", args: [] });
      frame += 1;
      return frame % 2 === 0 ? PNG_A : PNG_B;
    };
    const backend = makeBackend(plugin, { now: () => Date.now() });
    await backend.attachStream(() => undefined);
    const captures = () => callsOf(plugin, "captureRegion");
    const { DesktopOperationQueue } = await import("./DesktopOperationQueue.ts");
    const release = Promise.withResolvers<void>();
    const operation = new DesktopOperationQueue().run(async () => {
      for (let tick = 0; tick < 30; tick += 1) {
        await backend.listWindows();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await release.promise;
    });
    const before = captures();
    await vi.advanceTimersByTimeAsync(3_000);
    const during = captures() - before;
    expect(during).toBeGreaterThanOrEqual(2);
    expect(during).toBeLessThanOrEqual(4);
    release.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await operation;
  });
});

describe("compositor-observed settle", () => {
  it("is offered only while the loaded plugin advertises waitForSettle", async () => {
    const old = makeBackend(new FakePlugin());
    await old.availability();
    expect(old.waitForSettle).toBeUndefined();

    const plugin = new FakePlugin();
    plugin.features = ["waitForSettle"];
    const backend = makeBackend(plugin);
    expect(backend.waitForSettle).toBeUndefined();
    await backend.availability();
    plugin.settleAnswer = [true, 42];
    await expect(
      backend.waitForSettle!({ windowId: "window-1", quietMs: 100, timeoutMs: 1_500 }),
    ).resolves.toEqual({ settled: true, waitedMs: 42 });
    expect(plugin.calls).toContainEqual({
      method: "waitForSettle",
      args: ["window-1", 100, 1_500],
    });
  });

  it("waits blind for the quiet window when the plugin cannot observe the target", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["waitForSettle"];
    plugin.settleAnswer = [false, 0];
    const sleeps: number[] = [];
    const backend = makeBackend(plugin, {
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    await backend.availability();
    await expect(
      backend.waitForSettle!({ windowId: "gone", quietMs: 100, timeoutMs: 1_500 }),
    ).resolves.toEqual({ settled: false, waitedMs: 100 });
    expect(sleeps).toEqual([100]);
  });

  it("replaces the manager's fixed post-action wait with a short commit-driven one", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["waitForSettle"];
    plugin.settleAnswer = [true, 30];
    const backend = makeBackend(plugin, { glideDurationMs: 0 });
    const manager = new (await import("./ComputerManager.ts")).ComputerManager({ backend });
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      await backend.availability();
      await manager.withAgentActivity("thread-a", async () => {
        await manager.pressKey("thread-a", "enter");
        await manager.captureActionScreenshot("window-1");
      });
      expect(plugin.calls).toContainEqual({
        method: "waitForSettle",
        args: ["window-1", 100, 1_500],
      });
      // No blind 300 ms timer ran beside it.
      expect(timers.mock.calls.some((call) => call[1] === 300)).toBe(false);
    } finally {
      timers.mockRestore();
      await manager.dispose();
    }
  });

  it("keeps the fixed post-action wait on a plugin without waitForSettle", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin, { glideDurationMs: 0 });
    const manager = new (await import("./ComputerManager.ts")).ComputerManager({ backend });
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      await backend.availability();
      await manager.withAgentActivity("thread-a", async () => {
        await manager.pressKey("thread-a", "enter");
        await manager.captureActionScreenshot("window-1");
      });
      expect(callsOf(plugin, "waitForSettle")).toBe(0);
      expect(timers.mock.calls.some((call) => call[1] === 300)).toBe(true);
    } finally {
      timers.mockRestore();
      await manager.dispose();
    }
  });
});

describe("batched typing through keys", () => {
  it("types a word per keys call when the plugin advertises it", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["keys"];
    const backend = makeBackend(plugin);
    await backend.availability();
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(4).slice(0, 180);
    await expect(backend.typeText(text)).resolves.toEqual({ value: text });
    expect(callsOf(plugin, "key")).toBe(0);
    const batches = plugin.calls
      .filter((call) => call.method === "keys")
      .map((call) => call.args[0] as readonly (readonly [number, boolean])[]);
    // One call per word, where single keys took 2-4 calls a character.
    expect(batches.length).toBe(text.split(" ").filter(Boolean).length);
    expect(batches.every((batch) => batch.length <= 32)).toBe(true);
    const presses = batches.flat().filter(([, pressed]) => pressed).length;
    expect(presses).toBeGreaterThanOrEqual(text.length);
  });

  it("reports the partial result and releases what a cut-short batch left held", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["keys"];
    const backend = makeBackend(plugin);
    await backend.availability();
    let call = 0;
    plugin.keys = async (strokes) => {
      plugin.calls.push({ method: "keys", args: [strokes] });
      call += 1;
      // "hello " lands; "World" stops after W's Shift and press.
      return call === 1 ? strokes.length : 2;
    };
    const error = await backend.typeText("hello World").catch((caught: unknown) => caught);
    expect(String(error)).toContain("Typing stopped after 6 of 11 characters");
    expect(String(error)).toContain('"hello "');
    // W's key, then Shift, released one by one.
    const releases = plugin.calls
      .filter((entry) => entry.method === "key")
      .map((entry) => entry.args);
    expect(releases).toEqual([
      [17, false],
      [42, false],
    ]);
  });

  it("throws the plugin's own refusal when nothing was typed", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["keys"];
    const refusal = Object.assign(new Error("human is typing"), {
      type: "org.synara.ComputerUse.Error.HumanActive",
    });
    plugin.inputFailure = { method: "keys", error: refusal };
    const backend = makeBackend(plugin);
    await backend.availability();
    const error = await backend.typeText("abc").catch((caught: unknown) => caught);
    expect(String(error)).toContain("computer_human_active");
    expect(String(error)).not.toContain("Typing stopped");
  });

  it("restarts a session that stopped under it and resends the batch once", async () => {
    const plugin = new FakePlugin();
    plugin.features = ["keys"];
    const backend = makeBackend(plugin);
    await backend.availability();
    await backend.moveCursor({ x: 1, y: 1 });
    // The idle deadline expired between two actions.
    plugin.running = false;
    await expect(backend.typeText("ok")).resolves.toEqual({ value: "ok" });
    expect(callsOf(plugin, "start")).toBe(2);
    expect(callsOf(plugin, "keys")).toBe(2);
  });

  it("keeps single key calls on a plugin without keys", async () => {
    const plugin = new FakePlugin();
    const backend = makeBackend(plugin);
    await backend.availability();
    await backend.typeText("Hi");
    expect(callsOf(plugin, "keys")).toBe(0);
    expect(callsOf(plugin, "key")).toBe(6);
  });
});
