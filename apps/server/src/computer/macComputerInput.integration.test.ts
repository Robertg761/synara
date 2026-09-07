import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MacComputerHelperClient } from "./macComputerHelperClient.ts";

// Explicit opt-in: all injected events address windows owned by this fixture.
const enabled = process.platform === "darwin" && process.env.SYNARA_MAC_INPUT_TEST === "1";
describe.skipIf(!enabled)("macOS input into owned fixture windows", () => {
  let fixture: ChildProcessWithoutNullStreams;
  let helper: MacComputerHelperClient;
  const events: Array<Record<string, unknown>> = [];
  const windows = new Map<string, { id: string; x: number; y: number }>();
  beforeAll(async () => {
    const binary = process.env.SYNARA_MAC_HELPER_BINARY!;
    const fixtureBinary = process.env.SYNARA_MAC_INPUT_FIXTURE!;
    if (!binary || !fixtureBinary) throw new Error("Build and name both test binaries first.");
    fixture = spawn(fixtureBinary, [], { stdio: ["pipe", "pipe", "pipe"] });
    fixture.stderr.resume();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture did not start")), 8_000);
      fixture.once("error", reject);
      createInterface({ input: fixture.stdout }).on("line", (line) => {
        const event = JSON.parse(line);
        events.push(event);
        if (event.ready === true) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    helper = new MacComputerHelperClient({ binaryPath: binary });
    const state = (await helper.request("list-windows")) as {
      windows: Array<{ id: string; pid: number; title: string; bounds: { x: number; y: number } }>;
    };
    for (const name of ["A", "B"]) {
      const window = state.windows.find(
        (candidate) =>
          candidate.title === `Synara Input Fixture ${name}` && candidate.pid === fixture.pid,
      );
      if (!window) throw new Error(`Fixture window ${name} missing`);
      windows.set(name, { id: window.id, x: window.bounds.x + 120, y: window.bounds.y + 120 });
    }
  }, 15_000);
  afterAll(async () => {
    await helper?.dispose();
    if (fixture && fixture.exitCode === null) {
      fixture.stdin.end("quit\n");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          fixture.kill("SIGTERM");
          resolve();
        }, 2_000);
        fixture.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  });

  it("sends real hover events without changing keyboard aim", async () => {
    const a = windows.get("A")!,
      b = windows.get("B")!;
    await helper.request("focus-window", { windowId: a.id });
    await helper.request("move", { windowId: b.id, x: b.x, y: b.y });
    await expect
      .poll(() => events.some((event) => event.event === "move" && event.window === "B"))
      .toBe(true);
    const state = (await helper.request("list-windows")) as { focusedWindowId: string };
    expect(state.focusedWindowId).toBe(a.id);
  });

  it("addresses keyboard RPCs atomically and reports their actual window", async () => {
    const a = windows.get("A")!,
      b = windows.get("B")!;
    await helper.request("focus-window", { windowId: b.id });
    const result = await helper.request("type", { text: "z", windowId: a.id });
    expect(result).toMatchObject({ windowId: a.id });
    await expect
      .poll(
        () =>
          events.some(
            (event) => event.event === "key" && event.window === "A" && event.text === "z",
          ),
        { timeout: 2_000 },
      )
      .toBe(true)
      .catch((error) => {
        console.error("fixture keyboard", result, events);
        throw error;
      });
    expect(events.some((event) => event.event === "key" && event.window === "B")).toBe(false);
  });

  it("cancels a long drag, releases the button, and keeps the helper alive", async () => {
    const a = windows.get("A")!;
    const controller = new AbortController();
    const start = events.length;
    const drag = helper.request(
      "drag",
      { windowId: a.id, fromX: a.x, fromY: a.y, toX: a.x + 100, toY: a.y + 20, durationMs: 30_000 },
      { signal: controller.signal },
    );
    const rejected = expect(drag).rejects.toThrow();
    try {
      await expect
        .poll(() => events.slice(start).some((event) => event.event === "down"), { timeout: 2_000 })
        .toBe(true);
    } finally {
      controller.abort();
      await rejected;
    }
    await expect.poll(() => events.slice(start).some((event) => event.event === "up")).toBe(true);
    expect(helper.running).toBe(true);
    await expect(helper.request("ping")).resolves.toMatchObject({ ok: true });
  }, 10_000);

  it("targets application menu actions through their own accessibility root", async () => {
    const a = windows.get("A")!;
    const tree = (await helper.request("describe-ui", { windowIds: [a.id] })) as {
      root: { children: Array<Record<string, unknown>> };
    };
    const menu = tree.root.children.find((node) => node.accessibilityRoot === "menu-bar");
    expect(menu).toBeDefined();
    const first = (menu!.children as Array<{ nodePath: number[] }>)[0]!;
    await helper.request("perform-action", {
      windowId: a.id,
      nodePath: first.nodePath,
      accessibilityRoot: "menu-bar",
      action: "press",
    });
    const expanded = await helper.request("describe-ui", { windowIds: [a.id] });
    function find(value: unknown): { nodePath: number[] } | undefined {
      if (!value || typeof value !== "object") return undefined;
      const node = value as Record<string, unknown>;
      if (node.label === "Fixture Action") return node as { nodePath: number[] };
      for (const child of Array.isArray(node.children) ? node.children : []) {
        const match = find(child);
        if (match) return match;
      }
      return find(node.root);
    }
    const action = find(expanded);
    expect(action).toBeDefined();
    await helper.request("perform-action", {
      windowId: a.id,
      nodePath: action!.nodePath,
      accessibilityRoot: "menu-bar",
      action: "press",
    });
    await expect.poll(() => events.some((event) => event.event === "menu-action")).toBe(true);
  });

  it("stops foreground typing when the user switches apps without sending keys to that app", async () => {
    const other = spawn(process.env.SYNARA_MAC_INPUT_FIXTURE!, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const otherEvents: Array<Record<string, unknown>> = [];
    other.stderr.resume();
    const lines = createInterface({ input: other.stdout });
    lines.on("line", (line) => otherEvents.push(JSON.parse(line)));
    try {
      await expect
        .poll(() => otherEvents.some((event) => event.ready === true), { timeout: 5_000 })
        .toBe(true);
      const start = events.length;
      const controller = new AbortController();
      const typing = helper.request(
        "type",
        { text: "a".repeat(300), windowId: windows.get("A")!.id, deliveryMode: "foreground" },
        { signal: controller.signal },
      );
      const outcome = typing.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await expect
          .poll(() => events.slice(start).filter((event) => event.event === "key").length)
          .toBeGreaterThan(3);
        other.stdin.write("activate\n");
        expect(await outcome).toBeInstanceOf(Error);
        expect(otherEvents.filter((event) => event.event === "key")).toEqual([]);
      } finally {
        controller.abort();
        await outcome;
      }
    } finally {
      lines.close();
      other.stdin.end("quit\n");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          other.kill("SIGTERM");
          resolve();
        }, 2_000);
        other.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }, 15_000);

  it("refuses unaimed typing after clearing the previous owner", async () => {
    await helper.request("clear-focus-window");
    await expect(helper.request("type", { text: "should not appear" })).rejects.toThrow("aimed");
  });
});
