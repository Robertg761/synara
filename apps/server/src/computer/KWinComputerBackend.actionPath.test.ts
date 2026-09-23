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
