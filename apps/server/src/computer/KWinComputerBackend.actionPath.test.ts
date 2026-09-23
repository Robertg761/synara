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
import { FakeDbus, FakePlugin } from "./computerPluginTestDoubles.ts";
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
